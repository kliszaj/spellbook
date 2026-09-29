// Evaluates the pure type/subtype filter helpers from public/index.html (between the markers).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, run } from "./lib/tiny-test.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const BEGIN = "// @testable type-helpers begin";
const END = "// @testable type-helpers end";
if (!html.includes(BEGIN) || !html.includes(END)) throw new Error("type-helpers markers not found in public/index.html");
const block = html.split(BEGIN)[1].split(END)[0];
const h = Function(`${block}; return { parseTypeLine, typeFacets, matchesTypeFilter, visibleSubtypes, invertTypeFilter };`)();

const card = (type_line, extra = {}) => ({ type_line, ...extra });

test("parseTypeLine: legendary creature with two subtypes", () => {
  const { types, subtypes } = h.parseTypeLine(card("Legendary Enchantment Creature — Spirit Shrine"));
  assert.deepEqual(types, new Set(["Enchantment", "Creature", "Legendary"]));
  assert.deepEqual(subtypes, new Set(["Spirit", "Shrine"]));
});

test("parseTypeLine: DFC combines types from both faces", () => {
  const dfc = card("Creature — Human Werewolf // Land", {
    card_faces: [
      { type_line: "Creature — Human Werewolf" },
      { type_line: "Land" },
    ],
  });
  const { types, subtypes } = h.parseTypeLine(dfc);
  assert.equal(types.has("Creature"), true);
  assert.equal(types.has("Land"), true);
  assert.deepEqual(subtypes, new Set(["Human", "Werewolf"]));
});

test("parseTypeLine: Tribal normalizes to Kindred", () => {
  const { types, subtypes } = h.parseTypeLine(card("Tribal Instant — Elf"));
  assert.deepEqual(types, new Set(["Kindred", "Instant"]));
  assert.deepEqual(subtypes, new Set(["Elf"]));
});

test("parseTypeLine: basic land has no Legendary supertype", () => {
  const { types, subtypes } = h.parseTypeLine(card("Basic Land — Island"));
  assert.deepEqual(types, new Set(["Land"]));
  assert.deepEqual(subtypes, new Set(["Island"]));
  assert.equal(types.has("Legendary"), false);
});

test("typeFacets: fixed type order, subtypes sorted by count desc then name", () => {
  const cards = [
    card("Creature — Shrine Spirit"),
    card("Creature — Shrine Spirit"),
    card("Enchantment — Shrine"),
    card("Enchantment — Aura"),
    card("Land — Island"),
  ];
  const facets = h.typeFacets(cards);
  assert.deepEqual(facets.types.map((f) => f.value), ["Creature", "Enchantment", "Land"]);
  assert.deepEqual(facets.types.map((f) => f.count), [2, 2, 1]);
  // Shrine: 3 (2 Creature + 1 Enchantment), Spirit: 2, Aura: 1, Island: 1 -> Aura before Island alphabetically.
  assert.deepEqual(facets.subtypes, [
    { value: "Shrine", count: 3 },
    { value: "Spirit", count: 2 },
    { value: "Aura", count: 1 },
    { value: "Island", count: 1 },
  ]);
});

test("matchesTypeFilter: OR within a row, AND across rows, empty filter passes everything", () => {
  const shrine = card("Legendary Enchantment Creature — Spirit Shrine");
  const aura = card("Enchantment — Aura");
  const elf = card("Tribal Instant — Elf");
  const empty = { types: new Set(), subtypes: new Set() };
  assert.equal(h.matchesTypeFilter(shrine, empty), true);
  assert.equal(h.matchesTypeFilter(aura, empty), true);

  const enchantmentOnly = { types: new Set(["Enchantment"]), subtypes: new Set() };
  assert.equal(h.matchesTypeFilter(shrine, enchantmentOnly), true);
  assert.equal(h.matchesTypeFilter(aura, enchantmentOnly), true);
  assert.equal(h.matchesTypeFilter(elf, enchantmentOnly), false);

  const enchantmentAndShrine = { types: new Set(["Enchantment"]), subtypes: new Set(["Shrine"]) };
  assert.equal(h.matchesTypeFilter(shrine, enchantmentAndShrine), true);
  assert.equal(h.matchesTypeFilter(aura, enchantmentAndShrine), false, "Aura is an Enchantment but not a Shrine");
  assert.equal(h.matchesTypeFilter(elf, enchantmentAndShrine), false);
});

const facet = (value, count) => ({ value, count });
const topTwelve = Array.from({ length: 12 }, (_, i) => facet(`Sub${i}`, 12 - i));

test("visibleSubtypes: expanded returns every facet regardless of selection", () => {
  const facets = [...topTwelve, facet("Rare", 1)];
  const selected = new Set();
  assert.deepEqual(h.visibleSubtypes(facets, selected, true, 12), facets);
});

test("visibleSubtypes: collapsed with nothing selected returns just the top `limit`", () => {
  const facets = [...topTwelve, facet("Rare", 1)];
  const selected = new Set();
  assert.deepEqual(h.visibleSubtypes(facets, selected, false, 12), topTwelve);
});

test("visibleSubtypes: collapsed keeps a selected subtype visible even past the top `limit`", () => {
  const facets = [...topTwelve, facet("Rare", 1)];
  const selected = new Set(["Rare"]);
  const visible = h.visibleSubtypes(facets, selected, false, 12);
  assert.deepEqual(visible, [...topTwelve, facet("Rare", 1)]);
});

test("visibleSubtypes: collapsed selection already within the top `limit` doesn't duplicate it", () => {
  const facets = [...topTwelve, facet("Rare", 1)];
  const selected = new Set(["Sub0"]);
  const visible = h.visibleSubtypes(facets, selected, false, 12);
  assert.deepEqual(visible, topTwelve);
});

test("invertTypeFilter: flips only rows that have a selection", () => {
  const facets = { types: [facet("Creature", 3), facet("Land", 2), facet("Instant", 1)], subtypes: [facet("Elf", 1)] };
  const filter = { types: new Set(["Land"]), subtypes: new Set(), expanded: false };
  h.invertTypeFilter(filter, facets);
  assert.deepEqual(filter.types, new Set(["Creature", "Instant"]));
  assert.deepEqual(filter.subtypes, new Set());
});

await run("Type/subtype filter helpers");
