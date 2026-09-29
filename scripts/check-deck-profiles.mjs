import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import { createDeckProfiles } from "../lib/deck-profiles.js";
import { createProfileStore } from "../lib/profiles.js";
import { PROFILE_AUTO_LIMIT } from "../lib/swaps-service.js";

const card = (i) => ({
  id: `s${i}`, oracle_id: `o${i}`, name: `Card ${i}`, type_line: "Sorcery", cmc: 2,
  oracle_text: `Draw a card. Variant ${i}.`,
});
const cardsN = (n) => Array.from({ length: n }, (_, i) => card(i + 1));

function fakeAi({ delayMs = 0 } = {}) {
  const calls = { profile: 0, batches: [] };
  return {
    provider: "anthropic", model: "claude-sonnet-5", calls,
    async json({ user }) {
      calls.profile++;
      const ids = [...user.matchAll(/^(c\d+): ([^|\n]+)/gm)].map(([, id]) => id);
      calls.batches.push(ids.length);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const cards = ids.map((id) => ({ id, summary: "Draws a card.", mechanics: ["card-draw"], synergies: [] }));
      return { data: { cards }, usage: { inputTokens: 1, outputTokens: 1 }, usd: 0.001 };
    },
  };
}

// Answers for every card in the batch except `omitName` — which the schema requires one
// entry per input card for, so leaving it out is exactly what `parseProfileResponse`
// reports as "missing" and `runProfileJob` retries once, then gives up on as `failed`.
function fakeAiOmit(omitName) {
  const calls = { profile: 0, batches: [] };
  return {
    provider: "anthropic", model: "claude-sonnet-5", calls,
    async json({ user }) {
      calls.profile++;
      const lines = user.split("\n").slice(1);
      const entries = lines.map((line) => {
        const [id, rest] = line.split(/: (.*)/s);
        return { id, name: rest.split(" | ")[0] };
      });
      calls.batches.push(entries.length);
      const cards = entries
        .filter((e) => e.name !== omitName)
        .map((e) => ({ id: e.id, summary: "Draws a card.", mechanics: ["card-draw"], synergies: [] }));
      return { data: { cards }, usage: { inputTokens: 1, outputTokens: 1 }, usd: 0.001 };
    },
  };
}

async function setup({ ai = null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "spellbook-deck-profiles-"));
  const profileStore = createProfileStore({ dataDir });
  const usage = { entries: [], record: async (e) => { usage.entries.push(e); } };
  const aiRef = { current: ai };
  const deckProfiles = createDeckProfiles({ profileStore, usageLog: usage, getAi: async () => aiRef.current });
  return { deckProfiles, profileStore, usage, aiRef };
}

test("lookup reports cached profiles, what's missing, and a spend estimate", async () => {
  const ai = fakeAi();
  const { deckProfiles, profileStore } = await setup({ ai });
  await profileStore.saveMany({ o1: { summary: "Ramps.", mechanics: ["ramp"], synergies: [], model: ai.model } });
  const result = await deckProfiles.lookup([card(1), ...cardsN(30).slice(1)]);
  assert.deepEqual(Object.keys(result.profiles), ["o1"]);
  assert.equal(result.missing.length, 29);
  assert.equal(result.aiAvailable, true);
  assert.equal(result.estimate.model, "claude-sonnet-5");
  assert.ok(result.estimate.usd > 0);
  assert.equal(ai.calls.profile, 0); // lookup never calls the AI
});

test("lookup without AI still reports missing profiles, no estimate", async () => {
  const { deckProfiles } = await setup({ ai: null });
  const result = await deckProfiles.lookup([card(1)]);
  assert.deepEqual(result.missing, ["o1"]);
  assert.equal(result.estimate, null);
  assert.equal(result.aiAvailable, false);
});

test("prepare auto-profiles when at or under the auto limit", async () => {
  const ai = fakeAi();
  const { deckProfiles } = await setup({ ai });
  const cards = cardsN(PROFILE_AUTO_LIMIT);
  const result = await deckProfiles.prepare(cards, { confirm: false });
  assert.equal(result.missing.length, 0);
  assert.equal(Object.keys(result.profiles).length, PROFILE_AUTO_LIMIT);
  assert.ok(ai.calls.profile > 0);
});

test("prepare over the auto limit without confirm needs confirmation and makes zero AI calls", async () => {
  const ai = fakeAi();
  const { deckProfiles } = await setup({ ai });
  const cards = cardsN(PROFILE_AUTO_LIMIT + 5);
  const result = await deckProfiles.prepare(cards, { confirm: false });
  assert.deepEqual(
    { needsConfirmation: result.needsConfirmation, missing: result.missing },
    { needsConfirmation: true, missing: PROFILE_AUTO_LIMIT + 5 },
  );
  assert.ok(result.estimate.usd > 0);
  assert.equal(ai.calls.profile, 0);
});

test("prepare over the auto limit with confirm profiles everything", async () => {
  const ai = fakeAi();
  const { deckProfiles } = await setup({ ai });
  const cards = cardsN(PROFILE_AUTO_LIMIT + 5);
  const result = await deckProfiles.prepare(cards, { confirm: true });
  assert.equal(result.missing.length, 0);
  assert.equal(Object.keys(result.profiles).length, PROFILE_AUTO_LIMIT + 5);
});

test("concurrent prepares for the same cards make one set of AI calls", async () => {
  const ai = fakeAi({ delayMs: 20 });
  const { deckProfiles } = await setup({ ai });
  const cards = cardsN(10);
  const [a, b] = await Promise.all([
    deckProfiles.prepare(cards, { confirm: false }),
    deckProfiles.prepare(cards, { confirm: false }),
  ]);
  assert.equal(Object.keys(a.profiles).length, 10);
  assert.equal(Object.keys(b.profiles).length, 10);
  assert.equal(ai.calls.profile, 1); // 10 cards fit in one batch — a single shared job, not two
});

test("no AI configured returns a no-ai result from prepare", async () => {
  const { deckProfiles } = await setup({ ai: null });
  const result = await deckProfiles.prepare([card(1)], { confirm: false });
  assert.deepEqual(result, { error: "no-ai" });
});

test("a card the AI keeps failing to profile is never auto-retried, but a confirm prepare retries it", async () => {
  const ai = fakeAiOmit("Card 1"); // always leaves Card 1 (o1) out of its response
  const { deckProfiles } = await setup({ ai });
  const cards = [card(1), card(2)];

  const first = await deckProfiles.prepare(cards, { confirm: false });
  assert.deepEqual(first.missing, ["o1"]);
  assert.equal(first.skipped, 1);
  assert.equal(Object.keys(first.profiles).length, 1); // Card 2 still profiled fine
  const callsAfterFirst = ai.calls.profile;
  assert.ok(callsAfterFirst > 0);

  // Deck signature "changes" (same cards, another auto prepare) — must make zero AI calls
  // for the card already known to fail, instead of paying to retry it every time.
  const second = await deckProfiles.prepare(cards, { confirm: false });
  assert.deepEqual(second.missing, ["o1"]);
  assert.equal(second.skipped, 1);
  assert.equal(ai.calls.profile, callsAfterFirst);

  // A manual confirm prepare (the user's Retry click) tries it again.
  const third = await deckProfiles.prepare(cards, { confirm: true });
  assert.ok(ai.calls.profile > callsAfterFirst);
  assert.deepEqual(third.missing, ["o1"]); // still fails — the fake always omits it
});

await run("Deck profiles");
