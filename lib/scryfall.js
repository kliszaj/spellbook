// Shared Scryfall /cards/collection helper: retries on 429 (rate limit), used by
// both the app (lib/collection-store.js) and the pilot script.
export class ScryfallError extends Error {}

export const SCRYFALL_COLLECTION_URL = "https://api.scryfall.com/cards/collection";
export const MAX_RETRY_WAIT_MS = 120_000;
const DEFAULT_RETRY_WAIT_MS = 60_000; // used when Retry-After is missing or invalid

export async function postCardCollection(
  identifiers,
  { fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxRetries = 1 } = {},
) {
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
      if (attempt < maxRetries) {
        attempt++;
        const retryAfter = Number(res.headers.get("Retry-After"));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS) : DEFAULT_RETRY_WAIT_MS;
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
