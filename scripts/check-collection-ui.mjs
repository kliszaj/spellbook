// Evaluates the pure helper block from public/index.html (between the markers).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, run } from "./lib/tiny-test.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const BEGIN = "// @testable collection-helpers begin";
const END = "// @testable collection-helpers end";
if (!html.includes(BEGIN) || !html.includes(END)) throw new Error("collection helper markers not found in public/index.html");
const block = html.split(BEGIN)[1].split(END)[0];
const h = Function(`${block}; return { buildCollectionIndex, ownedQty, filterCollectionItems, sortCollectionItems, collectionTotals, deckColorMatch, ownCount };`)();

const card = (id, name, extra = {}) => ({ id, oracle_id: `o-${name}`, name, cmc: 2, color_identity: ["W"], prices: { eur: "1.00", eur_foil: "3.00" }, ...extra });
const data = {
  syncedAt: "2026-09-27T00:00:00.000Z",
  entries: {
    "a|normal|Main": { scryfallId: "a", foil: "normal", binder: "Main", qty: 2 },
    "a2|foil|Trade ": { scryfallId: "a2", foil: "foil", binder: "Trade ", qty: 1 },
    "b|normal|Main": { scryfallId: "b", foil: "normal", binder: "Main", qty: 1 },
    "x|normal|Main": { scryfallId: "x", foil: "normal", binder: "Main", qty: 4 },
  },
  cards: {
    a: card("a", "Alpha Strike"),
    a2: card("a2", "Alpha Strike"),
    b: card("b", "Blue Thing", { color_identity: ["U"], cmc: 1, prices: { eur: "5.00" } }),
  },
};
const index = h.buildCollectionIndex(data);

test("buildCollectionIndex groups printings by oracle id", () => {
  assert.equal(index.list.length, 2);
  const alpha = index.byOracle.get("o-Alpha Strike");
  assert.equal(alpha.qty, 3);
  assert.deepEqual(alpha.scryfallIds, ["a", "a2"]);
  assert.deepEqual([...alpha.binders].sort(), ["Main", "Trade"]);
});

test("ownedQty matches any printing", () => {
  assert.equal(h.ownedQty(index, card("zzz", "Alpha Strike")), 3);
  assert.equal(h.ownedQty(index, card("q", "Unknown")), 0);
  assert.equal(h.ownedQty(null, card("q", "Unknown")), 0);
});

test("filterCollectionItems: name, fits-within colors, binder", () => {
  const names = (items) => items.map((it) => it.card.name).sort();
  assert.deepEqual(names(h.filterCollectionItems(index.list, { query: "blue" })), ["Blue Thing"]);
  assert.deepEqual(names(h.filterCollectionItems(index.list, { colors: ["W"] })), ["Alpha Strike"]);
  assert.deepEqual(names(h.filterCollectionItems(index.list, { colors: ["W", "U"] })), ["Alpha Strike", "Blue Thing"]);
  assert.deepEqual(names(h.filterCollectionItems(index.list, { binder: "Trade" })), ["Alpha Strike"]);
});

test("sortCollectionItems by name, price and mana value", () => {
  const order = (field) => h.sortCollectionItems(index.list, field).map((it) => it.card.name);
  assert.deepEqual(order("name"), ["Alpha Strike", "Blue Thing"]);
  assert.deepEqual(order("price"), ["Blue Thing", "Alpha Strike"]);
  assert.deepEqual(order("cmc"), ["Blue Thing", "Alpha Strike"]);
});

test("collectionTotals counts matched cards and prices foils as foil", () => {
  assert.deepEqual(h.collectionTotals(data, index), { unique: 2, copies: 4, value: 2 * 1 + 1 * 3 + 5 });
});

test("deckColorMatch uses contains semantics with a Colorless option", () => {
  const sel = (...c) => new Set(c);
  assert.equal(h.deckColorMatch({ color_identity: ["W", "U"] }, sel("U")), true);
  assert.equal(h.deckColorMatch({ color_identity: ["W"] }, sel("U")), false);
  assert.equal(h.deckColorMatch({ color_identity: [] }, sel("C")), true);
  assert.equal(h.deckColorMatch({ color_identity: [] }, sel("W")), false);
  assert.equal(h.deckColorMatch({ color_identity: ["W"] }, sel()), true);
});

test("ownCount counts distinct owned cards", () => {
  const deck = [card("d1", "Alpha Strike"), card("d2", "Alpha Strike"), card("d3", "Missing Card")];
  assert.deepEqual(h.ownCount(index, deck), { owned: 1, total: 2 });
});

await run("Collection UI helpers");
