// Evaluates the query-chip helpers from the web client (between the @testable query-chips markers).
import assert from "node:assert/strict";
import { test, run } from "./lib/tiny-test.mjs";
import { readAppSource } from "./lib/app-source.mjs";

const html = readAppSource();
const BEGIN = "// @testable query-chips begin";
const END = "// @testable query-chips end";
if (!html.includes(BEGIN) || !html.includes(END)) throw new Error("query-chips markers not found in the web client source");
const block = html.split(BEGIN)[1].split(END)[0];
const h = Function(`${block}; return { queryChips, rebuildQuery, describeQueryTerm };`)();

const labels = (core) => h.queryChips(core).map((c) => `${c.key}: ${c.label}`);

test("common conditions get plain-English labels", () => {
  assert.deepEqual(labels('t:creature o:"creatures you control" keyword:trample mv<=3 eur<=2 c:rg -t:legendary'), [
    "Type: Creature",
    "Text: “creatures you control”",
    "Keyword: Trample",
    "Mana value: ≤ 3",
    "Price: ≤ €2",
    "Colour: Red + Green",
    "Not type: Legendary",
  ]);
});

test("a parenthesised group stays one chip; a top-level or keeps the whole query as one chip", () => {
  assert.deepEqual(labels("(t:instant or t:sorcery) o:counter"), ["Any of: t:instant / t:sorcery", 'Text: “counter”']);
  assert.deepEqual(labels("t:instant or t:sorcery"), ["Any of: t:instant / t:sorcery"]);
});

test("sort terms aren't conditions, so they get no chip", () => {
  assert.deepEqual(labels("t:goblin order:eur direction:asc"), ["Type: Goblin"]);
});

test("unknown keys and bare words still show, as written", () => {
  assert.deepEqual(labels("pt>=10 sliver"), ["pt: ≥ 10", "Name: sliver"]);
});

test("switching chips off and adding presets rebuilds the query", () => {
  const chips = h.queryChips('t:creature o:"creatures you control" o:trample');
  assert.equal(h.rebuildQuery(chips), 't:creature o:"creatures you control" o:trample');
  assert.equal(h.rebuildQuery(chips, new Set(["t:creature"])), 'o:"creatures you control" o:trample');
  assert.equal(h.rebuildQuery(chips, new Set(["t:creature"]), ["eur<=2"]), 'o:"creatures you control" o:trample eur<=2');
  assert.equal(h.rebuildQuery(chips, new Set(chips.map((c) => c.term))), "");
});

test("a colour identity limit reads as \"within\"", () => {
  assert.deepEqual(h.describeQueryTerm("id<=rg"), { key: "Identity", label: "within Red + Green" });
});

test("empty input gives no chips", () => {
  assert.deepEqual(h.queryChips(""), []);
  assert.deepEqual(h.queryChips("   "), []);
});

await run("Query chips");
