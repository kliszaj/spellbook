// Shared Scryfall /cards/collection helper: retries on 429 (rate limit), used by
// both the app (lib/collection-store.js) and the pilot script.
export class ScryfallError extends Error {}

export const SCRYFALL_COLLECTION_URL = "https://api.scryfall.com/cards/collection";
export const MAX_RETRY_WAIT_MS = 10_000;

export async function postCardCollection(
  identifiers,
  { fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxRetries = 2 } = {},
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
    if (res.status === 429 && attempt < maxRetries) {
      attempt++;
      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_WAIT_MS) : 1000;
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) throw new ScryfallError("Couldn't reach Scryfall. Try again.");
    try {
      return await res.json();
    } catch {
      throw new ScryfallError("Couldn't reach Scryfall. Try again.");
    }
  }
}
