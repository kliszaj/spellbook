// Evaluates the pure analysis-helpers block from public/index.html (between the markers).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, run } from "./lib/tiny-test.mjs";
import { commanderSlug as serverCommanderSlug } from "../lib/edhrec.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const BEGIN = "// @testable analysis-helpers begin";
const END = "// @testable analysis-helpers end";
if (!html.includes(BEGIN) || !html.includes(END)) throw new Error("analysis helper markers not found in public/index.html");
const block = html.split(BEGIN)[1].split(END)[0];
const h = Function(`${block}; return { gapSummary, chipGroups, rolesFromProfile, isWincon, hypergeomAtLeast, openingHandOdds, drawRandom, commanderSlug, edhrecPicks };`)();

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

const profileCard = (typeLine, oracleText, extra = {}) => ({ type_line: typeLine, oracle_text: oracleText, ...extra });
const profile = (mechanics, extra = {}) => ({ summary: "Test summary.", mechanics, synergies: [], model: "claude-sonnet-5", ...extra });

test("rolesFromProfile: a blink card (flicker/etb-value, instant) is not removal or interaction", () => {
  const card = profileCard("Instant", "Exile target creature you control, then return it to the battlefield.");
  const roles = h.rolesFromProfile(card, profile(["flicker", "etb-value"]));
  assert.equal(roles.removal, undefined);
  assert.equal(roles.interaction, undefined);
});

test("rolesFromProfile: spot-removal at instant speed is removal + interaction", () => {
  const card = profileCard("Instant", "Destroy target creature.");
  const roles = h.rolesFromProfile(card, profile(["spot-removal"]));
  assert.ok(roles.removal);
  assert.equal(roles.removal.instant, true);
  assert.ok(roles.interaction);
});

test("rolesFromProfile: spot-removal at sorcery speed is removal only", () => {
  const card = profileCard("Sorcery", "Destroy target creature.");
  const roles = h.rolesFromProfile(card, profile(["spot-removal"]));
  assert.ok(roles.removal);
  assert.equal(roles.removal.instant, false);
  assert.equal(roles.interaction, undefined);
});

test("rolesFromProfile: counterspell is interaction", () => {
  const card = profileCard("Instant", "Counter target spell.");
  const roles = h.rolesFromProfile(card, profile(["counterspell"]));
  assert.ok(roles.interaction);
});

test("rolesFromProfile: card-draw is draw", () => {
  const card = profileCard("Sorcery", "Draw a card for each Shrine you control.");
  const roles = h.rolesFromProfile(card, profile(["card-draw"]));
  assert.ok(roles.draw);
});

test("rolesFromProfile: removal target types still come from the rules text", () => {
  const card = profileCard("Instant", "Destroy target creature or planeswalker.");
  const roles = h.rolesFromProfile(card, profile(["spot-removal"]));
  assert.deepEqual(new Set(roles.removal.targets), new Set(["creature", "planeswalker"]));
});

test("isWincon: true only when the profile is tagged wincon", () => {
  assert.equal(h.isWincon(profile(["wincon"])), true);
  assert.equal(h.isWincon(profile(["card-draw"])), false);
  assert.equal(h.isWincon(null), false);
});

// The brief's worked example (~0.605) doesn't match the exact hypergeometric value for
// N=99,K=36,n=7,k=3 — cross-checked independently with exact BigInt binomial coefficients,
// which agree with hypergeomAtLeast to ~1e-14 and land at ~0.501, not ~0.605. Pinning the
// verified value here; flagged for the reviewer in the task report.
test("hypergeomAtLeast: 99-card library, 36 lands, 7-card hand, P(>=3 lands) ≈ 0.501", () => {
  const p = h.hypergeomAtLeast(99, 36, 7, 3);
  assert.ok(Math.abs(p - 0.501) <= 0.01, `expected ~0.501, got ${p}`);
});

test("hypergeomAtLeast: k <= 0 is a certainty", () => {
  assert.equal(h.hypergeomAtLeast(99, 36, 7, 0), 1);
  assert.equal(h.hypergeomAtLeast(99, 36, 7, -2), 1);
});

test("hypergeomAtLeast: no successes in the pool makes any k >= 1 impossible", () => {
  assert.equal(h.hypergeomAtLeast(99, 0, 7, 1), 0);
});

test("hypergeomAtLeast: drawing the whole population guarantees exactly K successes", () => {
  assert.equal(h.hypergeomAtLeast(99, 36, 99, 36), 1);
});

test("hypergeomAtLeast: always returns a probability in [0, 1]", () => {
  for (const [N, K, n, k] of [[99, 36, 7, 3], [99, 10, 7, 5], [40, 15, 7, 2], [99, 99, 7, 7]]) {
    const p = h.hypergeomAtLeast(N, K, n, k);
    assert.ok(p >= 0 && p <= 1, `${N},${K},${n},${k} -> ${p}`);
  }
});

test("openingHandOdds: keepable stays in [0,1] and tracks landsIn7 minus the P(>=6) tail", () => {
  const N = 99, lands = 36;
  const odds = h.openingHandOdds({ N, lands, ramp: 8 });
  assert.ok(odds.keepableLands >= 0 && odds.keepableLands <= 1);
  const atLeast6 = h.hypergeomAtLeast(N, lands, 7, 6);
  assert.ok(odds.keepableLands >= odds.landsIn7 - atLeast6 - 1e-9);
});

test("openingHandOdds: commanderOnCurve is absent without a commander mana value", () => {
  const odds = h.openingHandOdds({ N: 99, lands: 36, ramp: 8 });
  assert.equal(odds.commanderOnCurve, undefined);
  const withCommander = h.openingHandOdds({ N: 99, lands: 36, ramp: 8, commanderMv: 2 });
  assert.ok(withCommander.commanderOnCurve > 0 && withCommander.commanderOnCurve <= 1);
});

test("openingHandOdds: commanderMv is rounded before use", () => {
  const N = 99, lands = 36, ramp = 8;
  const fractional = h.openingHandOdds({ N, lands, ramp, commanderMv: 2.6 });
  const rounded = h.openingHandOdds({ N, lands, ramp, commanderMv: 3 });
  assert.equal(fractional.commanderOnCurve, rounded.commanderOnCurve);
});

test("drawRandom: returns n distinct cards from the input with a seeded rng", () => {
  const cards = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}` }));
  let seed = 42;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const hand = h.drawRandom(cards, 7, rng);
  assert.equal(hand.length, 7);
  assert.equal(new Set(hand.map((c) => c.id)).size, 7); // distinct entries, not duplicated by the shuffle
  hand.forEach((c) => assert.ok(cards.includes(c)));
});

test("drawRandom: never returns more cards than the library holds", () => {
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const hand = h.drawRandom(cards, 7);
  assert.equal(hand.length, 3);
});

// ── EDHREC × collection ──────────────────────────────────────────────
const edhrecCard = (name, overrides = {}) => ({ name, category: "Creatures", synergy: 0.3, inclusion: 0.4, numDecks: 100, ...overrides });

test("edhrecPicks: keeps only owned cards not already in the deck", () => {
  const owned = new Map([["sanctum of all", { id: "c1", name: "Sanctum of All" }]]);
  const cards = [edhrecCard("Sanctum of All"), edhrecCard("Not Owned"), edhrecCard("Already In Deck")];
  const deckNames = new Set(["already in deck"]);
  const ownedTwo = new Map(owned);
  ownedTwo.set("already in deck", { id: "c2", name: "Already In Deck" });
  const picks = h.edhrecPicks(cards, ownedTwo, deckNames);
  assert.deepEqual(picks.map((p) => p.name), ["Sanctum of All"]);
  assert.equal(picks[0].card.id, "c1");
});

test("edhrecPicks: excludes an owned basic land but keeps an owned nonbasic land", () => {
  const owned = new Map([
    ["swamp", { id: "s1", name: "Swamp", type_line: "Basic Land — Swamp" }],
    ["evolving wilds", { id: "e1", name: "Evolving Wilds", type_line: "Land" }],
  ]);
  const cards = [edhrecCard("Swamp", { category: "Lands" }), edhrecCard("Evolving Wilds", { category: "Lands" })];
  const picks = h.edhrecPicks(cards, owned, new Set());
  assert.deepEqual(picks.map((p) => p.name), ["Evolving Wilds"]);
});

test("edhrecPicks: sorts by synergy desc, then inclusion desc", () => {
  const owned = new Map([
    ["low synergy", { id: "a", name: "Low Synergy" }],
    ["high synergy low inclusion", { id: "b", name: "High Synergy Low Inclusion" }],
    ["high synergy high inclusion", { id: "c", name: "High Synergy High Inclusion" }],
  ]);
  const cards = [
    edhrecCard("Low Synergy", { synergy: 0.1, inclusion: 0.9 }),
    edhrecCard("High Synergy Low Inclusion", { synergy: 0.8, inclusion: 0.2 }),
    edhrecCard("High Synergy High Inclusion", { synergy: 0.8, inclusion: 0.5 }),
  ];
  const picks = h.edhrecPicks(cards, owned, new Set());
  assert.deepEqual(picks.map((p) => p.name), ["High Synergy High Inclusion", "High Synergy Low Inclusion", "Low Synergy"]);
});

test("edhrecPicks: matches by normalized front-face name — DFC front face and case", () => {
  const owned = new Map([["valki, god of lies", { id: "v1", name: "Valki, God of Lies" }]]);
  const cards = [edhrecCard("VALKI, GOD OF LIES // Tibalt, Cosmic Impostor")];
  const picks = h.edhrecPicks(cards, owned, new Set());
  assert.equal(picks.length, 1);
  assert.equal(picks[0].card.id, "v1");
});

test("edhrecPicks: a deck name match is also normalized (DFC front face, case)", () => {
  const owned = new Map([["valki, god of lies", { id: "v1", name: "Valki, God of Lies" }]]);
  const cards = [edhrecCard("Valki, God of Lies")];
  const deckNames = new Set(["VALKI, GOD OF LIES".toLowerCase()]);
  const picks = h.edhrecPicks(cards, owned, deckNames);
  assert.equal(picks.length, 0);
});

test("commanderSlug: the client's copy matches the server's for the same inputs", () => {
  const names = [
    "Hei Bai, Forest Guardian",
    "Atraxa, Praetors' Voice",
    "Valki, God of Lies // Tibalt, Cosmic Impostor",
    "K'rrik, Son of Yawgmoth",
  ];
  for (const name of names) assert.equal(h.commanderSlug(name), serverCommanderSlug(name));
});

await run("Deck analysis UI helpers");
