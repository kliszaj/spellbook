// Evaluates the pure analysis-helpers block from public/index.html (between the markers).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, run } from "./lib/tiny-test.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const BEGIN = "// @testable analysis-helpers begin";
const END = "// @testable analysis-helpers end";
if (!html.includes(BEGIN) || !html.includes(END)) throw new Error("analysis helper markers not found in public/index.html");
const block = html.split(BEGIN)[1].split(END)[0];
const h = Function(`${block}; return { gapSummary, chipGroups };`)();

// Mirrors the shape of a computeGrade(...) item, trimmed to the fields gapSummary and
// chipGroups actually read.
const item = (key, label, value, lo, hi, score, severity, overrides = {}) => ({
  key, label, value, lo, hi, score, severity,
  status: overrides.status || (score >= 1 ? "ok" : (hi != null && value > hi ? "high" : "low")),
  pass: score >= 1,
  valueLabel: String(value),
  target: hi != null ? `${lo}-${hi}` : `${lo}+`,
  ...overrides,
});

test("gapSummary orders worst-first and caps at maxGaps", () => {
  const items = [
    item("a", "A", 1, 5, null, 0.8, "minor"),
    item("b", "B", 0, 3, null, 0.0, "critical"),
    item("c", "C", 2, 8, null, 0.25, "major"),
    item("d", "D", 4, 8, null, 0.5, "major"),
  ];
  assert.equal(h.gapSummary(items, { total: 100 }), "Biggest gaps: B 0/3, C 2/8, D 4/8.");
});

test("gapSummary respects a custom maxGaps", () => {
  const items = [
    item("b", "B", 0, 3, null, 0.0, "critical"),
    item("c", "C", 2, 8, null, 0.25, "major"),
    item("d", "D", 4, 8, null, 0.5, "major"),
  ];
  assert.equal(h.gapSummary(items, { total: 100, maxGaps: 1 }), "Biggest gaps: B 0/3.");
});

test("gapSummary prefixes in-progress decks with cards to go", () => {
  const items = [item("lands", "Lands", 30, 36, 38, 0.6, "major")];
  assert.equal(h.gapSummary(items, { total: 72 }), "In progress — 28 cards to go. Biggest gaps: Lands 30/36.");
});

test("gapSummary reports on target when nothing fails", () => {
  const items = [item("lands", "Lands", 37, 36, 38, 1, "ok")];
  assert.equal(h.gapSummary(items, { total: 99 }), "On target across the board.");
  assert.equal(h.gapSummary([], { total: 99 }), "On target across the board.");
});

test("chipGroups merges color items into one short-colors chip, worst role first", () => {
  const items = [
    item("ramp", "Ramp", 5, 8, 12, 0.6, "major"),
    item("removal", "Removal", 7, 6, 10, 1, "ok"),
    item("source-W", "White sources", 3, 5, null, 0.6, "minor"),
    item("source-U", "Blue sources", 6, 5, null, 1, "ok"),
    item("source-B", "Black sources", 2, 5, null, 0.4, "major"),
  ];
  const { attention, onTarget } = h.chipGroups(items);
  assert.deepEqual(attention.map((c) => c.text), ["Ramp 5/8", "Colors short: W B"]);
  assert.deepEqual(onTarget.map((c) => c.text), ["Removal 7"]);
});

test("chipGroups reports a single Colors OK chip when every color is on target", () => {
  const items = [
    item("removal", "Removal", 7, 6, 10, 1, "ok"),
    item("source-W", "White sources", 6, 5, null, 1, "ok"),
    item("source-U", "Blue sources", 6, 5, null, 1, "ok"),
  ];
  const { attention, onTarget } = h.chipGroups(items);
  assert.deepEqual(attention, []);
  assert.deepEqual(onTarget.map((c) => c.text), ["Removal 7", "Colors OK"]);
});

await run("Deck analysis UI helpers");
