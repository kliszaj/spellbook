import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";
import { priceUsd } from "./ai-client.js";

// Bump when PROFILE_SYSTEM_PROMPT or MECHANICS change meaning: every profile is regenerated.
export const PROMPT_VERSION = 1;
export const PROFILE_BATCH_SIZE = 25;
// Average tokens per card in one batched profiling request, measured in the
// 2026-09-27 pilot (claude-sonnet-5, 25-card batches). Used for the cost estimate before Start.
export const PROFILE_TOKENS_PER_CARD = { input: 160, output: 100 };

export const MECHANICS = [
  "flicker", "etb-value", "trigger-doubling", "ramp", "fast-mana", "mana-fixing", "cost-reduction", "untap",
  "card-draw", "card-selection", "tutor", "spot-removal", "board-wipe", "bounce", "counterspell", "protection",
  "pillowfort", "stax", "recursion", "reanimation", "self-mill", "graveyard-hate", "tokens", "plus-one-counters",
  "sacrifice-outlet", "death-trigger", "lifegain", "drain", "evasion", "combat-trick", "anthem", "copy", "theft",
  "extra-turn", "wincon", "enchantment-matters", "artifact-matters", "legends-matter", "tribal", "spellslinger",
  "landfall", "land", "vanilla",
];
const MECHANIC_SET = new Set(MECHANICS);

export const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          summary: { type: "string" },
          mechanics: { type: "array", items: { type: "string", enum: MECHANICS } },
          synergies: { type: "array", items: { type: "string" } },
        },
        required: ["id", "summary", "mechanics", "synergies"],
        additionalProperties: false,
      },
    },
  },
  required: ["cards"],
  additionalProperties: false,
};

export const PROFILE_SYSTEM_PROMPT = `You profile Magic: The Gathering cards for Commander (EDH) deckbuilding. For each card, describe what it actually does and why a Commander deck plays it. Judge by function, not wording: a card that exiles your own creature and returns it is flicker, not removal.

Input lines look like: <id>: <name> | <mana cost> | <type line> | <rules text> | <power/toughness>. Multi-faced cards list their faces separated by " // ".

Respond with ONLY minified JSON, no prose or code fences:
{"cards":[{"id":"c1","summary":"...","mechanics":["..."],"synergies":["..."]}]}
- id: the exact id from the input line. Return exactly one entry per input card.
- summary: 1-2 sentences, under 220 characters, plain language: the effect and the job it does in a deck. Do not repeat the card name or mana cost.
- mechanics: 1-5 tags chosen ONLY from this list: ${MECHANICS.join(", ")}. Use "vanilla" only for cards with no rules text.
- synergies: up to 4 short phrases (under 50 characters each) naming what the card rewards or enables, e.g. "creatures with enters-the-battlefield abilities".`;

export function oracleIdOf(card) {
  return card?.oracle_id || card?.card_faces?.[0]?.oracle_id || null;
}

export function cardPromptLine(card, id) {
  const faces = !card.oracle_text && Array.isArray(card.card_faces) && card.card_faces.length ? card.card_faces : [card];
  const text = faces
    .map((f) => [
      f.name !== card.name ? f.name : "",
      f.mana_cost,
      f.type_line,
      String(f.oracle_text || "").replace(/\s+/g, " ").trim(),
      f.power != null ? `${f.power}/${f.toughness}` : "",
    ].filter(Boolean).join(" | "))
    .join(" // ");
  return `${id}: ${card.name} | ${text}`;
}

export function buildProfileRequest(cards) {
  const ids = new Map();
  const lines = cards.map((card, i) => {
    const id = `c${i + 1}`;
    ids.set(id, oracleIdOf(card));
    return cardPromptLine(card, id);
  });
  return { user: `Profile these ${cards.length} cards:\n${lines.join("\n")}`, ids };
}

export function normalizeProfile(raw, model) {
  if (!raw || typeof raw !== "object") return null;
  const summary = String(raw.summary || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!summary) return null;
  const mechanics = [...new Set((Array.isArray(raw.mechanics) ? raw.mechanics : [])
    .map((m) => String(m).trim().toLowerCase())
    .filter((m) => MECHANIC_SET.has(m)))].slice(0, 5);
  const synergies = (Array.isArray(raw.synergies) ? raw.synergies : [])
    .map((s) => String(s).replace(/\s+/g, " ").trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 4);
  return { summary, mechanics, synergies, model };
}

export function parseProfileResponse(data, ids, model) {
  const profiles = {};
  for (const item of Array.isArray(data?.cards) ? data.cards : []) {
    const oracleId = ids.get(String(item?.id || "").trim());
    const profile = oracleId ? normalizeProfile(item, model) : null;
    if (profile) profiles[oracleId] = profile;
  }
  const missing = [...ids.values()].filter((oid) => !profiles[oid]);
  return { profiles, missing };
}

export function estimateProfileUsd(count, model) {
  return priceUsd(model, {
    inputTokens: count * PROFILE_TOKENS_PER_CARD.input,
    outputTokens: count * PROFILE_TOKENS_PER_CARD.output,
  });
}

export function createProfileStore({ dataDir }) {
  const path = join(dataDir, "card-profiles.json");
  let loading = null;
  let chain = Promise.resolve();

  // Concurrent cold calls must all await the same read instead of each racing past
  // "not loaded yet" and clobbering one another's in-memory object once it resolves.
  function load() {
    if (!loading) {
      loading = (async () => {
        const raw = await readJson(path, null);
        return raw && raw.promptVersion === PROMPT_VERSION
          ? { promptVersion: PROMPT_VERSION, profiles: raw.profiles || {} }
          : { promptVersion: PROMPT_VERSION, profiles: {} };
      })();
      loading.catch(() => { loading = null; });
    }
    return loading;
  }

  const get = async (oracleId) => (await load()).profiles[oracleId] || null;

  async function pending(oracleIds) {
    const { profiles } = await load();
    return oracleIds.filter((id) => !profiles[id]);
  }

  function saveMany(profiles) {
    const run = chain.then(async () => {
      const data = await load();
      Object.assign(data.profiles, profiles);
      await writeJsonAtomic(path, data);
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  return { load, get, pending, saveMany };
}

const NO_RETRY_STATUSES = new Set([400, 401, 403, 404]);

async function recordUsage(usageLog, ai, r) {
  await usageLog?.record({ feature: "profile", provider: ai.provider, model: ai.model, ...r.usage, usd: r.usd });
}

// A failed attempt that still carries usage (the API answered but the content was
// refused/truncated/unparseable) was billed and must be recorded even though it is
// discarded here; an attempt with no usage never reached billing.
async function withOneRetry(fn, onBilledFailure) {
  try {
    return await fn();
  } catch (err) {
    if (err.usage) await onBilledFailure(err);
    if (NO_RETRY_STATUSES.has(err.status)) throw err;
    try {
      return await fn();
    } catch (err2) {
      if (err2.usage) await onBilledFailure(err2);
      throw err2;
    }
  }
}

// Profiles `cards` (one representative card per oracle id, all still unprofiled).
// A card the AI leaves out is retried once in a later batch, then reported as failed.
// A failing request is retried once; a second failure aborts the job (progress is saved).
export async function runProfileJob({ cards, store, ai, usageLog, onProgress = () => {} }) {
  const queue = cards.slice();
  const retried = new Set();
  const failed = [];
  let profiled = 0;
  while (queue.length) {
    const batch = queue.splice(0, PROFILE_BATCH_SIZE);
    const req = buildProfileRequest(batch);
    const r = await withOneRetry(
      () => ai.json({ system: PROFILE_SYSTEM_PROMPT, user: req.user, maxTokens: 16000, effort: "low", schema: PROFILE_SCHEMA }),
      (err) => recordUsage(usageLog, ai, err),
    );
    await recordUsage(usageLog, ai, r);
    const { profiles, missing } = parseProfileResponse(r.data, req.ids, ai.model);
    await store.saveMany(profiles);
    profiled += Object.keys(profiles).length;
    for (const oid of missing) {
      if (retried.has(oid)) failed.push(oid);
      else {
        retried.add(oid);
        queue.push(batch.find((c) => oracleIdOf(c) === oid));
      }
    }
    onProgress({ profiled });
  }
  return { profiled, failed };
}

export async function profileOne(card, { store, ai, usageLog }) {
  const oid = oracleIdOf(card);
  if (!oid) return null;
  const existing = await store.get(oid);
  if (existing) return existing;
  const req = buildProfileRequest([card]);
  let r;
  try {
    r = await ai.json({ system: PROFILE_SYSTEM_PROMPT, user: req.user, maxTokens: 4000, effort: "low", schema: PROFILE_SCHEMA });
  } catch (err) {
    if (err.usage) await recordUsage(usageLog, ai, err);
    throw err;
  }
  await recordUsage(usageLog, ai, r);
  const { profiles } = parseProfileResponse(r.data, req.ids, ai.model);
  await store.saveMany(profiles);
  return profiles[oid] || null;
}
