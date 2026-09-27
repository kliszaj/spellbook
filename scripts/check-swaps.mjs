import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import {
  RANK_SYSTEM_PROMPT, SWAP_MAX_RESULTS, typeScore, mvScore, jaccard, filterCandidates, shortlist, deckContext,
  buildRankRequest, parseRankResponse, finalizeAi, finalizeLocal, rankingCacheKey, createRankingCache,
} from "../lib/swaps.js";

const mk = (name, extra = {}) => ({
  id: `s-${name}`, oracle_id: `o-${name}`, name, type_line: "Instant", cmc: 1, color_identity: ["W"],
  legalities: { commander: "legal" }, oracle_text: `${name} text.`, ...extra,
});
const cand = (card) => ({ oracleId: card.oracle_id, card, scryfallIds: [card.id] });

test("scoring helpers", () => {
  assert.equal(typeScore(mk("a"), mk("b")), 1);
  assert.equal(typeScore(mk("a"), mk("b", { type_line: "Sorcery" })), 0.5);
  assert.equal(typeScore(mk("a", { type_line: "Artifact Creature — Golem" }), mk("b", { type_line: "Creature — Elf" })), 0.5);
  assert.equal(typeScore(mk("a"), mk("b", { type_line: "Land" })), 0);
  assert.equal(mvScore(mk("a", { cmc: 1 }), mk("b", { cmc: 3 })), 0.5);
  assert.equal(mvScore(mk("a", { cmc: 1 }), mk("b", { cmc: 9 })), 0);
  assert.equal(jaccard(["x", "y"], ["y", "z"]), 1 / 3);
  assert.equal(jaccard([], ["y"]), 0);
});

test("filterCandidates applies every rule", () => {
  const original = mk("Cloudshift");
  const keep = mk("Ephemeral Blink");
  const candidates = [
    cand(keep),
    cand({ ...mk("Cloudshift"), id: "s-other-printing" }),
    cand(mk("In The Deck")),
    cand(mk("Blue Card", { color_identity: ["U"] })),
    cand(mk("Banned Card", { legalities: { commander: "banned" } })),
    cand(mk("Some Land", { type_line: "Land" })),
    cand(mk("Plains", { type_line: "Basic Land — Plains" })),
  ];
  const out = filterCandidates({ original, allowedIdentity: ["W"], deckNames: ["In The Deck"], candidates });
  assert.deepEqual(out.map((c) => c.card.name), ["Ephemeral Blink"]);
  const landOut = filterCandidates({ original: mk("Temple", { type_line: "Land" }), allowedIdentity: ["W"], deckNames: [], candidates });
  assert.deepEqual(landOut.map((c) => c.card.name), ["Some Land"]);
});

test("shortlist blends text, mechanics, type and mana value", () => {
  const original = mk("Orig");
  const a = cand(mk("A"));
  const b = cand(mk("B"));
  const vectors = { "o-A": Float32Array.from([1, 0]), "o-B": Float32Array.from([0, 1]) };
  const profiles = { "o-A": { mechanics: ["flicker"] }, "o-B": { mechanics: ["flicker"] } };
  const args = { original, originalVector: Float32Array.from([1, 0]), candidates: [b, a], vectorFor: (id) => vectors[id], profileFor: (id) => profiles[id] };
  const withMech = shortlist({ ...args, originalProfile: { mechanics: ["flicker"] } });
  assert.deepEqual(withMech.map((c) => c.card.name), ["A", "B"]);
  assert.ok(Math.abs(withMech[0].score - 1) < 1e-9);
  assert.ok(Math.abs(withMech[1].score - 0.4) < 1e-9);
  const noMech = shortlist({ ...args, originalProfile: null });
  assert.ok(Math.abs(noMech[1].score - 0.15) < 1e-9);
  assert.equal(shortlist({ ...args, originalProfile: null, size: 1 }).length, 1);
});

test("deckContext includes the plan, commander and decklist, with a fallback when there is no plan", () => {
  const deck = { name: "Test Deck", commander: { name: "Cmdr", typeLine: "Legendary Creature", text: "Does things." }, gamePlan: "Win by flickering.", identityTags: ["Blink / Flicker"], cardNames: ["A", "B"] };
  const ctx = deckContext(deck);
  for (const part of ["DECK: Test Deck", "Commander: Cmdr | Legendary Creature | Does things.", "Win by flickering.", "Deck themes: Blink / Flicker", "Decklist: A; B"]) assert.ok(ctx.includes(part), part);
  assert.match(deckContext({ ...deck, gamePlan: "" }), /Not provided — infer the plan/);
  assert.match(deckContext(null), /DECK: none/);
});

test("buildRankRequest puts the deck in the cached block and candidates in the user message", () => {
  const shortlisted = [cand(mk("A")), cand(mk("B"))];
  const req = buildRankRequest({
    deck: { name: "D", commander: null, gamePlan: "Plan", identityTags: [], cardNames: [] },
    original: mk("Orig"), originalProfile: { summary: "Blinks.", mechanics: ["flicker"] },
    shortlisted, profileFor: () => ({ summary: "Also blinks.", mechanics: ["flicker"] }),
  });
  assert.equal(req.system, RANK_SYSTEM_PROMPT);
  assert.ok(req.cachedContext.includes("Plan"));
  assert.match(req.user, /^original: Orig/m);
  assert.match(req.user, /^k1: A/m);
  assert.match(req.user, /Does: Also blinks\. \[flicker\]/);
  assert.deepEqual([...req.ids.entries()], [["k1", "o-A"], ["k2", "o-B"]]);
});

test("parseRankResponse clamps and maps ids", () => {
  const ids = new Map([["k1", "o1"], ["k2", "o2"]]);
  const out = parseRankResponse({ results: [{ id: "k1", match: 140, fits: true, reason: "  Great   fit " }, { id: "k9", match: 50 }, { id: "k2", match: "55.4", fits: "yes" }] }, ids);
  assert.deepEqual(out, [
    { oracleId: "o1", match: 100, fits: true, reason: "Great fit" },
    { oracleId: "o2", match: 55, fits: false, reason: "" },
  ]);
});

test("finalizeAi keeps fitting results above the threshold, best first, capped", () => {
  const shortlisted = Array.from({ length: 12 }, (_, i) => cand(mk(`C${i}`)));
  const ranked = shortlisted.map((c, i) => ({ oracleId: c.oracleId, match: 95 - i * 5, fits: i !== 1, reason: `r${i}` }));
  const out = finalizeAi(shortlisted, ranked);
  assert.equal(out.length, SWAP_MAX_RESULTS);
  assert.deepEqual(out.slice(0, 2).map((r) => r.card.name), ["C0", "C2"]);
  assert.ok(out.every((r) => r.match >= 40));
  assert.deepEqual(Object.keys(out[0]).sort(), ["card", "match", "oracle_id", "reason", "scryfallIds"]);
});

test("finalizeLocal uses the shortlist score with the same threshold", () => {
  const out = finalizeLocal([{ ...cand(mk("Hi")), score: 0.8 }, { ...cand(mk("Lo")), score: 0.39 }]);
  assert.deepEqual(out.map((r) => [r.card.name, r.match, r.reason]), [["Hi", 80, ""]]);
});

test("rankingCacheKey changes with the deck version, game plan, collection sync, model and prompt version", () => {
  const base = { originalOracleId: "o", deckSignature: "sig", gamePlan: "plan", syncedAt: "t1", model: "m" };
  const key = rankingCacheKey(base);
  assert.equal(rankingCacheKey({ ...base }), key);
  for (const change of [{ deckSignature: "sig2" }, { gamePlan: "plan2" }, { syncedAt: "t2" }, { model: "m2" }, { promptVersion: 99 }]) {
    assert.notEqual(rankingCacheKey({ ...base, ...change }), key);
  }
});

test("ranking cache persists across instances", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "spellbook-rank-"));
  await createRankingCache({ dataDir }).set("k", [{ match: 70 }]);
  assert.deepEqual(await createRankingCache({ dataDir }).get("k"), [{ match: 70 }]);
  assert.equal(await createRankingCache({ dataDir }).get("missing"), null);
});

test("the ranking prompt names no deck", () => {
  assert.doesNotMatch(RANK_SYSTEM_PROMPT, /hei bai|shrine|kynaios|mikaeus|giada/i);
});

test("the rank prompt allows budget stand-ins, even if weaker", () => {
  assert.match(RANK_SYSTEM_PROMPT, /budget/i);
  assert.match(RANK_SYSTEM_PROMPT, /even if (it is )?weaker/i);
});

test("concurrent cold access to the cache doesn't lose entries", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "spellbook-rank-"));
  const cache = createRankingCache({ dataDir });
  // A second cold read lands mid-sequence (mirrors a concurrent status() check racing a
  // job's own snapshot() on a cache neither has touched yet) while several entries are
  // set meanwhile; none of this is awaited until the end.
  const background = new Promise((resolve) => setImmediate(resolve)).then(() => cache.get("bg"));
  const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
  for (const k of keys) await cache.set(k, [{ match: 1, id: k }]);
  await background;
  const reloaded = createRankingCache({ dataDir });
  for (const k of keys) assert.deepEqual(await reloaded.get(k), [{ match: 1, id: k }]);
});

await run("Swaps ranking");
