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
const h = Function(`${block}; return { gapSummary, chipGroups, rolesFromProfile, isWincon, hypergeomAtLeast, openingHandOdds, drawRandom, commanderSlug, edhrecPicks, escAttr, oddsTone, typicalCurve, typeTargetsFor, suggestBasicSplit, trimBudget, cutKeepScore, projectTo99, simulateTurns, pickStaples };`)();

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

// ── escAttr ──────────────────────────────────────────────────────────
test("escAttr: a double quote and an apostrophe don't break out of a double-quoted attribute", () => {
  const note = `He said "counter it" and it's still good.`;
  const escaped = h.escAttr(note);
  assert.ok(!escaped.includes('"'), "raw double quote must not survive");
  assert.ok(!escaped.includes("'") || escaped.includes("&#39;"), "raw apostrophe must not survive unescaped");
  // Round-trips: parsing `<b title="${escaped}">` back out (naively, via a DOM-less regex
  // stand-in — a real attribute parser) recovers the original text.
  const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert.equal(unescape(escaped), note);
});

test("escAttr: also escapes & < > (same as esc(), plus quotes)", () => {
  assert.equal(h.escAttr(`<script>alert("x")</script> & "quoted" 'single'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;quoted&quot; &#39;single&#39;");
});

test("escAttr: null/undefined become an empty string", () => {
  assert.equal(h.escAttr(null), "");
  assert.equal(h.escAttr(undefined), "");
});


test("oddsTone: bands per stat — 36 lands in 99 reads as good for 3+ lands", () => {
  const odds = h.openingHandOdds({ N: 99, lands: 36, ramp: 10 });
  assert.equal(h.oddsTone("landsIn7", odds.landsIn7), "good");
  assert.equal(h.oddsTone("keepableLands", odds.keepableLands), "good");
  assert.equal(h.oddsTone("landsIn7", 0.4), "ok");
  assert.equal(h.oddsTone("keepableLands", 0.49), "bad");
  assert.equal(h.oddsTone("commanderOnCurve", 0.6), "ok");
  assert.equal(h.oddsTone("landsIn7", 0.2), "bad");
  assert.equal(h.oddsTone("keepableLands", 0.7), "ok");
  assert.equal(h.oddsTone("rampByT2", 0.3), "bad");
});


test("typicalCurve: scales to the selection size and keeps a ~3.1 average MV", () => {
  for (const n of [0, 23, 63]) {
    const c = h.typicalCurve(n);
    assert.equal(c.length, 8);
    assert.ok(Math.abs(c.reduce((a, b) => a + b, 0) - n) < 1e-9, `sums to ${n}`);
  }
  const c = h.typicalCurve(63);
  const avg = c.reduce((s, v, i) => s + v * i, 0) / 63;
  assert.ok(avg > 2.9 && avg < 3.3, `avg MV ${avg}`);
  assert.equal(Math.max(...c), c[2], "peaks at MV 2");
});


test("typeTargetsFor: defaults without a lens, archetypes shift creatures and spells", () => {
  assert.deepEqual(h.typeTargetsFor([]).creature, [25, 30]);
  assert.deepEqual(h.typeTargetsFor(["spellslinger"]).creature, [8, 15]);
  assert.deepEqual(h.typeTargetsFor(["spellslinger"]).artifact, [5, 10]);
  assert.deepEqual(h.typeTargetsFor(["spellslinger", "aggro"]).creature, [19, 27]);
  assert.deepEqual(h.typeTargetsFor(["casual"]), h.typeTargetsFor([]));
});

test("suggestBasicSplit: proportional to symbols, always sums to n, skips unused colors", () => {
  const split = h.suggestBasicSplit({ W: 10, U: 20, B: 0, R: 10, G: 10 }, 10);
  assert.equal(Object.values(split).reduce((a, b) => a + b, 0), 10);
  assert.equal(split.B, undefined);
  assert.equal(split.U, 4);
  const five = h.suggestBasicSplit({ W: 12, U: 12, B: 14, R: 11, G: 13 }, 7);
  assert.equal(Object.values(five).reduce((a, b) => a + b, 0), 7);
  assert.deepEqual(h.suggestBasicSplit({ W: 0 }, 5), {});
  assert.deepEqual(h.suggestBasicSplit({ W: 3 }, 0), {});
});


test("trimBudget: cut/add/ok per row, cuts first, headline is total - 100", () => {
  const b = h.trimBudget([
    { key: "ramp", label: "Ramp", have: 23, lo: 10, hi: 12 },
    { key: "wipes", label: "Wipes", have: 1, lo: 2, hi: 4 },
    { key: "draw", label: "Draw", have: 18, lo: 10, hi: null },
    { key: "creature", label: "Creatures", have: 41, lo: 25, hi: 30 },
  ], 147);
  assert.equal(b.toCut, 47);
  assert.deepEqual(b.rows.map((r) => [r.key, r.action, r.n]), [
    ["ramp", "cut", 11], ["creature", "cut", 11], ["wipes", "add", 1], ["draw", "ok", 0],
  ]);
  assert.equal(h.trimBudget([], 95).toCut, 0);
});

test("cutKeepScore: popular, synergistic, multi-role, cheap cards score higher", () => {
  const base = { inclusion: 0.2, synergy: 0, roles: 1, cmc: 3 };
  assert.ok(h.cutKeepScore({ ...base, inclusion: 0.6 }) > h.cutKeepScore(base));
  assert.ok(h.cutKeepScore({ ...base, synergy: 0.4 }) > h.cutKeepScore(base));
  assert.ok(h.cutKeepScore({ ...base, roles: 2 }) > h.cutKeepScore(base));
  assert.ok(h.cutKeepScore({ ...base, cmc: 2 }) > h.cutKeepScore(base));
});

test("projectTo99: scales counts from a big pool, leaves decks at or under 99 alone", () => {
  assert.equal(h.projectTo99(35, 146), 24);
  assert.equal(h.projectTo99(36, 99), 36);
  assert.equal(h.projectTo99(10, 60), 10);
});


// Deterministic RNG for the simulator tests.
const seeded = (seed) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const libOf = (lands, ramp, other) => [
  ...Array(lands).fill({ land: true, ramp: false, cmc: 0 }),
  ...Array(ramp).fill({ land: false, ramp: true, cmc: 2 }),
  ...Array(other).fill({ land: false, ramp: false, cmc: 3 }),
];

test("simulateTurns: an all-land library plays a land every turn", () => {
  const r = h.simulateTurns({ library: libOf(99, 0, 0), commanderMv: 3, trials: 200, rng: seeded(1) });
  assert.deepEqual(r.avgMana, [1, 2, 3, 4, 5]);
  assert.equal(r.missedDrop, 0);
  assert.equal(r.commanderOnCurve, 1);
});

test("simulateTurns: no lands means no mana and every game misses a drop", () => {
  const r = h.simulateTurns({ library: libOf(0, 0, 99), commanderMv: 3, trials: 50, rng: seeded(2) });
  assert.deepEqual(r.avgMana, [0, 0, 0, 0, 0]);
  assert.equal(r.missedDrop, 1);
  assert.equal(r.commanderOnCurve, 0);
});

test("simulateTurns: ramp raises mana on later turns; a typical deck lands in a sane range", () => {
  const noRamp = h.simulateTurns({ library: libOf(37, 0, 62), commanderMv: 4, trials: 3000, rng: seeded(3) });
  const ramp = h.simulateTurns({ library: libOf(37, 10, 52), commanderMv: 4, trials: 3000, rng: seeded(3) });
  assert.ok(ramp.avgMana[4] > noRamp.avgMana[4]);
  assert.ok(ramp.commanderOnCurve > noRamp.commanderOnCurve);
  assert.ok(noRamp.avgLandsT5 > 3.5 && noRamp.avgLandsT5 < 5, `lands T5 ${noRamp.avgLandsT5}`);
  assert.ok(noRamp.missedDrop > 0.05 && noRamp.missedDrop < 0.5, `missed ${noRamp.missedDrop}`);
});

test("pickStaples: universal + pair rocks + lands by cycle, skipping what the deck has", () => {
  const picks = h.pickStaples({
    colors: ["U", "R"], inDeck: new Set(["sol ring"]),
    landsByCycle: { shockland: ["Steam Vents"], checkland: ["Sulfur Falls"], tricycleland: ["Raugrin Triome"] },
  });
  assert.ok(!picks.includes("Sol Ring"));
  assert.ok(picks.includes("Arcane Signet") && picks.includes("Command Tower"));
  assert.ok(picks.includes("Izzet Signet") && picks.includes("Talisman of Creativity"));
  assert.ok(picks.includes("Steam Vents") && picks.includes("Sulfur Falls"));
  assert.ok(!picks.includes("Raugrin Triome"), "triomes only at 3+ colors");
});

test("pickStaples: mono-color skips multicolor staples; rocks and lands are capped", () => {
  const mono = h.pickStaples({ colors: ["G"] });
  assert.ok(!mono.includes("Command Tower"));
  const five = h.pickStaples({
    colors: ["W", "U", "B", "R", "G"], maxRocks: 4, maxLands: 3,
    landsByCycle: { tricycleland: ["A Triome", "B Triome"], shockland: ["X Shock", "Y Shock"] },
  });
  const rocks = five.filter((n) => /Signet|Talisman/.test(n) && n !== "Arcane Signet");
  assert.equal(rocks.length, 4);
  assert.deepEqual(five.filter((n) => /Triome|Shock/.test(n)), ["A Triome", "B Triome", "X Shock"]);
});

test("pickStaples: Game Changers only within the allowance; EDHREC staples by inclusion, no lands", () => {
  const edhrec = [
    { name: "Rhystic Study", inclusion: 0.6, category: "Card Draw" },
    { name: "Cyclonic Rift", inclusion: 0.55, category: "Instants" },
    { name: "Reliquary Tower", inclusion: 0.7, category: "Utility Lands" },
    { name: "Ponder", inclusion: 0.5, category: "Sorceries" },
    { name: "Niche Card", inclusion: 0.1, category: "Creatures" },
  ];
  const gc = new Set(["rhystic study", "cyclonic rift"]);
  const b2 = h.pickStaples({ colors: ["U"], edhrec, gameChangers: gc, gcAllowance: 0 });
  assert.ok(b2.includes("Ponder") && !b2.includes("Rhystic Study") && !b2.includes("Cyclonic Rift"));
  assert.ok(!b2.includes("Reliquary Tower") && !b2.includes("Niche Card"));
  const b3 = h.pickStaples({ colors: ["U"], edhrec, gameChangers: gc, gcAllowance: 1 });
  assert.ok(b3.includes("Rhystic Study") && !b3.includes("Cyclonic Rift"));
});

await run("Deck analysis UI helpers");
