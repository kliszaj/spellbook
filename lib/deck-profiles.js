import { estimateProfileUsd, oracleIdOf, runProfileJob } from "./profiles.js";
import { PROFILE_AUTO_LIMIT } from "./swaps-service.js";

function round2(usd) {
  return usd == null ? null : Math.round(usd * 100) / 100;
}

// One representative card per oracle id, in first-seen order.
function dedupeByOracleId(cards) {
  const byOid = new Map();
  for (const card of cards || []) {
    const oid = oracleIdOf(card);
    if (oid && !byOid.has(oid)) byOid.set(oid, card);
  }
  return byOid;
}

// Profiles for deck cards from the shared profile store, with a rule-based-fallback-aware
// "missing" list and a spend estimate for profiling what's missing. Single-flight per oracle
// id: a `prepare` already profiling an id is awaited by later callers instead of re-profiling it.
export function createDeckProfiles({ profileStore, getAi, usageLog }) {
  const inFlight = new Map(); // oracleId -> shared job promise

  async function lookup(cards) {
    const ai = await getAi();
    const byOid = dedupeByOracleId(cards);
    const profiles = {};
    const missing = [];
    for (const [oid] of byOid) {
      const profile = await profileStore.get(oid);
      if (profile) profiles[oid] = profile;
      else missing.push(oid);
    }
    const estimate = ai && missing.length
      ? { usd: round2(estimateProfileUsd(missing.length, ai.model)), model: ai.model }
      : null;
    return { profiles, missing, estimate, aiAvailable: Boolean(ai) };
  }

  async function prepare(cards, { confirm = false } = {}) {
    const ai = await getAi();
    if (!ai) return { error: "no-ai" };
    const byOid = dedupeByOracleId(cards);
    const missingOids = [];
    for (const [oid] of byOid) {
      if (!(await profileStore.get(oid))) missingOids.push(oid);
    }
    if (!missingOids.length) return lookup(cards);
    if (missingOids.length > PROFILE_AUTO_LIMIT && !confirm) {
      return { needsConfirmation: true, estimate: { usd: round2(estimateProfileUsd(missingOids.length, ai.model)), model: ai.model }, missing: missingOids.length };
    }
    // Join an already-running job for any id another caller already claimed; only start
    // a job for the ids nobody is profiling yet.
    const toStart = missingOids.filter((oid) => !inFlight.has(oid));
    if (toStart.length) {
      const job = runProfileJob({
        cards: toStart.map((oid) => byOid.get(oid)),
        store: profileStore, ai, usageLog,
      }).finally(() => { toStart.forEach((oid) => inFlight.delete(oid)); });
      toStart.forEach((oid) => inFlight.set(oid, job));
    }
    await Promise.all([...new Set(missingOids.map((oid) => inFlight.get(oid)).filter(Boolean))]);
    return lookup(cards);
  }

  return { lookup, prepare };
}
