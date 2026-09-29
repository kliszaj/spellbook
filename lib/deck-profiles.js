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
  // Oracle ids the AI has already failed to profile (via runProfileJob's `failed`, which
  // means it omitted the card from its response twice). A card in here is excluded from
  // auto-profiling — every deck-signature change would otherwise re-pay to retry it — and
  // stays "missing" for lookup purposes until a manual confirm prepare retries it.
  const skipped = new Set();

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
    const skippedCount = missing.filter((oid) => skipped.has(oid)).length;
    const estimate = ai && missing.length
      ? { usd: round2(estimateProfileUsd(missing.length, ai.model)), model: ai.model }
      : null;
    return { profiles, missing, estimate, aiAvailable: Boolean(ai), skipped: skippedCount };
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
    // Auto-profiling (confirm: false) never retries a card already known to fail; a
    // manual confirm prepare retries everything still missing, skipped ids included.
    const toProfileOids = confirm ? missingOids : missingOids.filter((oid) => !skipped.has(oid));
    if (!toProfileOids.length) return lookup(cards); // everything missing is skipped — nothing to auto-retry
    if (toProfileOids.length > PROFILE_AUTO_LIMIT && !confirm) {
      return {
        needsConfirmation: true,
        estimate: { usd: round2(estimateProfileUsd(toProfileOids.length, ai.model)), model: ai.model },
        missing: toProfileOids.length,
        skipped: missingOids.length - toProfileOids.length,
      };
    }
    // Join an already-running job for any id another caller already claimed; only start
    // a job for the ids nobody is profiling yet.
    const toStart = toProfileOids.filter((oid) => !inFlight.has(oid));
    if (toStart.length) {
      const job = runProfileJob({
        cards: toStart.map((oid) => byOid.get(oid)),
        store: profileStore, ai, usageLog,
      }).then((result) => {
        const failedIds = new Set(result.failed || []);
        // A retried id that succeeds this time is no longer skipped; one that fails again
        // (or fails for the first time) is (re)marked so it isn't auto-retried next time.
        toStart.forEach((oid) => { if (failedIds.has(oid)) skipped.add(oid); else skipped.delete(oid); });
        return result;
      }).finally(() => { toStart.forEach((oid) => inFlight.delete(oid)); });
      toStart.forEach((oid) => inFlight.set(oid, job));
    }
    await Promise.all([...new Set(toProfileOids.map((oid) => inFlight.get(oid)).filter(Boolean))]);
    return lookup(cards);
  }

  return { lookup, prepare };
}
