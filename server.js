import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { callOpenAIJsonRaw, parseJsonObject, createAiClient } from "./lib/ai-client.js";
import { mkdir, readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mergeDeckNotes, normalizeDeckNotes } from "./lib/deck-notes.js";
import { createCollectionStore, PreviewExpiredError, PreviewStaleError, ScryfallError } from "./lib/collection-store.js";
import { CollectionFormatError } from "./lib/collection.js";
import { createUsageLog } from "./lib/ai-usage.js";
import { createProfileStore, oracleIdOf } from "./lib/profiles.js";
import { createEmbeddingStore, createLocalEmbedder } from "./lib/embeddings.js";
import { createRankingCache } from "./lib/swaps.js";
import { capSwapsRequest, createSwapsService } from "./lib/swaps-service.js";
import { createDeckProfiles } from "./lib/deck-profiles.js";
import { createEdhrecClient, EdhrecError } from "./lib/edhrec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
// Saved-card snapshots (full Scryfall card objects + translate cache) easily
// exceed body-parser's 100 KB default, so raise the JSON body limit.
app.use(express.json({ limit: "25mb" }));
app.use(express.static(join(__dirname, "public")));

const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const STATE_FILE = join(DATA_DIR, "state.json");
const AI_PROVIDERS = new Set(["anthropic", "openai"]);
const DEFAULT_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const DEFAULT_APP_STATE = {
  savedCards: [],
  folders: [],
  membership: null,
  quantities: {}, // { [folderId]: { [cardId]: count } } — per-deck basic-land counts
  maybeboard: {}, // { [folderId]: { [cardId]: true } } — per-deck Maybeboard flags
  pins: {}, // { [folderId]: { [cardId]: true } } — per-deck "keep" pins (never suggested as cuts)
  deckNotes: {}, // { [folderId]: string } — per-deck Game plan used by View Swaps
  colorIdentity: [],
  translateCache: {},
  searchHistory: [],
  apiKey: "",
  openaiApiKey: "",
  preferredAiProvider: "anthropic",
  anthropicModel: DEFAULT_ANTHROPIC_MODEL,
  openaiModel: DEFAULT_OPENAI_MODEL,
  forceAiSearch: false,
};
const COLOR_IDS = new Set(["w", "u", "b", "r", "g", "c"]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeAppState(value = {}) {
  const input = plainObject(value) || {};
  return {
    savedCards: Array.isArray(input.savedCards) ? input.savedCards : [],
    folders: Array.isArray(input.folders) ? input.folders : [],
    membership: plainObject(input.membership),
    quantities: plainObject(input.quantities) || {},
    maybeboard: plainObject(input.maybeboard) || {},
    pins: plainObject(input.pins) || {},
    deckNotes: normalizeDeckNotes(input.deckNotes),
    colorIdentity: Array.isArray(input.colorIdentity) ? input.colorIdentity.filter((c) => COLOR_IDS.has(c)) : [],
    translateCache: plainObject(input.translateCache) || {},
    searchHistory: Array.isArray(input.searchHistory) ? input.searchHistory : [],
    apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
    openaiApiKey: typeof input.openaiApiKey === "string" ? input.openaiApiKey : "",
    preferredAiProvider: AI_PROVIDERS.has(input.preferredAiProvider) ? input.preferredAiProvider : "anthropic",
    anthropicModel: typeof input.anthropicModel === "string" && input.anthropicModel.trim() ? input.anthropicModel.trim() : DEFAULT_ANTHROPIC_MODEL,
    openaiModel: typeof input.openaiModel === "string" && input.openaiModel.trim() ? input.openaiModel.trim() : DEFAULT_OPENAI_MODEL,
    forceAiSearch: Boolean(input.forceAiSearch),
  };
}

function publicAppState(state) {
  const { apiKey, openaiApiKey, ...rest } = state;
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

// Per-folder basic-land counts. Union folders; within a folder, incoming wins.
function mergeQuantities(a, b) {
  const merged = {};
  [a, b].forEach((src) => {
    if (!src || typeof src !== "object") return;
    for (const [folderId, counts] of Object.entries(src)) {
      if (!counts || typeof counts !== "object") continue;
      merged[folderId] = { ...(merged[folderId] || {}), ...counts };
    }
  });
  return merged;
}

// Per-deck Maybeboard flags. Union folders; within a folder, incoming wins.
function mergeMaybeboard(a, b) {
  const merged = {};
  [a, b].forEach((src) => {
    if (!src || typeof src !== "object") return;
    for (const [folderId, flags] of Object.entries(src)) {
      if (!flags || typeof flags !== "object") continue;
      merged[folderId] = { ...(merged[folderId] || {}), ...flags };
    }
  });
  return merged;
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
    quantities: mergeQuantities(base.quantities, incoming.quantities),
    maybeboard: mergeMaybeboard(base.maybeboard, incoming.maybeboard),
    pins: mergeMaybeboard(base.pins, incoming.pins), // same per-deck flag shape
    deckNotes: mergeDeckNotes(base.deckNotes, incoming.deckNotes),
    colorIdentity: Array.isArray(incoming.colorIdentity) && incoming.colorIdentity.length ? incoming.colorIdentity : base.colorIdentity,
    translateCache: mergeTranslateCache(base.translateCache, incoming.translateCache),
    searchHistory: mergeSearchHistory(base.searchHistory, incoming.searchHistory),
    forceAiSearch: typeof incoming.forceAiSearch === "boolean" ? incoming.forceAiSearch : base.forceAiSearch,
    apiKey: base.apiKey,
    openaiApiKey: base.openaiApiKey,
    preferredAiProvider: base.preferredAiProvider,
    anthropicModel: base.anthropicModel,
    openaiModel: base.openaiModel,
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
      case "setQuantities":
        if (op.quantities && typeof op.quantities === "object") state.quantities = op.quantities;
        break;
      case "setMaybeboard":
        if (op.maybeboard && typeof op.maybeboard === "object") state.maybeboard = op.maybeboard;
        break;
      case "setPins":
        if (op.pins && typeof op.pins === "object") state.pins = op.pins;
        break;
      case "setDeckNotes":
        if (op.deckNotes && typeof op.deckNotes === "object") state.deckNotes = normalizeDeckNotes(op.deckNotes);
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
   If the query uses OR logic, wrap the OR expression in parentheses before appending f:commander, id<=IDENTITY, and game:paper.
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

function hasTopLevelOr(query) {
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '"' && query[i - 1] !== "\\") inQuote = !inQuote;
    if (inQuote) continue;
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if (depth === 0 && /\bor\b/i.test(query.slice(i, i + 2))) {
      const before = query[i - 1];
      const after = query[i + 2];
      if ((!before || /\s|\(/.test(before)) && (!after || /\s|\)/.test(after))) return true;
    }
  }
  return false;
}

function stripCommanderFilters(query) {
  return (query || "")
    .replace(/\bf(?:ormat)?:commander\b/gi, "")
    .replace(/\bgame:paper\b/gi, "")
    .replace(/\b(?:id|identity)\s*(?:<=|>=|!=|=|<|>|:)\s*[a-z]+\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function tokenizeScryfallQuery(query) {
  const tokens = [];
  let buf = "";
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '"' && query[i - 1] !== "\\") inQuote = !inQuote;
    if (!inQuote) {
      if (ch === "(") depth++;
      if (ch === ")" && depth > 0) depth--;
      if (/\s/.test(ch) && depth === 0) {
        if (buf) tokens.push(buf);
        buf = "";
        continue;
      }
    }
    buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function repairLeadingOrGroup(query) {
  if (!query || query.trim().startsWith("(")) return query;
  const tokens = tokenizeScryfallQuery(query);
  if (tokens.length < 4 || tokens[1]?.toLowerCase() !== "or") return query;
  let end = 0;
  while (tokens[end + 1]?.toLowerCase() === "or" && tokens[end + 2]) end += 2;
  if (end < 2 || end >= tokens.length - 1) return query;
  return `(${tokens.slice(0, end + 1).join(" ")}) ${tokens.slice(end + 1).join(" ")}`;
}

// Deterministically guarantee the mandatory Commander filters, so color identity
// (and f:commander / game:paper) never depend on the model remembering them.
// Existing commander filters are stripped and re-appended after the grouped core
// query so an ungrouped "A or B" cannot leak off-identity cards from the left side.
function enforceCommanderFilters(query, colorIdentity) {
  const core = repairLeadingOrGroup(stripCommanderFilters(query));
  const terms = [];
  if (core) terms.push(hasTopLevelOr(core) ? `(${core})` : core);
  terms.push("f:commander");
  const id = typeof colorIdentity === "string" ? colorIdentity.trim().toLowerCase() : "";
  if (id) terms.push(`id<=${id}`);
  terms.push("game:paper");
  return terms.join(" ").replace(/\s{2,}/g, " ").trim();
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
      return writeAppState({
        ...updated,
        apiKey: current.apiKey,
        openaiApiKey: current.openaiApiKey,
        preferredAiProvider: current.preferredAiProvider,
        anthropicModel: current.anthropicModel,
        openaiModel: current.openaiModel,
      });
    });
    res.json(publicAppState(nextState));
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to apply ops" });
  }
});

function providerKeySource(envKey, storedKey) {
  if (envKey) return "environment";
  if (storedKey) return "appdata";
  return "none";
}

function settingsSummary(state) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || state.apiKey;
  const openaiKey = process.env.OPENAI_API_KEY || state.openaiApiKey;
  const preferredAiProvider = AI_PROVIDERS.has(state.preferredAiProvider) ? state.preferredAiProvider : "anthropic";
  const providers = {
    anthropic: {
      hasApiKey: Boolean(anthropicKey),
      source: providerKeySource(process.env.ANTHROPIC_API_KEY, state.apiKey),
      model: process.env.ANTHROPIC_MODEL || state.anthropicModel || DEFAULT_ANTHROPIC_MODEL,
      modelSource: process.env.ANTHROPIC_MODEL ? "environment" : "appdata",
    },
    openai: {
      hasApiKey: Boolean(openaiKey),
      source: providerKeySource(process.env.OPENAI_API_KEY, state.openaiApiKey),
      model: process.env.OPENAI_MODEL || state.openaiModel || DEFAULT_OPENAI_MODEL,
      modelSource: process.env.OPENAI_MODEL ? "environment" : "appdata",
    },
  };
  const preferred = providers[preferredAiProvider];
  return {
    preferredAiProvider,
    providers,
    hasApiKey: Boolean(preferred?.hasApiKey),
    source: preferred?.source || "none",
  };
}

function activeAiConfig(state) {
  const summary = settingsSummary(state);
  const provider = summary.preferredAiProvider;
  const apiKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY || state.openaiApiKey
      : process.env.ANTHROPIC_API_KEY || state.apiKey;
  return {
    provider,
    apiKey,
    model: summary.providers[provider]?.model,
  };
}

app.get("/api/settings", async (req, res) => {
  try {
    res.json(settingsSummary(await readAppState()));
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to read settings" });
  }
});

app.put("/api/settings", async (req, res) => {
  try {
    const body = req.body || {};
    const state = await readAppState();
    const next = { ...state };

    if (typeof body.preferredAiProvider === "string" && AI_PROVIDERS.has(body.preferredAiProvider)) {
      next.preferredAiProvider = body.preferredAiProvider;
    }
    if (typeof body.anthropicModel === "string" && body.anthropicModel.trim()) next.anthropicModel = body.anthropicModel.trim();
    if (typeof body.openaiModel === "string" && body.openaiModel.trim()) next.openaiModel = body.openaiModel.trim();

    const legacyAnthropicKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const anthropicApiKey = typeof body.anthropicApiKey === "string" ? body.anthropicApiKey.trim() : legacyAnthropicKey;
    const openaiApiKey = typeof body.openaiApiKey === "string" ? body.openaiApiKey.trim() : "";
    if (anthropicApiKey) next.apiKey = anthropicApiKey;
    if (openaiApiKey) next.openaiApiKey = openaiApiKey;

    const saved = await writeAppState(next);
    res.json(settingsSummary(saved));
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to save settings" });
  }
});

function normalizeRecommendedCards(value) {
  return Array.isArray(value)
    ? value.filter((c) => c && c.name).map((c) => ({ name: String(c.name), reason: String(c.reason || "") }))
    : [];
}

async function callOpenAIJson(args) {
  return (await callOpenAIJsonRaw(args)).data;
}

async function translateWithAnthropic({ apiKey, model, userMessage, colorIdentity }) {
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    system: SCRYFALL_SYSTEM_PROMPT,
    tools: [RECOMMEND_TOOL, WEB_SEARCH_TOOL],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: userMessage }],
  });

  const rec = message.content.find((b) => b.type === "tool_use" && b.name === "recommend_cards");
  if (rec) {
    return {
      type: "cards",
      summary: String(rec.input?.summary || ""),
      cards: normalizeRecommendedCards(rec.input?.cards),
    };
  }

  const textBlock = message.content.find((b) => b.type === "text");
  const scryfallQuery = enforceCommanderFilters(extractQuery((textBlock?.text || "").trim()), colorIdentity);
  return { type: "query", query: scryfallQuery, scryfallQuery };
}

async function translateWithOpenAI({ apiKey, model, userMessage, colorIdentity }) {
  const parsed = await callOpenAIJson({
    apiKey,
    model,
    maxTokens: 4096,
    system: `${SCRYFALL_SYSTEM_PROMPT}

Respond only as JSON. Use one of these shapes:
{"type":"query","query":"Scryfall search query"}
{"type":"cards","summary":"short framing sentence","cards":[{"name":"Exact card name","reason":"short reason"}]}
For plain Scryfall-searchable requests, return type "query". For curated recommendations, return type "cards" with real Magic card names.`,
    user: userMessage,
  });
  if (parsed.type === "cards") {
    return {
      type: "cards",
      summary: String(parsed.summary || ""),
      cards: normalizeRecommendedCards(parsed.cards),
    };
  }
  const scryfallQuery = enforceCommanderFilters(extractQuery(String(parsed.query || parsed.scryfallQuery || "")), colorIdentity);
  return { type: "query", query: scryfallQuery, scryfallQuery };
}

function aiErrorMessage(err, provider, fallback = "AI request failed") {
  if (err.status === 401) return `Invalid ${provider === "openai" ? "OpenAI" : "Anthropic"} API key. Check your key in Settings.`;
  if (err.status === 404) return "Model not found. Check the selected model in Settings or your API access.";
  if (err.status === 429) return "Rate limited. Wait a moment and try again.";
  return err.message || fallback;
}

app.post("/api/translate", async (req, res) => {
  const { query, colorIdentity, forceAiSearch } = req.body;
  const appState = await readAppState();
  const ai = activeAiConfig(appState);
  if (!query || !ai.apiKey) {
    return res.status(400).json({
      error: `Missing ${ai.provider === "openai" ? "OpenAI" : "Anthropic"} API key. Add it in Settings or switch providers.`,
    });
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
    const result = ai.provider === "openai"
      ? await translateWithOpenAI({ apiKey: ai.apiKey, model: ai.model, userMessage, colorIdentity })
      : await translateWithAnthropic({ apiKey: ai.apiKey, model: ai.model, userMessage, colorIdentity });
    res.json({ ...result, provider: ai.provider, model: ai.model });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: aiErrorMessage(err, ai.provider, "Failed to translate query") });
  }
});

const DECK_IDENTITY_TAGS = [
  "+1/+1 Counters", "-1/-1 Counters", "Affinity", "Aggro", "Aikido", "Aristocrats", "Artifacts", "Attractions", "Auras", "Battlecruiser", "Birthing Pod / Pod", "Blink / Flicker", "Blue Moon", "Budget", "Burn", "Cascade", "Casual", "cEDH", "Chaos", "Clones", "Coin Flips", "Combo", "Control", "Cycling", "Death & Taxes", "Defender", "Delver", "Devotion", "Discard", "Discover", "Donation", "Dredge", "Dungeons", "Eggs", "Enchantments", "Energy", "Equipment", "Extra Combats", "Extra Turns", "Farm", "Flying", "Formula X-1", "Goad", "Goodstuff", "Group Hug", "Group Slug", "Hatebears", "Help Wanted", "Historic", "Infect", "Jank", "Kindred", "Land Destruction", "Lands Matter", "Legends Matter", "Life Bargain", "Life Gain", "Maverick", "Midrange", "Mill", "Miracles", "Modified", "Modular", "Monarch", "Morph", "Mutate", "Pillowfort", "Poison", "Primer", "Prison", "Ramp", "Reanimator", "Rock", "Rule Zero", "Snow", "Spellslinger", "Stax", "Stoneblade", "Storm", "Super Friends", "Tempo", "Thieves", "Tokens", "Toolbox", "Tron", "Turbo", "Unmaintained", "Vehicles", "Voltron", "Vorthos", "Webcam Friendly", "Wheels", "X Spells", "Zoo",
  "Combat Damage", "ETB", "Graveyard", "Landfall", "Power Matters", "Sacrifice", "Saprolings", "Treasure", "Typal: Fungi", "Typal: Saproling",
];
const DECK_IDENTITY_LOOKUP = new Map(DECK_IDENTITY_TAGS.map((tag) => [tag.toLowerCase(), tag]));

const REVIEW_ROLES = ["ramp", "draw", "removal", "wipes", "tutors", "interaction", "graveyardHate", "protection"];

// The app grades role counts itself (from per-card profiles, with archetype-adjusted
// targets), so the review is only asked for what it uniquely adds: the deck's identity, a
// verdict, short role notes, and concrete adds/cuts. Kept stable so it can be prompt-cached.
const DECK_REVIEW_PROMPT = `You review Magic: The Gathering Commander (EDH) decks for a deck-building app. The app already counts each role (ramp, draw, removal, board wipes, tutors, interaction, graveyard hate, protection) from per-card data and grades them against targets tuned to the deck's archetype — so you don't count or grade. Your job is the judgment a count can't make: what this deck is trying to do, how well its cards serve that plan, and the few changes that would matter most.

You'll get the commander (with its rules text), the deck's color identity, its estimated bracket (1 Exhibition … 5 cEDH), the owner's own game plan when they wrote one, heuristic win-condition signals, and the card list (name, type, mana value, rules text). Treat the owner's game plan as the intended strategy. Judge cards by what they do, not by keywords. When more than 100 cards are listed, it's a pool being trimmed to 100: describe the direction the pool points and name the clearest cuts.

Fill the response schema:
- identityTags: 2–8 labels from the allowed list that describe the deck's actual engine, plan, or payoff. Do not use Aristocrats merely because a deck sacrifices or recurs creatures; reserve it for recurring creature-death payoffs (drain, damage, death-value engines). Skip status labels (Budget, Primer, Help Wanted, Rule Zero, Unmaintained, Webcam Friendly) unless the input clearly shows them.
- verdict: one sentence under 140 characters on where the deck stands and its most meaningful improvement. Missing board wipes are rarely the headline — tokens, aristocrats and graveyard decks often run few on purpose.
- roleNotes: for each role where this deck's cards are notably strong, thin, or unusual for its plan, a note under 55 characters naming 1–3 example cards, with your confidence (0–1) that the note is right. Skip roles with nothing worth saying.
- add: 3–6 real, exactly spelled cards legal in the stated color identity, suited to the plan and the bracket, not already in the list.
- trim: 2–4 exact card names from the list — the weakest or most redundant for this plan.`;

function deckReviewSchema() {
  return {
    type: "object",
    properties: {
      identityTags: { type: "array", items: { type: "string", enum: DECK_IDENTITY_TAGS } },
      verdict: { type: "string" },
      roleNotes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: REVIEW_ROLES },
            note: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["role", "note", "confidence"],
          additionalProperties: false,
        },
      },
      add: { type: "array", items: { type: "string" } },
      trim: { type: "array", items: { type: "string" } },
    },
    required: ["identityTags", "verdict", "roleNotes", "add", "trim"],
    additionalProperties: false,
  };
}

// Maps the schema's roleNotes array back to the { role: note } / { role: confidence }
// objects the client reads, and keeps the older object form working for OpenAI replies.
function normalizeDeckReview(parsed = {}) {
  const roleNotes = {};
  const confidence = {};
  const clean = (v) => String(v).replace(/\s+/g, " ").trim().slice(0, 90);
  if (Array.isArray(parsed.roleNotes)) {
    for (const r of parsed.roleNotes) {
      if (!r || !REVIEW_ROLES.includes(r.role)) continue;
      roleNotes[r.role] = clean(r.note || "");
      if (typeof r.confidence === "number") confidence[r.role] = Math.max(0, Math.min(1, r.confidence));
    }
  } else if (parsed.roleNotes && typeof parsed.roleNotes === "object") {
    for (const [k, v] of Object.entries(parsed.roleNotes)) roleNotes[k] = clean(v);
    if (parsed.confidence && typeof parsed.confidence === "object") Object.assign(confidence, parsed.confidence);
  }
  return {
    roleNotes,
    confidence,
    identityTags: Array.isArray(parsed.identityTags)
      ? [...new Set(parsed.identityTags.map((tag) => DECK_IDENTITY_LOOKUP.get(String(tag).trim().toLowerCase())).filter(Boolean))].slice(0, 8)
      : [],
    verdict: typeof parsed.verdict === "string" ? parsed.verdict.slice(0, 200) : "",
    add: Array.isArray(parsed.add) ? parsed.add.slice(0, 6).map(String) : [],
    trim: Array.isArray(parsed.trim) ? parsed.trim.slice(0, 4).map((n) => String(n).replace(/^-\s*/, "")) : [],
  };
}

// Runs through the shared AI client: effort-aware, strict JSON schema (Anthropic),
// cut-off/refusal detection, and usage recorded in the monthly AI spend (even for a
// failed, billed call). 12k max_tokens leaves room for the model's thinking on big pools.
async function reviewDeck({ ai, list }) {
  const client = createAiClient({ provider: ai.provider, apiKey: ai.apiKey, model: ai.model });
  const openai = ai.provider === "openai";
  try {
    const r = await client.json({
      // Anthropic: the whole prompt goes in the cached system block (cache_control on it).
      system: openai ? `${DECK_REVIEW_PROMPT}\n\nReturn only one valid JSON object with keys identityTags, verdict, roleNotes ([{role, note, confidence}]), add, trim.` : "Commander deck review.",
      cachedContext: openai ? "" : `${DECK_REVIEW_PROMPT}\n\nAllowed identityTags: ${DECK_IDENTITY_TAGS.join(" | ")}`,
      user: `Review this Commander deck.\n\n${list}`,
      maxTokens: 12000,
      effort: "medium",
      schema: openai ? undefined : deckReviewSchema(),
    });
    await usageLog.record({ feature: "deck-review", provider: ai.provider, model: ai.model, ...r.usage, usd: r.usd });
    return normalizeDeckReview(r.data);
  } catch (err) {
    if (err.usage) await usageLog.record({ feature: "deck-review", provider: ai.provider, model: ai.model, ...err.usage, usd: err.usd }).catch(() => {});
    throw err;
  }
}

const oneLine = (v, max) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max);
const BRACKET_LABELS = { 1: "Exhibition", 2: "Core", 3: "Upgraded", 4: "Optimized", 5: "cEDH" };

app.post("/api/deck-review", async (req, res) => {
  const appState = await readAppState();
  const ai = activeAiConfig(appState);
  const cards = Array.isArray(req.body?.cards) ? req.body.cards.slice(0, 250) : [];
  if (!cards.length || !ai.apiKey) {
    return res.status(400).json({
      error: !cards.length
        ? "Missing cards"
        : `Missing ${ai.provider === "openai" ? "OpenAI" : "Anthropic"} API key. Add it in Settings or switch providers.`,
    });
  }
  try {
    const list = cards
      .map((c) => `- ${c.name} [${c.type_line || ""}] (MV ${c.cmc ?? 0}) :: ${oneLine(c.oracle_text, 240)}`)
      .join("\n");
    const b = req.body || {};
    const commander = oneLine(b.commander, 120);
    const commanderText = oneLine(b.commanderText, 600);
    const colors = Array.isArray(b.colorIdentity) ? b.colorIdentity.map(String).filter((c) => /^[WUBRG]$/.test(c)) : [];
    const bracket = Number.isInteger(b.bracket) && BRACKET_LABELS[b.bracket] ? `${b.bracket} (${BRACKET_LABELS[b.bracket]}), estimated from Game Changers` : "unknown";
    const gamePlan = oneLine(b.gamePlan, 1500);
    const winConditions = Array.isArray(b.winConditions)
      ? b.winConditions.slice(0, 12).map((name) => oneLine(name, 120)).filter(Boolean)
      : [];
    const reviewContext = [
      `Commander: ${commander || "Unknown"}${commanderText ? ` — ${commanderText}` : ""}`,
      `Color identity: ${colors.length ? colors.join("") : "colorless"}`,
      `Bracket: ${bracket}`,
      `Owner's game plan: ${gamePlan || "none written"}`,
      `Cards listed: ${cards.length}${cards.length > 100 ? " (an oversized pool being trimmed to 100)" : ""}`,
      `Heuristic win-condition signals: ${winConditions.join(", ") || "none detected; infer the likely plan from the deck"}`,
      "",
      list,
    ].join("\n");
    const review = await reviewDeck({ ai, list: reviewContext });
    res.json({ ...review, provider: ai.provider, model: ai.model });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: aiErrorMessage(err, ai.provider, "Deck review failed") });
  }
});

// ── Game Changers list (for Commander bracket) ────────────────────
// Scryfall's `is:gamechanger` is the official Game Changers list. Cached 24h;
// the list changes only when WotC revises it.
let gameChangersCache = null; // { ts, names }
const GC_TTL = 1000 * 60 * 60 * 24;

app.get("/api/game-changers", async (req, res) => {
  if (gameChangersCache && Date.now() - gameChangersCache.ts < GC_TTL) {
    return res.json({ names: gameChangersCache.names });
  }
  try {
    const names = [];
    let url = "https://api.scryfall.com/cards/search?q=is%3Agamechanger&unique=cards";
    for (let i = 0; i < 5 && url; i++) {
      const r = await fetch(url, { headers: { "User-Agent": "SpellbookApp/0.1", Accept: "application/json" } });
      if (!r.ok) break;
      const d = await r.json();
      (Array.isArray(d.data) ? d.data : []).forEach((c) => { if (c && c.name) names.push(String(c.name)); });
      url = d.has_more ? d.next_page : null;
    }
    if (names.length) gameChangersCache = { ts: Date.now(), names };
    res.json({ names: gameChangersCache ? gameChangersCache.names : names });
  } catch (err) {
    res.status(500).json({ error: "Failed to load Game Changers" });
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

// ── EDHREC (unofficial) commander recommendations ──────────────────
const edhrecClient = createEdhrecClient({ dataDir: DATA_DIR });

app.get("/api/edhrec/commander", async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "Missing name" });
  try {
    res.json(await edhrecClient.getCommander(name));
  } catch (err) {
    if (err instanceof EdhrecError) return res.status(502).json({ error: err.message });
    res.status(502).json({ error: "Couldn't reach EDHREC." });
  }
});

// ── Collection & swaps ─────────────────────────────────────────────
const collectionStore = createCollectionStore({ dataDir: DATA_DIR });
const profileStore = createProfileStore({ dataDir: DATA_DIR });
const usageLog = createUsageLog({ dataDir: DATA_DIR });
const getAi = async () => {
  const ai = activeAiConfig(await readAppState());
  return ai.apiKey ? createAiClient(ai) : null;
};
let embedderPromise = null;
const swapsService = createSwapsService({
  collectionStore,
  profileStore,
  embeddingStore: createEmbeddingStore({ dataDir: DATA_DIR }),
  rankingCache: createRankingCache({ dataDir: DATA_DIR }),
  usageLog,
  getAi,
  getEmbedder: () => (embedderPromise ||= createLocalEmbedder({ cacheDir: join(DATA_DIR, "models") })
    .catch((err) => { embedderPromise = null; throw err; })),
});
const deckProfiles = createDeckProfiles({ profileStore, getAi, usageLog });

app.get("/api/collection", async (req, res) => {
  try {
    res.json(await collectionStore.payload());
  } catch (err) {
    res.status(500).json({ error: err.message || "Couldn't load the collection" });
  }
});

app.post("/api/collection/preview", async (req, res) => {
  try {
    res.json(await collectionStore.preview(String(req.body?.csv || "")));
  } catch (err) {
    res.status(err instanceof CollectionFormatError ? 400 : 500).json({ error: err.message || "Couldn't read that file" });
  }
});

app.post("/api/collection/apply", async (req, res) => {
  const mode = req.body?.mode;
  if (mode !== "sync" && mode !== "add") return res.status(400).json({ error: "Unknown upload mode" });
  try {
    const result = await collectionStore.apply(String(req.body?.previewId || ""), mode);
    swapsService.afterSync().catch(() => {});
    res.json(result);
  } catch (err) {
    const status = err instanceof PreviewStaleError ? 409
      : err instanceof PreviewExpiredError ? 410
      : err instanceof ScryfallError ? 502 : 500;
    res.status(status).json({ error: err.message || "Sync failed" });
  }
});

app.post("/api/collection/owned", async (req, res) => {
  const { scryfallId, oracleId, owned } = req.body || {};
  if (typeof owned !== "boolean") return res.status(400).json({ error: "Missing owned" });
  if (owned && typeof scryfallId !== "string") return res.status(400).json({ error: "Missing scryfallId" });
  if (!owned && typeof oracleId !== "string") return res.status(400).json({ error: "Missing oracleId" });
  try {
    const result = owned ? await collectionStore.markOwned(scryfallId) : await collectionStore.unmarkOwned(oracleId);
    swapsService.afterSync().catch(() => {});
    res.json(result);
  } catch (err) {
    const status = err instanceof CollectionFormatError ? 400 : err instanceof ScryfallError ? 502 : 500;
    res.status(status).json({ error: err.message || "Couldn't update the collection" });
  }
});

app.get("/api/swaps/status", async (req, res) => {
  try {
    res.json(await swapsService.status());
  } catch (err) {
    res.status(500).json({ error: err.message || "Couldn't read swap status" });
  }
});

app.post("/api/swaps/prepare", async (req, res) => {
  try {
    res.json(await swapsService.prepare());
  } catch (err) {
    res.status(500).json({ error: err.message || "Couldn't start preparing swaps" });
  }
});

app.post("/api/swaps", async (req, res) => {
  if (!req.body?.card || !req.body.card.name) return res.status(400).json({ error: "Missing card" });
  const { card, deck } = capSwapsRequest({
    card: req.body.card,
    deck: req.body?.deck && typeof req.body.deck === "object" ? req.body.deck : null,
  });
  try {
    const { httpStatus, body } = await swapsService.swaps({
      card,
      colorIdentity: Array.isArray(req.body?.colorIdentity) ? req.body.colorIdentity : card.color_identity || [],
      deck,
    });
    res.status(httpStatus).json(body);
  } catch (err) {
    res.status(500).json({ error: err.message || "Swaps failed" });
  }
});

// Deck cards are unauthenticated client input too, so cap and dedupe the same way as
// /api/swaps: reuse capSwapsRequest's card capping (deck: null — no deck fields here).
const DECK_PROFILE_CARDS_MAX = 200;
function normalizeDeckProfileCards(raw) {
  const byOid = new Map();
  for (const item of (Array.isArray(raw) ? raw : []).slice(0, DECK_PROFILE_CARDS_MAX)) {
    const { card } = capSwapsRequest({ card: item, deck: null });
    const oid = oracleIdOf(card);
    if (oid && !byOid.has(oid)) byOid.set(oid, card);
  }
  return [...byOid.values()];
}

app.post("/api/deck-profiles/lookup", async (req, res) => {
  try {
    res.json(await deckProfiles.lookup(normalizeDeckProfileCards(req.body?.cards)));
  } catch (err) {
    res.status(500).json({ error: err.message || "Couldn't look up card profiles" });
  }
});

app.post("/api/deck-profiles/prepare", async (req, res) => {
  try {
    const result = await deckProfiles.prepare(normalizeDeckProfileCards(req.body?.cards), { confirm: Boolean(req.body?.confirm) });
    if (result?.error === "no-ai") return res.status(409).json({ error: "AI isn't configured." });
    if (result?.needsConfirmation) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "Couldn't profile deck cards" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
