// Shared Scryfall /cards/collection helper: retries on 429 (rate limit), used by
// both the app (lib/collection-store.js) and the pilot script.
export class ScryfallError extends Error {}

export const SCRYFALL_COLLECTION_URL = "https://api.scryfall.com/cards/collection";
export const MAX_RETRY_WAIT_MS = 120_000;
const DEFAULT_RETRY_WAIT_MS = 60_000; // used when Retry-After is missing or invalid

// Module-level cooldown shared by every caller: once Scryfall 429s, later calls
// short-circuit without hitting the network until this timestamp passes, so a
// burst of requests right after a 429 doesn't all get rate-limited again.
let blockedUntil = 0;

// Test-only: clears the cooldown between fake-driven tests.
export function resetScryfallBlock() {
  blockedUntil = 0;
}

export async function postCardCollection(
  identifiers,
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxRetries = 1,
    now = () => Date.now(),
  } = {},
) {
  if (now() < blockedUntil) {
    throw new ScryfallError("Scryfall is rate-limiting — try again in a minute.");
  }
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetchImpl(SCRYFALL_COLLECTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Spellbook/0.1" },
        body: JSON.stringify({ identifiers }),
      });
    } catch {
      throw new ScryfallError("Couldn't reach Scryfall. Try again.");
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      // Uncapped: the cooldown reflects Scryfall's real penalty window, however long.
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_RETRY_WAIT_MS;
      blockedUntil = Math.max(blockedUntil, now() + waitMs);
      // Only retry inside this request when the wait fits under the cap; a longer
      // wait isn't worth blocking on here — the cooldown above covers it instead.
      if (attempt < maxRetries && waitMs <= MAX_RETRY_WAIT_MS) {
        attempt++;
        await sleep(waitMs);
        continue;
      }
      throw new ScryfallError("Scryfall is rate-limiting — try again in a minute.");
    }
    if (!res.ok) throw new ScryfallError("Couldn't reach Scryfall. Try again.");
    try {
      return await res.json();
    } catch {
      throw new ScryfallError("Couldn't reach Scryfall. Try again.");
    }
  }
}
