// "Fix it before you see it": the AI writes a Scryfall query without seeing what Scryfall makes of it, so a
// syntax slip or an over-narrow query used to end in "No cards found". Before answering, the server runs the
// query once; on a syntax error or zero results it shows the AI Scryfall's answer and asks for one repair
// (fix the syntax, or widen the query and say what was dropped). Searches that work cost nothing extra.

const SEARCH_URL = "https://api.scryfall.com/cards/search";

// Runs a query on Scryfall and reports how it went:
//   { status: "ok", count } | { status: "empty", detail } | { status: "invalid", detail, count } | { status: "unknown" }
// Scryfall ignores terms it doesn't understand and only warns ("Invalid expression … was ignored"), so results
// with warnings are "invalid" too: the search ran, but not as the AI meant it.
// "unknown" (network trouble, rate limit, outage) means don't repair: the query may well be fine.
export async function checkScryfallQuery(query, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${SEARCH_URL}?q=${encodeURIComponent(query)}&unique=cards`, {
      headers: { "User-Agent": "Spellbook/0.1", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { status: "unknown" };
  }
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.ok) {
    const count = Number(body.total_cards) || 0;
    const warnings = Array.isArray(body.warnings) ? body.warnings.map(String).filter(Boolean) : [];
    return warnings.length ? { status: "invalid", detail: warnings.join(" ").slice(0, 400), count } : { status: "ok", count };
  }
  const detail = String(body.details || "").slice(0, 400);
  if (res.status === 404) return { status: "empty", detail };
  if (res.status === 400 || body.code === "bad_request") return { status: "invalid", detail };
  return { status: "unknown" };
}

export const REPAIR_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "The repaired Scryfall query (without f:commander, game:paper or id<= — those are added)." },
    note: { type: "string", description: "One short sentence for the user on what changed, e.g. 'Nothing matched the exact phrase, so I searched for any card that copies a spell.'" },
  },
  required: ["query", "note"],
  additionalProperties: false,
};

export function repairPrompt({ request, query, check }) {
  const problem = check.status === "invalid"
    ? `Scryfall rejected it as invalid: ${check.detail || "(no details)"}`
    : `Scryfall found no cards${check.detail ? ` (${check.detail})` : ""}.`;
  return [
    `The user asked: ${request}`,
    `You translated it to this Scryfall query: ${query}`,
    problem,
    "",
    check.status === "invalid"
      ? "Fix the syntax so it means what the user asked."
      : "Widen it so it finds cards that still fit the request: loosen exact phrases to key words, drop the least important condition, or use a broader type. Keep the user's colour, price and format limits.",
    "Return the new query (leave out f:commander, game:paper and id<=; they're added for you) and one short sentence telling the user what you changed.",
  ].join("\n");
}

// result: what the first translation returned. enforce(query) adds the Commander filters. ai({ user }) makes the
// repair call and returns { query, note }. Returns the result to send, with `repaired` when a repair was used.
export async function withSearchRepair({ result, request, enforce, check = checkScryfallQuery, ai }) {
  if (!result || result.type !== "query" || !result.query) return result;
  const first = await check(result.query);
  if (first.status === "ok") return { ...result, count: first.count };
  if (first.status === "unknown") return result;
  let fixed;
  try {
    fixed = await ai({ user: repairPrompt({ request, query: result.query, check: first }) });
  } catch {
    return { ...result, count: first.count || 0 }; // the repair failed: show the original answer as before
  }
  const query = enforce(String(fixed?.query || "").trim());
  if (!fixed?.query || query === result.query) return { ...result, count: first.count || 0 };
  const second = await check(query);
  if (second.status !== "ok" || second.count === 0) return { ...result, count: first.count || 0 };
  return {
    ...result,
    query,
    scryfallQuery: query,
    count: second.count,
    repaired: { from: result.query, note: String(fixed.note || "").trim().slice(0, 300), reason: first.status },
  };
}
