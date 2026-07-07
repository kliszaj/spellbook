import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { mkdir, readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
// Saved-card snapshots (full Scryfall card objects + translate cache) easily
// exceed body-parser's 100 KB default, so raise the JSON body limit.
app.use(express.json({ limit: "25mb" }));
app.use(express.static(join(__dirname, "public")));

const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const STATE_FILE = join(DATA_DIR, "state.json");
const DEFAULT_APP_STATE = {
  savedCards: [],
  folders: [],
  membership: null,
  colorIdentity: [],
  translateCache: {},
  searchHistory: [],
  apiKey: "",
  forceAiSearch: false,
};
const COLOR_IDS = new Set(["w", "u", "b", "r", "g"]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeAppState(value = {}) {
  const input = plainObject(value) || {};
  return {
    savedCards: Array.isArray(input.savedCards) ? input.savedCards : [],
    folders: Array.isArray(input.folders) ? input.folders : [],
    membership: plainObject(input.membership),
    colorIdentity: Array.isArray(input.colorIdentity) ? input.colorIdentity.filter((c) => COLOR_IDS.has(c)) : [],
    translateCache: plainObject(input.translateCache) || {},
    searchHistory: Array.isArray(input.searchHistory) ? input.searchHistory : [],
    apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
    forceAiSearch: Boolean(input.forceAiSearch),
  };
}

function publicAppState(state) {
  const { apiKey, ...rest } = state;
  return rest;
}

async function readAppState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return normalizeAppState({ ...DEFAULT_APP_STATE, ...JSON.parse(raw) });
  } catch (err) {
    if (err.code === "ENOENT") return { ...DEFAULT_APP_STATE };
    throw err;
  }
}

async function writeAppState(nextState) {
  await mkdir(DATA_DIR, { recursive: true });
  const state = normalizeAppState({ ...DEFAULT_APP_STATE, ...nextState });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

// Serialize all state mutations so concurrent requests from multiple devices
// can't interleave read-modify-write and lose each other's updates.
let stateWriteChain = Promise.resolve();
function withStateLock(fn) {
  const run = stateWriteChain.then(fn, fn);
  stateWriteChain = run.then(() => {}, () => {});
  return run;
}

const DEFAULT_FOLDER = "default";

// ── Server-side merge (union) — used only for the one-time client migration push ──
function mergeById(a = [], b = []) {
  const m = new Map();
  [...(a || []), ...(b || [])].forEach((it) => {
    if (it && it.id) m.set(it.id, { ...m.get(it.id), ...it });
  });
  return [...m.values()];
}

function mergeMembership(a, b) {
  const merged = {};
  [a, b].forEach((src) => {
    if (!src || typeof src !== "object") return;
    for (const [cid, folders] of Object.entries(src)) {
      const next = new Set(merged[cid] || []);
      (Array.isArray(folders) ? folders : []).forEach((f) => next.add(f));
      merged[cid] = [...next];
    }
  });
  return Object.keys(merged).length ? merged : null;
}

function mergeTranslateCache(a = {}, b = {}) {
  const merged = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (!merged[k] || (v?.ts || 0) > (merged[k]?.ts || 0)) merged[k] = v;
  }
  return merged;
}

function mergeSearchHistory(a = [], b = []) {
  const m = new Map();
  [...(a || []), ...(b || [])].forEach((it) => {
    if (!it || !it.q) return;
    const key = `${it.forceAi ? "ai" : "query"}|${it.ci || ""}|${String(it.q).trim().toLowerCase()}`;
    if (!m.has(key) || (it.ts || 0) > (m.get(key).ts || 0)) m.set(key, it);
  });
  return [...m.values()].sort((x, y) => (y.ts || 0) - (x.ts || 0));
}

function mergeStates(base, incoming) {
  return normalizeAppState({
    savedCards: mergeById(base.savedCards, incoming.savedCards),
    folders: mergeById(base.folders, incoming.folders),
    membership: mergeMembership(base.membership, incoming.membership),
    colorIdentity: Array.isArray(incoming.colorIdentity) && incoming.colorIdentity.length ? incoming.colorIdentity : base.colorIdentity,
    translateCache: mergeTranslateCache(base.translateCache, incoming.translateCache),
    searchHistory: mergeSearchHistory(base.searchHistory, incoming.searchHistory),
    forceAiSearch: typeof incoming.forceAiSearch === "boolean" ? incoming.forceAiSearch : base.forceAiSearch,
    apiKey: base.apiKey,
  });
}

// ── Authoritative op reducer — the server is the single source of truth ──
// Clients send precise ops (never full snapshots) so deletes win and concurrent
// edits from different devices don't clobber each other.
function applyOps(state, ops) {
  state.membership = state.membership && typeof state.membership === "object" ? state.membership : {};
  for (const op of Array.isArray(ops) ? ops : []) {
    switch (op?.type) {
      case "moveCard": {
        // folders empty/absent => unsave the card everywhere; otherwise upsert + set membership.
        const id = op.id;
        if (!id) break;
        const folders = Array.isArray(op.folders) ? op.folders.filter(Boolean) : [];
        if (!folders.length) {
          state.savedCards = state.savedCards.filter((c) => c.id !== id);
          delete state.membership[id];
        } else {
          const card = op.card && op.card.id === id ? op.card : null;
          const idx = state.savedCards.findIndex((c) => c.id === id);
          if (idx >= 0) { if (card) state.savedCards[idx] = card; }
          else if (card) state.savedCards.push(card);
          state.membership[id] = folders;
        }
        break;
      }
      case "unsaveCard": {
        if (!op.id) break;
        state.savedCards = state.savedCards.filter((c) => c.id !== op.id);
        delete state.membership[op.id];
        break;
      }
      case "setFolders":
        if (Array.isArray(op.folders)) state.folders = op.folders;
        break;
      case "replaceMembership":
        if (op.membership && typeof op.membership === "object") state.membership = op.membership;
        break;
      case "setSettings":
        if (Array.isArray(op.colorIdentity)) state.colorIdentity = op.colorIdentity.filter((c) => COLOR_IDS.has(c));
        if (typeof op.forceAiSearch === "boolean") state.forceAiSearch = op.forceAiSearch;
        break;
      case "setCaches":
        if (op.translateCache && typeof op.translateCache === "object") state.translateCache = op.translateCache;
        if (Array.isArray(op.searchHistory)) state.searchHistory = op.searchHistory;
        break;
      case "mergeSnapshot":
        // One-time migration: fold a device's pre-existing local state into the shared doc.
        if (op.state && typeof op.state === "object") state = mergeStates(state, op.state);
        break;
    }
  }
  return state;
}


const SCRYFALL_SYSTEM_PROMPT = `You are a Magic: The Gathering search assistant that translates natural language requests into Scryfall search queries.

## Scryfall Search Syntax Reference

### Boolean Logic
- All terms are ANDed by default
- "or" / "OR" between terms for disjunction: t:fish or t:bird
- Parentheses for grouping: t:legendary (t:goblin or t:elf)
- "-" prefix negates any keyword: -c:red, -t:creature
- "not:" is the inverse of "is:": not:reprint = -is:reprint

### Colors (c: / color:) and Color Identity (id: / identity:)
Single: w (white), u (blue), b (black), r (red), g (green), c (colorless), m (multicolor)
Guilds: azorius (WU), dimir (UB), rakdos (BR), gruul (RG), selesnya (GW), orzhov (WB), izzet (UR), golgari (BG), boros (RW), simic (GU)
Shards: bant (GWU), esper (WUB), grixis (UBR), jund (BRG), naya (RGW)
Wedges: abzan (WBG), jeskai (URW), sultai (BGU), mardu (RWB), temur (GUR)
Operators: =, !=, <, >, <=, >=
  c:rg = at least red AND green. c<=rg = at most red and green.
  c=2 = exactly two colors (numeric). id<=esper = identity within Esper.

### Card Types (t: / type:)
Supertypes: basic, legendary, snow, token, world
Card types: artifact, creature, enchantment, instant, land, planeswalker, sorcery, battle, kindred
Subtypes: all creature types (elf, goblin, dragon, human, zombie, etc.), equipment, aura, vehicle, saga, etc.

### Card Text
o: / oracle: — oracle text (no reminder text). Use quotes for phrases: o:"draw a card"
fo: / fulloracle: — full oracle text including reminder text
keyword: / kw: — keyword abilities: keyword:flying, keyword:trample
~ = placeholder for the card's own name: o:"~ enters tapped"
Regex: o:/^{T}:/ — regex in oracle text

### Mana Cost & Mana Value
m: / mana: — mana cost symbols. m:2WW, m:{R/P} (Phyrexian), m:{2/G} (hybrid)
mv / manavalue — mana value (CMC): mv=3, mv>=5, mv<=2, manavalue:even, manavalue:odd
devotion: — devotion contribution
produces: — mana production: produces=wu

### Power, Toughness, Loyalty
pow / power, tou / toughness — pow>=4, tou<=2, pow>tou (cross-compare)
pt / powtou — total P+T
loy / loyalty — starting loyalty: loy=3

### Rarity (r: / rarity:)
common (c), uncommon (u), rare (r), mythic (m), special (s), bonus (b)
Comparison operators work: r>=r = rare or mythic

### Sets, Blocks, Dates
s: / e: / set: — set code: e:dom
b: / block: — block code
cn: / number: — collector number
st: — set type: st:masters, st:commander, st:expansion, st:core
year — year:2023. date — date>=2024-01-01
in: — ever appeared in: in:lea in:m15

### Format Legality (f: / format:)
standard, future, historic, timeless, pioneer, modern, legacy, pauper, vintage, penny, commander, oathbreaker, brawl, paupercommander, duel, oldschool, premodern
banned: / restricted: — banned:legacy, restricted:vintage

### Prices (EUR for Cardmarket)
eur, usd, tix — numeric: eur>=1, eur<=10, eur>0
cheapest:eur — cheapest EUR printing
order:eur direction:asc — sort by EUR price

### Artist, Flavor, Watermark
a: / artist: — artist name. ft: / flavor: — flavor text. wm: / watermark:

### Land Cycle Shortcuts
is:fetchland, is:shockland, is:dual, is:checkland, is:fastland, is:painland,
is:scryland, is:bounceland, is:triome, is:pathway, is:manland, etc.

### Boolean Properties (is: / not: / has:)
is:commander, is:companion, is:partner, is:spell, is:permanent, is:historic,
is:modal, is:vanilla, is:frenchvanilla, is:bear, is:split, is:transform,
is:mdfc, is:dfc, is:meld, is:foil, is:nonfoil, is:fullart, is:borderless,
is:extended, is:showcase, is:reprint, is:reserved, is:funny, is:promo,
is:digital, is:hires, is:hybrid, is:phyrexian, is:universesbeyond
new:art, new:flavor, new:frame, new:rarity
has:watermark, has:indicator

### Display / Sorting
unique:cards (default), unique:prints, unique:art
order:name, order:released, order:set, order:rarity, order:color, order:cmc,
order:power, order:toughness, order:eur, order:usd, order:edhrec, order:penny
direction:asc, direction:desc
prefer:newest, prefer:oldest, prefer:usd-low, prefer:eur-low

### Other
edhrecrank — EDHREC popularity: edhrecrank<=100
game:paper, game:arena, game:mtgo
cube:vintage, cube:modern, cube:legacy
art: / atag: — art tags: art:squirrel
function: / otag: — oracle tags: function:removal
prints, sets, paperprints, papersets — reprint counts: prints=1
lang: — language: lang:ja, lang:any
include:extras — show hidden card types (tokens, planes, etc.)

## Context
This assistant is specifically for Commander/EDH deckbuilding. Every query MUST include:
- f:commander — only Commander-legal cards
- game:paper — paper cards only

The user will provide their commander's color identity (e.g. "rg" for Gruul). You MUST restrict every query to that color identity using id<= so only cards with a matching subset of that identity appear. For example:
- Commander identity "rg" → add id<=rg (shows mono-red, mono-green, red-green, and colorless cards)
- Commander identity "wub" → add id<=wub (shows mono-white, mono-blue, mono-black, any combo of those, and colorless)
- Commander identity "wubrg" → add id<=wubrg (all cards)
- Commander identity "c" → add id<=c (colorless only)

If no color identity is provided, do NOT add an id<= filter — just use f:commander.

## Translation Instructions
1. Translate the user's natural language into a valid Scryfall query string.
2. ALWAYS include f:commander and game:paper.
3. ALWAYS include id<=IDENTITY using the user's commander color identity if provided.
4. Use keyword: for keyword abilities (flying, trample, haste, lifelink, deathtouch, vigilance, reach, first strike, double strike, hexproof, indestructible, menace, flash, defender, ward, etc.)
5. Use o:"text" for ability descriptions that aren't simple keywords (e.g. "grant flying to creatures" → o:"creatures you control" o:"flying" or o:"gain flying" or o:"have flying").
6. For "grant/give an ability to creatures", search oracle text for phrases like "creatures you control have/get/gain" — use o: with relevant phrases.
7. When the user mentions colors in the context of what a card DOES (e.g. "red burn spell"), use c: for the card's color. The id<= filter handles identity legality separately.
8. Use eur filters for price ranges (the user buys from Cardmarket in Europe).
9. Add order:eur direction:asc when price is mentioned and no other sort is implied.
10. When the user says "cheap", default to eur<=2 unless they specify a price.
11. When the user asks for "budget" cards, use eur<=5.
12. Prefer specificity: use keyword:flying over o:"flying" when the user means the keyword.

## Two kinds of request — choose the right response

EVERY request arrives here. You decide how to answer:

A) ATTRIBUTE SEARCH — the user wants to find/browse cards by properties Scryfall can filter
   (color, type, mana value, power/toughness, keywords, oracle text, price, set, rarity, etc.).
   Examples: "blue counterspells under €2", "creatures with flying and trample",
   "red removal that exiles", "artifacts that tap for mana".
   → Respond with a SINGLE Scryfall query string and nothing else — no explanation, no markdown,
     no quotes, no backticks. Do NOT use any tools. Example: t:creature keyword:trample f:commander id<=rg game:paper

B) RECOMMENDATION / SEMANTIC — the user wants a curated, ranked, or deck/commander-specific set,
   or something that depends on knowledge Scryfall cannot filter: precon upgrade lists, "best/top
   cards for <commander/archetype>", combos ("cards that combo with X"), budget alternatives or
   replacements for a named card, "what should I add/cut", staples for a deck, meta/tier questions.
   Examples: "top upgrades for the Bello animated army precon", "best cards for an Atraxa
   superfriends deck", "cards that combo with Kiki-Jiki Mirror Breaker", "cheaper alternatives to
   Mana Drain", "good board wipes for my Edgar Markov deck".
   → Use the web_search tool when it would improve accuracy (precon contents, current meta), then
     call the recommend_cards tool with up to ~30 SPECIFIC, REAL Magic card names, each with a
     one-line reason, plus a short summary. Respect the commander color identity if provided, or
     infer it from a named precon/commander. Do NOT also emit a query string in this case.

GREY ZONE: if it's a plain attribute filter, prefer the query (A). If it asks for a curated/ranked
or deck-specific recommendation, use recommend_cards (B). When in doubt for "best <attribute>"
phrasing, lean to a query unless a specific deck/commander/precon is named.`;

const RECOMMEND_TOOL = {
  name: "recommend_cards",
  description:
    "Provide a curated list of specific, real Magic: The Gathering cards in response to a recommendation, deckbuilding, or semantic request (e.g. precon upgrades, best cards for a commander/archetype, combos, budget alternatives). Use this INSTEAD of a Scryfall query for those requests.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "One or two sentences framing the recommendations for the user.",
      },
      cards: {
        type: "array",
        description: "Recommended cards in ranked order (most recommended first), up to 30.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Exact Magic card name as printed (used to look the card up on Scryfall)." },
            reason: { type: "string", description: "One short line on why this card is recommended." },
          },
          required: ["name", "reason"],
        },
      },
    },
    required: ["summary", "cards"],
  },
};

const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 5 };

const SCRYFALL_OPERATORS = /\b(f:|t:|o:|c:|id[<>=]|keyword:|kw:|m:|mv[<>=]|pow[<>=]|tou[<>=]|r:|s:|e:|game:|is:|not:|order:|eur[<>=]|has:|produces:)/;

function extractQuery(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const queryLines = lines.filter((l) => SCRYFALL_OPERATORS.test(l));
  if (queryLines.length > 0) return queryLines[queryLines.length - 1];
  return text;
}

// Deterministically guarantee the mandatory Commander filters, so color identity
// (and f:commander / game:paper) never depend on the model remembering them.
// Idempotent: only adds a clause the query is missing.
function enforceCommanderFilters(query, colorIdentity) {
  let q = (query || "").trim();
  if (!/\bf(?:ormat)?:commander\b/i.test(q)) q += " f:commander";
  if (!/\bgame:paper\b/i.test(q)) q += " game:paper";
  const id = typeof colorIdentity === "string" ? colorIdentity.trim().toLowerCase() : "";
  if (id && !/\b(?:id|identity)\s*[<>=:]/i.test(q)) q += ` id<=${id}`;
  return q.replace(/\s{2,}/g, " ").trim();
}

app.get("/api/app-state", async (req, res) => {
  try {
    res.json(publicAppState(await readAppState()));
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to read app state" });
  }
});

// Legacy snapshot endpoint — now a server-side union merge (never a blind
// overwrite) so a stale device can't clobber another's saves. The client only
// calls this once, to migrate its local-only data up on first load.
app.put("/api/app-state", async (req, res) => {
  try {
    const nextState = await withStateLock(async () => {
      const current = await readAppState();
      const merged = mergeStates(current, normalizeAppState(req.body || {}));
      return writeAppState(merged);
    });
    res.json(publicAppState(nextState));
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to save app state" });
  }
});

// Authoritative mutation channel: apply precise ops to the shared state.json.
app.post("/api/app-state/ops", async (req, res) => {
  try {
    const nextState = await withStateLock(async () => {
      const current = await readAppState();
      const updated = applyOps(current, req.body?.ops);
      return writeAppState({ ...updated, apiKey: current.apiKey });
    });
    res.json(publicAppState(nextState));
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to apply ops" });
  }
});

app.get("/api/settings", async (req, res) => {
  try {
    const state = await readAppState();
    const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY || state.apiKey);
    res.json({ hasApiKey, source: process.env.ANTHROPIC_API_KEY ? "environment" : (state.apiKey ? "appdata" : "none") });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to read settings" });
  }
});

app.put("/api/settings", async (req, res) => {
  try {
    const apiKey = String(req.body?.apiKey || "").trim();
    if (!apiKey) return res.status(400).json({ error: "Missing API key" });
    const state = await readAppState();
    await writeAppState({ ...state, apiKey });
    res.json({ hasApiKey: true, source: process.env.ANTHROPIC_API_KEY ? "environment" : "appdata" });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to save settings" });
  }
});

app.post("/api/translate", async (req, res) => {
  const { query, colorIdentity, forceAiSearch } = req.body;
  const appState = await readAppState();
  const apiKey = process.env.ANTHROPIC_API_KEY || appState.apiKey || req.body.apiKey;
  if (!query || !apiKey) {
    return res.status(400).json({ error: "Missing query or API key" });
  }

  let userMessage = query;
  if (colorIdentity) {
    userMessage = `[Commander color identity: ${colorIdentity}]\n${query}`;
  }
  if (forceAiSearch) {
    userMessage = `[Force AI web search recommendations: true]
Use the semantic recommendation path even if this could be translated into a Scryfall query. Use web_search first when it can improve accuracy, then call recommend_cards with specific real card names. Do not return a plain Scryfall query.
${userMessage}`;
  }

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-sonnet-4-6", // bump to an Opus model for stronger deckbuilding recommendations
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      system: SCRYFALL_SYSTEM_PROMPT,
      tools: [RECOMMEND_TOOL, WEB_SEARCH_TOOL],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: userMessage }],
    });

    // Recommendation path: the model called recommend_cards with a curated list.
    const rec = message.content.find((b) => b.type === "tool_use" && b.name === "recommend_cards");
    if (rec) {
      const cards = Array.isArray(rec.input?.cards)
        ? rec.input.cards.filter((c) => c && c.name).map((c) => ({ name: String(c.name), reason: String(c.reason || "") }))
        : [];
      return res.json({ type: "cards", summary: String(rec.input?.summary || ""), cards });
    }

    // Search path: the model returned a Scryfall query string as text.
    const textBlock = message.content.find((b) => b.type === "text");
    const scryfallQuery = enforceCommanderFilters(extractQuery((textBlock?.text || "").trim()), colorIdentity);
    res.json({ type: "query", query: scryfallQuery, scryfallQuery });
  } catch (err) {
    const status = err.status || 500;
    let errorMsg = "Failed to translate query";
    if (err.status === 401) errorMsg = "Invalid API key. Check your key in Settings.";
    else if (err.status === 404) errorMsg = "Model not found. Your API plan may not have access to this model.";
    else if (err.status === 429) errorMsg = "Rate limited. Wait a moment and try again.";
    else if (err.message) errorMsg = err.message;
    res.status(status).json({ error: errorMsg });
  }
});

const DECK_REVIEW_PROMPT = `You are a Magic: The Gathering Commander (EDH) deck reviewer. You will be given a deck's cards (name, type, mana value, oracle text). Count how many cards fill each role, judging by function (not just keywords); a card may count in more than one role.

Roles and healthy Commander targets (context only):
- ramp: mana acceleration, mana rocks/dorks, extra lands (target 8-12)
- draw: repeatable or net-positive card advantage (target 10+)
- removal: single-target removal — destroy/exile/bounce/-X/fight (target 6-10)
- wipes: board wipes / mass removal (target 3-5)
- tutors: search library for a specific card (target 2-8)
- interaction: instant-speed interaction incl. counterspells (target 8+)
- graveyardHate: graveyard exile/disruption (target 1+)
- protection: protect your board/commander — hexproof, indestructible, counters, protective equipment (target 3+)

Respond with ONLY minified JSON, no prose or code fences:
{"counts":{"ramp":N,"draw":N,"removal":N,"wipes":N,"tutors":N,"interaction":N,"graveyardHate":N,"protection":N},"notes":["...","..."]}
Notes: 2-4 brief, specific suggestions comparing the deck to the targets (e.g. "Light on ramp (6 vs 8-10) — add a couple of 2-mana rocks."). Each under 120 chars.`;

app.post("/api/deck-review", async (req, res) => {
  const appState = await readAppState();
  const apiKey = process.env.ANTHROPIC_API_KEY || appState.apiKey || req.body?.apiKey;
  const cards = Array.isArray(req.body?.cards) ? req.body.cards.slice(0, 130) : [];
  if (!cards.length || !apiKey) return res.status(400).json({ error: "Missing cards or API key" });
  try {
    const list = cards
      .map((c) => `- ${c.name} [${c.type_line || ""}] (MV ${c.cmc ?? 0}) :: ${String(c.oracle_text || "").replace(/\s+/g, " ").slice(0, 240)}`)
      .join("\n");
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: DECK_REVIEW_PROMPT,
      messages: [{ role: "user", content: `Classify this Commander deck and return the JSON.\n\n${list}` }],
    });
    const text = message.content.find((b) => b.type === "text")?.text || "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : {};
    res.json({
      counts: parsed.counts && typeof parsed.counts === "object" ? parsed.counts : {},
      notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 4).map(String) : [],
    });
  } catch (err) {
    const status = err.status || 500;
    let msg = err.message || "Deck review failed";
    if (err.status === 401) msg = "Invalid API key. Check your key in Settings.";
    else if (err.status === 429) msg = "Rate limited. Wait a moment and try again.";
    res.status(status).json({ error: msg });
  }
});

// ── Commander Spellbook combos proxy ──────────────────────────────
// Public API (no auth). Cached in memory since combo data changes slowly.
const COMBO_CACHE_TTL = 1000 * 60 * 60 * 24; // 24h
const comboCache = new Map(); // normalized commander name -> { ts, data }

function trimCombo(variant) {
  return {
    id: variant.id,
    url: `https://commanderspellbook.com/combo/${variant.id}/`,
    popularity: typeof variant.popularity === "number" ? variant.popularity : 0,
    cards: (Array.isArray(variant.uses) ? variant.uses : [])
      .map((u) => (u && u.card ? { name: String(u.card.name || ""), oracleId: u.card.oracleId || null } : null))
      .filter((c) => c && c.name),
    produces: (Array.isArray(variant.produces) ? variant.produces : [])
      .map((p) => (p && p.feature ? String(p.feature.name || "") : ""))
      .filter(Boolean),
    steps: String(variant.description || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    notes: String(variant.notes || "").trim(),
  };
}

const COMBO_PAGE = 5;

app.get("/api/combos", async (req, res) => {
  const commander = String(req.query.commander || "").trim();
  if (!commander) return res.status(400).json({ error: "Missing commander" });
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const key = `${commander.toLowerCase()}|${offset}`;

  const cached = comboCache.get(key);
  if (cached && Date.now() - cached.ts < COMBO_CACHE_TTL) return res.json(cached.data);

  try {
    // `card:` (not `commander:`) — the latter only matches combos that require the
    // card in the command zone, which is empty for most commanders. `card:` returns
    // every combo the card takes part in, which is what "combos for my commander" means.
    const q = `card:"${commander}"`;
    const url = `https://backend.commanderspellbook.com/variants/?q=${encodeURIComponent(q)}&ordering=-popularity&limit=${COMBO_PAGE}&offset=${offset}`;
    const upstream = await fetch(url, { headers: { Accept: "application/json" } });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const json = await upstream.json();
    const combos = (Array.isArray(json.results) ? json.results : []).slice(0, COMBO_PAGE).map(trimCombo);
    const data = { commander, combos, hasMore: Boolean(json.next) };
    if (combos.length) comboCache.set(key, { ts: Date.now(), data }); // don't cache empty answers
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Couldn't reach Commander Spellbook" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
