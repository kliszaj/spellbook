import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import {
  MECHANICS, PROFILE_SCHEMA, PROFILE_SYSTEM_PROMPT, PROMPT_VERSION, cardPromptLine, buildProfileRequest,
  normalizeProfile, parseProfileResponse, estimateProfileUsd, createProfileStore, runProfileJob, profileOne,
} from "../lib/profiles.js";

const tempDir = () => mkdtemp(join(tmpdir(), "spellbook-profiles-"));
const card = (n) => ({ id: `s${n}`, oracle_id: `o${n}`, name: `Card ${n}`, mana_cost: "{1}{U}", type_line: "Instant", oracle_text: `Draw ${n} cards.` });
const usageLog = () => { const entries = []; return { entries, record: async (e) => { entries.push(e); } }; };

// Answers profile requests by reading the "cN: Name" lines back out of the prompt.
function fakeAi({ skipOnce = [], skipAlways = [], failTimes = 0, failStatus, billedFailTimes = 0 } = {}) {
  const calls = [];
  const skipped = new Set();
  let fails = failTimes;
  let billedFails = billedFailTimes;
  return {
    provider: "anthropic", model: "claude-sonnet-5", calls,
    async json(req) {
      calls.push(req);
      if (billedFails > 0) {
        billedFails--;
        throw Object.assign(new Error("billed parse failure"), { usage: { inputTokens: 10, outputTokens: 5 }, usd: 0.002 });
      }
      if (fails > 0) { fails--; throw Object.assign(new Error("boom"), { status: failStatus }); }
      const cards = [...req.user.matchAll(/^(c\d+): ([^|\n]+)/gm)]
        .map(([, id, name]) => ({ id, name: name.trim() }))
        .filter(({ name }) => {
          if (skipAlways.includes(name)) return false;
          if (skipOnce.includes(name) && !skipped.has(name)) { skipped.add(name); return false; }
          return true;
        })
        .map(({ id, name }) => ({ id, summary: `Profile of ${name}.`, mechanics: ["card-draw", "not-a-tag"], synergies: ["spells"] }));
      return { data: { cards }, usage: { inputTokens: 100, outputTokens: 50 }, usd: 0.001 };
    },
  };
}

test("cardPromptLine formats single-faced and multi-faced cards", () => {
  assert.equal(cardPromptLine(card(1), "c1"), "c1: Card 1 | {1}{U} | Instant | Draw 1 cards.");
  const dfc = {
    name: "Front // Back",
    card_faces: [
      { name: "Front", mana_cost: "{G}", type_line: "Creature — Elf", oracle_text: "Tap: add {G}.", power: "1", toughness: "1" },
      { name: "Back", mana_cost: "", type_line: "Land", oracle_text: "Tap: add {G}." },
    ],
  };
  assert.equal(cardPromptLine(dfc, "c2"), "c2: Front // Back | Front | {G} | Creature — Elf | Tap: add {G}. | 1/1 // Back | Land | Tap: add {G}.");
});

test("the system prompt lists every mechanic and names no deck", () => {
  for (const m of MECHANICS) assert.ok(PROFILE_SYSTEM_PROMPT.includes(m), m);
  assert.doesNotMatch(PROFILE_SYSTEM_PROMPT, /hei bai|shrine|kynaios|mikaeus|giada/i);
});

test("buildProfileRequest maps short ids back to oracle ids", () => {
  const { user, ids } = buildProfileRequest([card(1), card(2)]);
  assert.match(user, /^c1: Card 1/m);
  assert.match(user, /^c2: Card 2/m);
  assert.deepEqual([...ids.entries()], [["c1", "o1"], ["c2", "o2"]]);
});

test("normalizeProfile keeps vocabulary tags only and caps lengths", () => {
  const p = normalizeProfile({ summary: "  Draws   cards. ", mechanics: ["card-draw", "Card-Draw", "made-up", "ramp"], synergies: ["a", "b", "c", "d", "e"] }, "m");
  assert.deepEqual(p, { summary: "Draws cards.", mechanics: ["card-draw", "ramp"], synergies: ["a", "b", "c", "d"], model: "m" });
  assert.equal(normalizeProfile({ summary: "" }, "m"), null);
});

test("parseProfileResponse reports cards the AI left out", () => {
  const { ids } = buildProfileRequest([card(1), card(2)]);
  const { profiles, missing } = parseProfileResponse({ cards: [{ id: "c1", summary: "x", mechanics: [] }, { id: "c9", summary: "y" }] }, ids, "m");
  assert.deepEqual(Object.keys(profiles), ["o1"]);
  assert.deepEqual(missing, ["o2"]);
});

test("runProfileJob profiles in batches of 25, records spend and saves progress", async () => {
  const dataDir = await tempDir();
  const store = createProfileStore({ dataDir });
  const ai = fakeAi();
  const log = usageLog();
  let last = 0;
  const cards = Array.from({ length: 30 }, (_, i) => card(i + 1));
  const result = await runProfileJob({ cards, store, ai, usageLog: log, onProgress: ({ profiled }) => { last = profiled; } });
  assert.deepEqual(result, { profiled: 30, failed: [] });
  assert.equal(ai.calls.length, 2);
  assert.equal(ai.calls[0].effort, "low");
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].feature, "profile");
  assert.equal(last, 30);
  const saved = JSON.parse(await readFile(join(dataDir, "card-profiles.json"), "utf8"));
  assert.equal(Object.keys(saved.profiles).length, 30);
  assert.deepEqual(saved.profiles.o1.mechanics, ["card-draw"]);
});

test("runProfileJob sends the profile schema with the mechanics enum", async () => {
  const ai = fakeAi();
  await runProfileJob({ cards: [card(1)], store: createProfileStore({ dataDir: await tempDir() }), ai, usageLog: usageLog() });
  assert.equal(ai.calls[0].schema, PROFILE_SCHEMA);
  assert.deepEqual(ai.calls[0].schema.properties.cards.items.properties.mechanics.items.enum, MECHANICS);
});

test("a billed parse failure is recorded even though the attempt is discarded and retried", async () => {
  const ai = fakeAi({ billedFailTimes: 1 });
  const log = usageLog();
  const result = await runProfileJob({ cards: [card(1)], store: createProfileStore({ dataDir: await tempDir() }), ai, usageLog: log });
  assert.deepEqual(result, { profiled: 1, failed: [] });
  assert.equal(ai.calls.length, 2);
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].feature, "profile");
  assert.equal(log.entries[0].inputTokens, 10);
  assert.equal(log.entries[0].usd, 0.002);
});

test("a card the AI skips once is retried once; skipped twice it is reported as failed", async () => {
  const cards = Array.from({ length: 30 }, (_, i) => card(i + 1));
  const once = await runProfileJob({ cards, store: createProfileStore({ dataDir: await tempDir() }), ai: fakeAi({ skipOnce: ["Card 3"] }), usageLog: usageLog() });
  assert.deepEqual(once, { profiled: 30, failed: [] });
  const ai = fakeAi({ skipAlways: ["Card 3"] });
  const always = await runProfileJob({ cards, store: createProfileStore({ dataDir: await tempDir() }), ai, usageLog: usageLog() });
  assert.deepEqual(always, { profiled: 29, failed: ["o3"] });
  assert.equal(ai.calls.length, 2);
});

test("a failed request is retried once; auth errors are not retried", async () => {
  const cards = [card(1)];
  const flaky = fakeAi({ failTimes: 1 });
  assert.deepEqual(await runProfileJob({ cards, store: createProfileStore({ dataDir: await tempDir() }), ai: flaky, usageLog: usageLog() }), { profiled: 1, failed: [] });
  await assert.rejects(runProfileJob({ cards, store: createProfileStore({ dataDir: await tempDir() }), ai: fakeAi({ failTimes: 2 }), usageLog: usageLog() }));
  const unauthorized = fakeAi({ failTimes: 1, failStatus: 401 });
  await assert.rejects(runProfileJob({ cards, store: createProfileStore({ dataDir: await tempDir() }), ai: unauthorized, usageLog: usageLog() }));
  assert.equal(unauthorized.calls.length, 1);
});

test("profiles from an older prompt version are ignored", async () => {
  const dataDir = await tempDir();
  await writeFile(join(dataDir, "card-profiles.json"), JSON.stringify({ promptVersion: PROMPT_VERSION - 1, profiles: { o1: { summary: "old" } } }));
  const store = createProfileStore({ dataDir });
  assert.equal(await store.get("o1"), null);
  assert.deepEqual(await store.pending(["o1"]), ["o1"]);
});

test("profileOne uses the cache before calling the AI, and sends the profile schema", async () => {
  const store = createProfileStore({ dataDir: await tempDir() });
  const ai = fakeAi();
  const first = await profileOne(card(7), { store, ai, usageLog: usageLog() });
  const second = await profileOne(card(7), { store, ai, usageLog: usageLog() });
  assert.equal(first.summary, "Profile of Card 7.");
  assert.deepEqual(second, first);
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].schema, PROFILE_SCHEMA);
});

test("profileOne records a billed failure before rethrowing", async () => {
  const store = createProfileStore({ dataDir: await tempDir() });
  const ai = fakeAi({ billedFailTimes: 1 });
  const log = usageLog();
  await assert.rejects(profileOne(card(8), { store, ai, usageLog: log }));
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].feature, "profile");
  assert.equal(log.entries[0].inputTokens, 10);
});

test("estimateProfileUsd uses the per-card token constants", () => {
  assert.ok(estimateProfileUsd(1000, "claude-sonnet-5") > 0);
  assert.equal(estimateProfileUsd(1000, "gpt-4.1"), null);
});

test("concurrent cold access to the store doesn't lose writes", async () => {
  const dataDir = await tempDir();
  const store = createProfileStore({ dataDir });
  // A second cold read lands mid-sequence (mirrors a concurrent status() check racing a
  // job's own snapshot() on a store neither has touched yet) while several batches are
  // saved meanwhile; none of this is awaited until the end.
  const background = new Promise((resolve) => setImmediate(resolve)).then(() => store.pending(["bg"]));
  const entries = Array.from({ length: 20 }, (_, i) => [`o${i}`, { summary: `Profile ${i}.`, mechanics: [], synergies: [] }]);
  for (const [id, profile] of entries) await store.saveMany({ [id]: profile });
  await background;
  const reloaded = createProfileStore({ dataDir });
  for (const [id, profile] of entries) assert.deepEqual(await reloaded.get(id), profile);
});

await run("Card profiles");
