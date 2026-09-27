import { createHash } from "crypto";
import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";
import { dot } from "./embeddings.js";
import { cardPromptLine, oracleIdOf } from "./profiles.js";

export const SWAP_SHORTLIST = 15;
export const SWAP_MIN_MATCH = 40;
export const SWAP_MAX_RESULTS = 8;
export const SHORTLIST_WEIGHTS = { text: 0.6, mechanics: 0.25, type: 0.1, mv: 0.05 };

const PRIMARY_TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Battle", "Land"];
const frontType = (c) => (c.type_line || c.card_faces?.[0]?.type_line || "").split(" // ")[0];

export const isLand = (c) => /\bLand\b/.test(frontType(c));
export const isBasicLand = (c) => /\bBasic\b/.test(frontType(c)) && isLand(c);
export const primaryTypes = (c) => new Set(PRIMARY_TYPES.filter((t) => frontType(c).includes(t)));
export const normalizeName = (name) => String(name || "").split(" // ")[0].trim().toLowerCase();

export function typeScore(a, b) {
  const A = primaryTypes(a);
  const B = primaryTypes(b);
  if (A.size === B.size && [...A].every((t) => B.has(t))) return 1;
  if ([...A].some((t) => B.has(t))) return 0.5;
  if ((A.has("Instant") && B.has("Sorcery")) || (A.has("Sorcery") && B.has("Instant"))) return 0.5;
  return 0;
}

export const mvScore = (a, b) => Math.max(0, 1 - Math.abs((a.cmc || 0) - (b.cmc || 0)) / 4);

export function jaccard(a = [], b = []) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  return shared / new Set([...A, ...B]).size;
}

export function filterCandidates({ original, allowedIdentity, deckNames, candidates }) {
  const allowed = new Set((allowedIdentity || []).map((c) => String(c).toUpperCase()));
  const excluded = new Set((deckNames || []).map(normalizeName));
  const originalOid = oracleIdOf(original);
  const originalIsLand = isLand(original);
  return candidates.filter(({ card, oracleId }) =>
    oracleId !== originalOid
    && !excluded.has(normalizeName(card.name))
    && (card.color_identity || []).every((c) => allowed.has(c))
    && card.legalities?.commander === "legal"
    && isLand(card) === originalIsLand
    && !isBasicLand(card));
}

export function shortlist({ original, originalVector, originalProfile, candidates, vectorFor, profileFor, size = SWAP_SHORTLIST }) {
  const w = SHORTLIST_WEIGHTS;
  return candidates
    .map((c) => {
      const vec = vectorFor(c.oracleId);
      const text = vec ? dot(originalVector, vec) : 0;
      const profile = profileFor(c.oracleId);
      // Without mechanics on both sides, that weight moves onto text similarity.
      const hasMechanics = Boolean(originalProfile?.mechanics?.length && profile?.mechanics?.length);
      const score = (hasMechanics ? w.text : w.text + w.mechanics) * text
        + (hasMechanics ? w.mechanics * jaccard(originalProfile.mechanics, profile.mechanics) : 0)
        + w.type * typeScore(original, c.card)
        + w.mv * mvScore(original, c.card);
      return { ...c, textScore: text, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, size);
}

export const RANK_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          match: { type: "integer" },
          fits: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["id", "match", "fits", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

export const RANK_SYSTEM_PROMPT = `You are an expert Commander (EDH) deckbuilder. A player wants to replace one card in their deck with a budget stand-in from their own collection, so they don't have to buy the replaced card. You get the deck (commander, the player's game plan if provided, and the decklist), the card to replace, and candidate cards from the player's collection, each with a short profile of what it does.

For each candidate, judge it as a budget stand-in IN THIS DECK: does it do the same job the replaced card does here, and does it work with this commander and game plan — even if it is weaker, slower, or narrower? Judge by function and synergy, not shared wording: a card that shares keywords but not the role should score low. If the game plan is missing, infer it from the commander and decklist.

Respond with ONLY minified JSON, no prose or code fences:
{"results":[{"id":"k1","match":72,"fits":true,"reason":"..."}]}
- id: the candidate's exact id. Return exactly one entry per candidate.
- match: 0-100, how close it comes to replacing the card here (100 = does the job at least as well, around 50 = does the job clearly worse — slower, smaller effect, narrower — below 40 = barely overlaps).
- fits: false only if the candidate does not do that job in this deck, or works against the deck's plan.
- reason: one sentence under 140 characters: what it does for this deck, and the main trade-off versus the replaced card.`;

// Bump whenever RANK_SYSTEM_PROMPT or RANK_SCHEMA change meaning: every cached ranking is invalidated.
export const RANK_PROMPT_VERSION = 2;

const profileLine = (p) => (p ? `   Does: ${p.summary} [${(p.mechanics || []).join(", ")}]` : "");

export function deckContext(deck) {
  if (!deck) return "DECK: none — judge the candidates as general replacements in a Commander deck of these colors.";
  const plan = String(deck.gamePlan || "").trim();
  return [
    `DECK: ${deck.name || "Unnamed deck"}`,
    deck.commander
      ? `Commander: ${deck.commander.name} | ${deck.commander.typeLine || ""} | ${String(deck.commander.text || "").replace(/\s+/g, " ").trim()}`
      : "Commander: none set",
    `Game plan (written by the player; may include website boilerplate to ignore):\n${plan || "Not provided — infer the plan from the commander and decklist."}`,
    deck.identityTags?.length ? `Deck themes: ${deck.identityTags.join(", ")}` : "",
    `Decklist: ${(deck.cardNames || []).join("; ")}`,
  ].filter(Boolean).join("\n");
}

export function buildRankRequest({ deck, original, originalProfile, shortlisted, profileFor }) {
  const ids = new Map();
  const lines = shortlisted.map((c, i) => {
    const id = `k${i + 1}`;
    ids.set(id, c.oracleId);
    return [cardPromptLine(c.card, id), profileLine(profileFor(c.oracleId))].filter(Boolean).join("\n");
  });
  const user = [
    "CARD TO REPLACE:",
    [cardPromptLine(original, "original"), profileLine(originalProfile)].filter(Boolean).join("\n"),
    "",
    "CANDIDATES FROM THE PLAYER'S COLLECTION:",
    ...lines,
  ].join("\n");
  return { system: RANK_SYSTEM_PROMPT, cachedContext: deckContext(deck), user, ids };
}

export function parseRankResponse(data, ids) {
  const out = [];
  for (const r of Array.isArray(data?.results) ? data.results : []) {
    const oracleId = ids.get(String(r?.id || "").trim());
    if (!oracleId) continue;
    out.push({
      oracleId,
      match: Math.max(0, Math.min(100, Math.round(Number(r.match) || 0))),
      fits: r.fits === true,
      reason: String(r.reason || "").replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }
  return out;
}

const resultItem = (c, match, reason) => ({ oracle_id: c.oracleId, scryfallIds: c.scryfallIds, card: c.card, match, reason });

export function finalizeAi(shortlisted, ranked) {
  const byOid = new Map(shortlisted.map((c) => [c.oracleId, c]));
  return ranked
    .filter((r) => r.fits && r.match >= SWAP_MIN_MATCH && byOid.has(r.oracleId))
    .sort((a, b) => b.match - a.match)
    .slice(0, SWAP_MAX_RESULTS)
    .map((r) => resultItem(byOid.get(r.oracleId), r.match, r.reason));
}

export function finalizeLocal(shortlisted) {
  return shortlisted
    .map((c) => ({ c, match: Math.round(c.score * 100) }))
    .filter((x) => x.match >= SWAP_MIN_MATCH)
    .sort((a, b) => b.match - a.match)
    .slice(0, SWAP_MAX_RESULTS)
    .map((x) => resultItem(x.c, x.match, ""));
}

export function rankingCacheKey({ originalOracleId, deckSignature, gamePlan, syncedAt, model, promptVersion = RANK_PROMPT_VERSION }) {
  return createHash("sha1")
    .update(JSON.stringify([originalOracleId, deckSignature || "", String(gamePlan || ""), syncedAt || "", model || "", promptVersion]))
    .digest("hex");
}

export function createRankingCache({ dataDir }) {
  const path = join(dataDir, "swap-rankings.json");
  let loading = null;
  let chain = Promise.resolve();

  // Concurrent cold calls must all await the same read instead of each racing past
  // "not loaded yet" and clobbering one another's in-memory object once it resolves.
  function load() {
    if (!loading) {
      loading = readJson(path, {});
      loading.catch(() => { loading = null; });
    }
    return loading;
  }

  const get = async (key) => (await load())[key] || null;
  function set(key, results) {
    const run = chain.then(async () => {
      const data = await load();
      data[key] = results;
      await writeJsonAtomic(path, data);
    });
    chain = run.then(() => {}, () => {});
    return run;
  }
  return { get, set };
}
