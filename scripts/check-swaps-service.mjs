import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import { createSwapsService, PROFILE_AUTO_LIMIT } from "../lib/swaps-service.js";
import { createProfileStore } from "../lib/profiles.js";
import { createEmbeddingStore } from "../lib/embeddings.js";
import { createRankingCache } from "../lib/swaps.js";

const card = (i, extra = {}) => ({
  id: `s${i}`, oracle_id: `o${i}`, name: `Card ${i}`, type_line: "Instant", cmc: 2, color_identity: ["W"],
  legalities: { commander: "legal" }, prices: { eur: "0.10" },
  oracle_text: `Exile target creature you control, then return it to the battlefield. Variant ${i}.`, ...extra,
});
const original = {
  id: "orig", oracle_id: "o-orig", name: "Cloudshift", type_line: "Instant", cmc: 1, color_identity: ["W"],
  legalities: { commander: "legal" }, prices: { eur: "2.00" },
  oracle_text: "Exile target creature you control, then return that card to the battlefield under your control.",
};
const deck = (extra = {}) => ({ name: "Deck", commander: null, gamePlan: "Blink things.", identityTags: [], cardNames: ["Card 2"], signature: "sig1", ...extra });

// Letter-frequency vectors: deterministic, and similar texts score higher.
function fakeEmbedder() {
  return {
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(26);
        for (const ch of t.toLowerCase()) { const k = ch.charCodeAt(0) - 97; if (k >= 0 && k < 26) v[k]++; }
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}

function fakeAi({ failProfiles = false, failRank = false, skipAlways = [] } = {}) {
  const calls = { profile: 0, rank: 0 };
  return {
    provider: "anthropic", model: "claude-sonnet-5", calls,
    async json({ user, schema }) {
      if (user.includes("CARD TO REPLACE")) {
        calls.rank++;
        calls.rankSchema = schema;
        if (failRank) throw Object.assign(new Error("rank down"), { usage: { inputTokens: 5, outputTokens: 2 }, usd: 0.001 });
        const ids = [...user.matchAll(/^(k\d+):/gm)].map((m) => m[1]);
        return { data: { results: ids.map((id, i) => ({ id, match: 90 - i * 10, fits: true, reason: `Reason ${id}` })) }, usage: { inputTokens: 1, outputTokens: 1 }, usd: 0.01 };
      }
      calls.profile++;
      if (failProfiles) throw Object.assign(new Error("profile down"), { status: 500 });
      const cards = [...user.matchAll(/^(c\d+): ([^|\n]+)/gm)]
        .filter(([, , name]) => !skipAlways.includes(name.trim()))
        .map(([, id]) => ({ id, summary: "Blinks a creature you control.", mechanics: ["flicker"], synergies: [] }));
      return { data: { cards }, usage: { inputTokens: 1, outputTokens: 1 }, usd: 0.001 };
    },
  };
}

async function setup({ cards, ai = null }) {
  const dataDir = await mkdtemp(join(tmpdir(), "spellbook-service-"));
  const collectionStore = {
    load: async () => ({ syncedAt: "2026-09-27T00:00:00.000Z", entries: {}, importedRows: [] }),
    loadCards: async () => Object.fromEntries(cards.map((c) => [c.id, c])),
  };
  const usage = { entries: [], record: async (e) => { usage.entries.push(e); }, monthUsd: async () => usage.entries.reduce((n, e) => n + (e.usd || 0), 0) };
  const aiRef = { current: ai };
  const service = createSwapsService({
    collectionStore, usageLog: usage,
    profileStore: createProfileStore({ dataDir }),
    embeddingStore: createEmbeddingStore({ dataDir }),
    rankingCache: createRankingCache({ dataDir }),
    getAi: async () => aiRef.current,
    getEmbedder: async () => fakeEmbedder(),
  });
  return { service, usage, aiRef };
}
const cardsN = (n) => Array.from({ length: n }, (_, i) => card(i + 1));

test("an empty collection is idle and swaps asks for an upload", async () => {
  const { service } = await setup({ cards: [] });
  assert.equal((await service.status()).phase, "idle");
  const r = await service.swaps({ card: original, colorIdentity: ["W"], deck: null });
  assert.equal(r.httpStatus, 409);
});

test("more than the auto limit waits for confirmation and spends nothing", async () => {
  const ai = fakeAi();
  const { service } = await setup({ cards: cardsN(PROFILE_AUTO_LIMIT + 10), ai });
  const st = await service.status();
  assert.equal(st.phase, "awaiting-confirmation");
  assert.equal(st.pending, 60);
  assert.equal(st.estimate.model, "claude-sonnet-5");
  assert.ok(st.estimate.usd > 0);
  const r = await service.swaps({ card: original, colorIdentity: ["W"], deck: deck() });
  assert.deepEqual([r.httpStatus, r.body.needsConfirmation], [409, true]);
  assert.equal(ai.calls.profile, 0);
});

test("Start profiles everything, then embeds, then is ready", async () => {
  const ai = fakeAi();
  const { service, usage } = await setup({ cards: cardsN(60), ai });
  await service.prepare();
  await service.idle();
  const st = await service.status();
  assert.equal(st.phase, "ready");
  assert.equal(st.pending, 0);
  assert.equal(ai.calls.profile, 3);
  assert.equal(usage.entries.length, 3);
});

test("a small number of new cards is profiled automatically", async () => {
  const ai = fakeAi();
  const { service } = await setup({ cards: cardsN(10), ai });
  assert.ok(["profiling", "embedding"].includes((await service.status()).phase));
  await service.idle();
  assert.equal((await service.status()).phase, "ready");
  assert.equal(ai.calls.profile, 1);
});

test("without an API key the collection is embedded from rules text and swaps run locally", async () => {
  const { service } = await setup({ cards: cardsN(5) });
  await service.status();
  await service.idle();
  assert.equal((await service.status()).phase, "ready");
  const r = await service.swaps({ card: original, colorIdentity: ["W"], deck: deck() });
  assert.equal(r.httpStatus, 200);
  assert.equal(r.body.mode, "local");
  assert.ok(r.body.results.every((x) => x.reason === ""));
});

test("AI swaps exclude deck cards, are cached, and re-rank when the game plan changes", async () => {
  const ai = fakeAi();
  const { service } = await setup({ cards: cardsN(10), ai });
  await service.status();
  await service.idle();
  const first = await service.swaps({ card: original, colorIdentity: ["W"], deck: deck() });
  assert.equal(first.httpStatus, 200);
  assert.equal(first.body.mode, "ai");
  assert.equal(first.body.cached, false);
  assert.ok(first.body.results.length > 0);
  assert.ok(first.body.results.every((r) => r.card.name !== "Card 2"));
  assert.ok(first.body.results[0].reason.startsWith("Reason"));
  const again = await service.swaps({ card: original, colorIdentity: ["W"], deck: deck() });
  assert.equal(again.body.cached, true);
  assert.equal(ai.calls.rank, 1);
  await service.swaps({ card: original, colorIdentity: ["W"], deck: deck({ gamePlan: "Different plan." }) });
  assert.equal(ai.calls.rank, 2);
});

test("an AI ranking failure falls back to local matches with the error, and the billed call is still recorded", async () => {
  const ai = fakeAi({ failRank: true });
  const { service, usage } = await setup({ cards: cardsN(5), ai });
  await service.status();
  await service.idle();
  const r = await service.swaps({ card: original, colorIdentity: ["W"], deck: deck() });
  assert.equal(r.body.mode, "local");
  assert.equal(r.body.aiError, "rank down");
  const rankEntries = usage.entries.filter((e) => e.feature === "rank");
  assert.equal(rankEntries.length, 1);
  assert.equal(rankEntries[0].inputTokens, 5);
  assert.ok(ai.calls.rankSchema?.properties?.results);
});

test("a profiling failure is sticky until Retry — no automatic re-spend", async () => {
  const ai = fakeAi({ failProfiles: true });
  const { service } = await setup({ cards: cardsN(5), ai });
  await service.status();
  await service.idle();
  const st = await service.status();
  assert.equal(st.phase, "error");
  assert.equal(ai.calls.profile, 2);
  await service.status();
  assert.equal(ai.calls.profile, 2);
  await service.prepare();
  await service.idle();
  assert.equal(ai.calls.profile, 4);
});

test("cards the AI never profiles are not retried automatically", async () => {
  const ai = fakeAi({ skipAlways: ["Card 3"] });
  const { service } = await setup({ cards: cardsN(5), ai });
  await service.status();
  await service.idle();
  const st = await service.status();
  assert.equal(st.phase, "ready");
  assert.equal(st.pending, 1);
  const calls = ai.calls.profile;
  await service.status();
  await service.idle();
  assert.equal(ai.calls.profile, calls);
});

await run("Swaps service");
