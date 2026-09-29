import { estimateProfileUsd, oracleIdOf, profileOne, runProfileJob } from "./profiles.js";
import { countStale, embeddingText, ensureEmbeddings } from "./embeddings.js";
import { DECK_NOTES_MAX } from "./deck-notes.js";
import {
  RANK_SCHEMA, buildRankRequest, filterCandidates, finalizeAi, finalizeLocal, parseRankResponse, rankingCacheKey,
  shortlist,
} from "./swaps.js";

// Profiling more cards than this needs the user to press Start (spend control).
export const PROFILE_AUTO_LIMIT = 50;

// Cheap hardening for the unauthenticated LAN /api/swaps route: the request body is
// arbitrary client-supplied JSON, so cap it to reasonable sizes before it reaches the
// service (and, eventually, an AI prompt).
const CARD_FIELD_MAX = 4000;
const CARD_FIELDS = ["name", "type_line", "oracle_text", "mana_cost"];
const DECK_CARD_NAMES_MAX = 250;
const DECK_CARD_NAME_MAX = 200;
const DECK_IDENTITY_TAGS_MAX = 16;

function capFace(face) {
  if (!face || typeof face !== "object") return face;
  const capped = {};
  for (const [k, v] of Object.entries(face)) capped[k] = typeof v === "string" ? v.slice(0, CARD_FIELD_MAX) : v;
  return capped;
}

function capCard(card) {
  if (!card || typeof card !== "object") return card;
  const capped = { ...card };
  for (const field of CARD_FIELDS) if (typeof capped[field] === "string") capped[field] = capped[field].slice(0, CARD_FIELD_MAX);
  if (Array.isArray(capped.card_faces)) capped.card_faces = capped.card_faces.map(capFace);
  return capped;
}

function capDeck(deck) {
  if (!deck || typeof deck !== "object") return deck;
  const capped = { ...deck };
  if (typeof capped.gamePlan === "string") capped.gamePlan = capped.gamePlan.slice(0, DECK_NOTES_MAX);
  if (Array.isArray(capped.cardNames)) {
    capped.cardNames = capped.cardNames
      .slice(0, DECK_CARD_NAMES_MAX)
      .map((n) => (typeof n === "string" ? n.slice(0, DECK_CARD_NAME_MAX) : n));
  }
  if (Array.isArray(capped.identityTags)) capped.identityTags = capped.identityTags.slice(0, DECK_IDENTITY_TAGS_MAX);
  return capped;
}

export function capSwapsRequest({ card, deck }) {
  return { card: capCard(card), deck: capDeck(deck) };
}

async function recordUsage(usageLog, ai, feature, r) {
  await usageLog.record({ feature, provider: ai.provider, model: ai.model, ...r.usage, usd: r.usd });
}

// One representative card per oracle id (printings share rules text).
export function collectionOracleCards(cards) {
  const byOid = new Map();
  for (const card of Object.values(cards || {})) {
    const oid = oracleIdOf(card);
    if (!oid) continue;
    const e = byOid.get(oid);
    if (e) e.scryfallIds.push(card.id);
    else byOid.set(oid, { oracleId: oid, card, scryfallIds: [card.id] });
  }
  return byOid;
}

// Bulk runs (a Start click on more than PROFILE_AUTO_LIMIT cards) go through Anthropic's
// Message Batches API at half price; small automatic runs stay immediate.
const batchable = (ai, count) => Boolean(ai && ai.provider === "anthropic" && count > PROFILE_AUTO_LIMIT);

export function createSwapsService({ collectionStore, profileStore, embeddingStore, rankingCache, usageLog, getAi, getEmbedder, batchStatePath = null }) {
  let job = null; // { phase, profiled, embedded, promise }
  let lastError = null;
  const skipped = new Set(); // oracle ids the AI failed to profile this session — never auto-retried

  async function snapshot() {
    const [collection, cards, ai] = await Promise.all([collectionStore.load(), collectionStore.loadCards(), getAi()]);
    const byOid = collectionOracleCards(cards);
    const pending = ai ? await profileStore.pending([...byOid.keys()]) : [];
    return { collection, byOid, ai, pending };
  }

  async function embeddingItems(byOid) {
    const items = [];
    for (const { oracleId, card } of byOid.values()) {
      items.push({ oracleId, text: embeddingText(card, await profileStore.get(oracleId)) });
    }
    return items;
  }

  function start({ manual }) {
    if (job) return job.promise;
    lastError = null;
    if (manual) skipped.clear();
    job = { phase: "profiling", profiled: 0, embedded: 0 };
    const current = job;
    current.promise = (async () => {
      try {
        const { byOid, ai, pending } = await snapshot();
        const todo = pending.filter((oid) => !skipped.has(oid));
        // Re-check the limit here too: a whole-collection apply (or a new API key) can land
        // between status()'s snapshot and this one, so auto-starts must never profile past it.
        const shouldProfile = Boolean(ai) && todo.length > 0 && (manual || todo.length <= PROFILE_AUTO_LIMIT);
        current.phase = shouldProfile ? "profiling" : "embedding";
        if (shouldProfile) {
          const { failed } = await runProfileJob({
            cards: todo.map((oid) => byOid.get(oid).card),
            store: profileStore, ai, usageLog,
            useBatch: manual && batchable(ai, todo.length), batchStatePath,
            onProgress: ({ profiled, batch }) => { current.profiled = profiled; current.batch = Boolean(batch); },
          });
          failed.forEach((oid) => skipped.add(oid));
        }
        current.phase = "embedding";
        const embedder = await getEmbedder();
        await ensureEmbeddings({
          items: await embeddingItems(byOid), store: embeddingStore, embedder,
          onProgress: ({ embedded }) => { current.embedded = embedded; },
        });
      } catch (err) {
        lastError = err.message || "Preparing swaps failed";
      } finally {
        job = null;
      }
    })();
    return current.promise;
  }

  async function status() {
    const { byOid, ai, pending } = await snapshot();
    const base = {
      profiled: 0, embedded: 0, total: byOid.size, pending: pending.length, estimate: null,
      aiAvailable: Boolean(ai), spend: { monthUsd: await usageLog.monthUsd() }, error: lastError,
    };
    if (ai && pending.length) {
      const batch = batchable(ai, pending.length);
      const usd = estimateProfileUsd(pending.length, ai.model, { batch });
      base.estimate = usd == null ? null : { usd: Math.round(usd * 100) / 100, model: ai.model, batch };
    }
    if (job) return { ...base, phase: job.phase, profiled: job.profiled, embedded: job.embedded, batch: Boolean(job.batch) };
    if (!byOid.size) return { ...base, phase: "idle" };
    if (lastError) return { ...base, phase: "error" };
    const autoPending = ai ? pending.filter((oid) => !skipped.has(oid)) : [];
    if (autoPending.length > PROFILE_AUTO_LIMIT) return { ...base, phase: "awaiting-confirmation" };
    const stale = await countStale({ items: await embeddingItems(byOid), store: embeddingStore });
    if (autoPending.length || stale) {
      start({ manual: false });
      return { ...base, phase: autoPending.length ? "profiling" : "embedding" };
    }
    return { ...base, phase: "ready" };
  }

  async function prepare() {
    start({ manual: true });
    return status();
  }

  async function swaps({ card, colorIdentity, deck }) {
    const st = await status();
    if (st.phase === "idle") return { httpStatus: 409, body: { error: "Upload your collection first.", status: st } };
    if (st.phase === "awaiting-confirmation") return { httpStatus: 409, body: { needsConfirmation: true, status: st } };
    if (st.phase === "profiling" || st.phase === "embedding") return { httpStatus: 202, body: { status: st } };
    if (st.phase === "error") return { httpStatus: 503, body: { error: st.error, status: st } };

    const { collection, byOid, ai } = await snapshot();
    let originalProfile = null;
    if (ai) {
      try { originalProfile = await profileOne(card, { store: profileStore, ai, usageLog }); } catch { originalProfile = null; }
    }
    const embedder = await getEmbedder();
    const [originalVector] = await embedder.embed([embeddingText(card, originalProfile)]);
    const candidates = filterCandidates({ original: card, allowedIdentity: colorIdentity, deckNames: deck?.cardNames, candidates: [...byOid.values()] });
    const vectors = new Map();
    const profiles = new Map();
    for (const c of candidates) {
      vectors.set(c.oracleId, (await embeddingStore.get(c.oracleId))?.v || null);
      profiles.set(c.oracleId, await profileStore.get(c.oracleId));
    }
    const short = shortlist({
      original: card, originalVector, originalProfile, candidates,
      vectorFor: (id) => vectors.get(id), profileFor: (id) => profiles.get(id),
    });
    if (!short.length) return { httpStatus: 200, body: { results: [], mode: ai ? "ai" : "local", cached: false } };
    if (!ai) return { httpStatus: 200, body: { results: finalizeLocal(short), mode: "local", cached: false } };

    const key = rankingCacheKey({
      originalOracleId: oracleIdOf(card), deckSignature: deck?.signature, gamePlan: deck?.gamePlan,
      syncedAt: collection.syncedAt, model: ai.model,
    });
    const hit = await rankingCache.get(key);
    if (hit) return { httpStatus: 200, body: { results: hit, mode: "ai", cached: true } };
    try {
      const req = buildRankRequest({ deck, original: card, originalProfile, shortlisted: short, profileFor: (id) => profiles.get(id) });
      const r = await ai.json({ system: req.system, cachedContext: req.cachedContext, user: req.user, maxTokens: 8000, effort: "medium", schema: RANK_SCHEMA });
      await recordUsage(usageLog, ai, "rank", r);
      const results = finalizeAi(short, parseRankResponse(r.data, req.ids));
      await rankingCache.set(key, results);
      return { httpStatus: 200, body: { results, mode: "ai", cached: false } };
    } catch (err) {
      if (err.usage) await recordUsage(usageLog, ai, "rank", err);
      return { httpStatus: 200, body: { results: finalizeLocal(short), mode: "local", cached: false, aiError: err.message || "AI ranking failed" } };
    }
  }

  const idle = async () => { while (job) await job.promise; };

  return { status, prepare, afterSync: status, swaps, idle };
}
