// The AI search repair step (lib/search-repair.js), with a fake Scryfall and a fake AI: no network, no spend.
import assert from "node:assert/strict";
import { test, run } from "./lib/tiny-test.mjs";
import { withSearchRepair, checkScryfallQuery, repairPrompt } from "../lib/search-repair.js";

const enforce = (q) => `${q} f:commander game:paper`;
const scryfall = (answers) => async (query) => answers[query] ?? { status: "empty", detail: "" };
const queryResult = (query) => ({ type: "query", query, scryfallQuery: query });

test("a query that finds cards is returned unchanged, with no AI call", async () => {
  let calls = 0;
  const out = await withSearchRepair({
    result: queryResult("t:goblin f:commander game:paper"), request: "goblins", enforce,
    check: scryfall({ "t:goblin f:commander game:paper": { status: "ok", count: 412 } }),
    ai: async () => { calls++; return {}; },
  });
  assert.equal(calls, 0);
  assert.equal(out.query, "t:goblin f:commander game:paper");
  assert.equal(out.count, 412);
  assert.equal(out.repaired, undefined);
});

test("zero results: the AI widens the query once and the note explains it", async () => {
  let prompt = "";
  const out = await withSearchRepair({
    result: queryResult('o:"copy target instant or sorcery spell" eur<=1 f:commander game:paper'),
    request: "cheap cards that copy spells for under a euro", enforce,
    check: scryfall({ "o:copy o:spell eur<=1 f:commander game:paper": { status: "ok", count: 6 } }),
    ai: async ({ user }) => { prompt = user; return { query: "o:copy o:spell eur<=1", note: "Nothing matched the exact phrase, so I searched for any card that copies a spell." }; },
  });
  assert.match(prompt, /found no cards/);
  assert.equal(out.query, "o:copy o:spell eur<=1 f:commander game:paper");
  assert.equal(out.count, 6);
  assert.equal(out.repaired.from, 'o:"copy target instant or sorcery spell" eur<=1 f:commander game:paper');
  assert.equal(out.repaired.reason, "empty");
  assert.match(out.repaired.note, /exact phrase/);
});

test("a syntax error is shown to the AI and fixed", async () => {
  let prompt = "";
  const out = await withSearchRepair({
    result: queryResult("t:creature pow>>3 f:commander game:paper"), request: "big creatures", enforce,
    check: scryfall({
      "t:creature pow>>3 f:commander game:paper": { status: "invalid", detail: "pow>>3 is not a valid comparison" },
      "t:creature pow>=4 f:commander game:paper": { status: "ok", count: 900 },
    }),
    ai: async ({ user }) => { prompt = user; return { query: "t:creature pow>=4", note: "Fixed a typo in the power filter." }; },
  });
  assert.match(prompt, /rejected it as invalid: pow>>3 is not a valid comparison/);
  assert.equal(out.repaired.reason, "invalid");
  assert.equal(out.count, 900);
});

test("terms Scryfall ignored (warnings) get one repair; if it doesn't help, the original results stay", async () => {
  const warned = { status: "invalid", detail: "Invalid expression “foo:bar” was ignored.", count: 561 };
  const out = await withSearchRepair({
    result: queryResult("t:goblin foo:bar f:commander game:paper"), request: "goblins", enforce,
    check: scryfall({ "t:goblin foo:bar f:commander game:paper": warned }),
    ai: async () => ({ query: "t:goblin nonsense", note: "x" }),
  });
  assert.equal(out.query, "t:goblin foo:bar f:commander game:paper");
  assert.equal(out.count, 561);
});

test("if the repair still finds nothing, the original answer is kept", async () => {
  const out = await withSearchRepair({
    result: queryResult("a f:commander game:paper"), request: "x", enforce,
    check: scryfall({}), ai: async () => ({ query: "b", note: "widened" }),
  });
  assert.equal(out.query, "a f:commander game:paper");
  assert.equal(out.repaired, undefined);
  assert.equal(out.count, 0);
});

test("a failed repair call keeps the original answer instead of failing the search", async () => {
  const out = await withSearchRepair({
    result: queryResult("a f:commander game:paper"), request: "x", enforce,
    check: scryfall({}), ai: async () => { throw new Error("AI down"); },
  });
  assert.equal(out.query, "a f:commander game:paper");
  assert.equal(out.repaired, undefined);
});

test("when Scryfall can't be reached, no repair is attempted", async () => {
  let calls = 0;
  const out = await withSearchRepair({
    result: queryResult("a f:commander game:paper"), request: "x", enforce,
    check: async () => ({ status: "unknown" }), ai: async () => { calls++; return {}; },
  });
  assert.equal(calls, 0);
  assert.equal(out.query, "a f:commander game:paper");
});

test("curated picks (not a query) pass straight through", async () => {
  const picks = { type: "cards", summary: "s", cards: [{ name: "Sol Ring" }] };
  assert.equal(await withSearchRepair({ result: picks, request: "x", enforce, check: async () => { throw new Error("no"); }, ai: async () => ({}) }), picks);
});

test("checkScryfallQuery reads Scryfall's answers", async () => {
  const respond = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  assert.deepEqual(await checkScryfallQuery("q", { fetchImpl: respond(200, { total_cards: 7 }) }), { status: "ok", count: 7 });
  assert.deepEqual(await checkScryfallQuery("q", { fetchImpl: respond(404, { details: "Your query didn't match any cards." }) }), { status: "empty", detail: "Your query didn't match any cards." });
  assert.deepEqual(await checkScryfallQuery("q", { fetchImpl: respond(400, { code: "bad_request", details: "bad" }) }), { status: "invalid", detail: "bad" });
  assert.deepEqual(await checkScryfallQuery("q", { fetchImpl: respond(200, { total_cards: 9, warnings: ["Invalid expression “x:y” was ignored."] }) }), { status: "invalid", detail: "Invalid expression “x:y” was ignored.", count: 9 });
  assert.deepEqual(await checkScryfallQuery("q", { fetchImpl: respond(429, {}) }), { status: "unknown" });
  assert.deepEqual(await checkScryfallQuery("q", { fetchImpl: async () => { throw new Error("offline"); } }), { status: "unknown" });
});

test("the repair prompt keeps the user's limits", () => {
  const p = repairPrompt({ request: "cheap red burn", query: "q", check: { status: "empty", detail: "" } });
  assert.match(p, /Keep the user's colour, price and format limits/);
  assert.match(p, /leave out f:commander/);
});

await run("Search repair");
