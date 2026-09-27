import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import { priceUsd, supportsEffort, parseJsonObject, createAiClient, AiResponseError } from "../lib/ai-client.js";
import { createUsageLog } from "../lib/ai-usage.js";

const close = (a, b) => Math.abs(a - b) < 1e-9;

test("priceUsd prices input, output and cache tokens", () => {
  assert.equal(priceUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 100_000 }), 3);
  assert.equal(priceUsd("claude-sonnet-5", { cacheWriteTokens: 1_000_000 }), 2.5);
  assert.ok(close(priceUsd("claude-sonnet-5", { cacheReadTokens: 1_000_000 }), 0.2));
  assert.equal(priceUsd("gpt-4.1", { inputTokens: 5 }), null);
});

test("supportsEffort matches models that accept output_config.effort", () => {
  for (const m of ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5"]) assert.ok(supportsEffort(m), m);
  for (const m of ["claude-haiku-4-5", "gpt-4.1", ""]) assert.ok(!supportsEffort(m), m);
});

test("parseJsonObject tolerates prose around the JSON", () => {
  assert.deepEqual(parseJsonObject('Here you go: {"a":1} thanks'), { a: 1 });
  assert.deepEqual(parseJsonObject(""), {});
});

function fakeAnthropic(reply) {
  const calls = [];
  return { calls, messages: { create: async (params) => { calls.push(params); return reply; } } };
}
const okReply = {
  stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"ok":true}' }],
  usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 0 },
};

test("anthropic json() caches the deck context block and sends effort when supported", async () => {
  const anthropic = fakeAnthropic(okReply);
  const ai = createAiClient({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5", anthropic });
  const r = await ai.json({ system: "SYS", cachedContext: "DECK", user: "USER", maxTokens: 1234, effort: "low" });
  const p = anthropic.calls[0];
  assert.deepEqual(p.system, [{ type: "text", text: "SYS" }, { type: "text", text: "DECK", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(p.output_config, { effort: "low" });
  assert.equal(p.max_tokens, 1234);
  assert.deepEqual(p.messages, [{ role: "user", content: "USER" }]);
  assert.deepEqual(r.data, { ok: true });
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 500, cacheReadTokens: 0 });
  assert.ok(close(r.usd, (1000 * 2 + 500 * 1.25 * 2 + 200 * 10) / 1e6));
});

test("anthropic json() omits effort for models that reject it", async () => {
  const anthropic = fakeAnthropic(okReply);
  await createAiClient({ provider: "anthropic", apiKey: "k", model: "claude-haiku-4-5", anthropic }).json({ system: "S", user: "U", effort: "low" });
  assert.equal(anthropic.calls[0].output_config, undefined);
  assert.deepEqual(anthropic.calls[0].system, [{ type: "text", text: "S" }]);
});

const RESULT_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

test("anthropic json() sends schema as structured output, merged with effort when supported", async () => {
  const anthropic = fakeAnthropic(okReply);
  await createAiClient({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5", anthropic }).json({ system: "S", user: "U", effort: "low", schema: RESULT_SCHEMA });
  assert.deepEqual(anthropic.calls[0].output_config, { effort: "low", format: { type: "json_schema", schema: RESULT_SCHEMA } });
});

test("anthropic json() sends schema without effort for models that reject it", async () => {
  const anthropic = fakeAnthropic(okReply);
  await createAiClient({ provider: "anthropic", apiKey: "k", model: "claude-haiku-4-5", anthropic }).json({ system: "S", user: "U", effort: "low", schema: RESULT_SCHEMA });
  assert.deepEqual(anthropic.calls[0].output_config, { format: { type: "json_schema", schema: RESULT_SCHEMA } });
});

test("anthropic json() throws AiResponseError with billed usage on refusal or truncation", async () => {
  for (const stop_reason of ["refusal", "max_tokens"]) {
    const ai = createAiClient({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5", anthropic: fakeAnthropic({ ...okReply, stop_reason }) });
    await assert.rejects(ai.json({ system: "S", user: "U" }), (err) => {
      assert.ok(err instanceof AiResponseError, stop_reason);
      assert.deepEqual(err.usage, { inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 500, cacheReadTokens: 0 }, stop_reason);
      assert.ok(close(err.usd, (1000 * 2 + 500 * 1.25 * 2 + 200 * 10) / 1e6), stop_reason);
      if (stop_reason === "refusal") assert.equal(err.status, 422);
      return true;
    });
  }
});

test("anthropic json() throws AiResponseError with billed usage on unparseable text", async () => {
  const badReply = { ...okReply, content: [{ type: "text", text: '{"a": "x"y"}' }] };
  const ai = createAiClient({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5", anthropic: fakeAnthropic(badReply) });
  await assert.rejects(ai.json({ system: "S", user: "U" }), (err) => {
    assert.ok(err instanceof AiResponseError);
    assert.deepEqual(err.usage, { inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 500, cacheReadTokens: 0 });
    assert.ok(err.usd > 0);
    return true;
  });
});

test("openai json() folds the deck context into the system prompt and reports usage", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"x":2}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  };
  const r = await createAiClient({ provider: "openai", apiKey: "k", model: "gpt-4.1", fetchImpl }).json({ system: "S", cachedContext: "D", user: "U" });
  assert.equal(body.messages[0].content, "S\n\nD");
  assert.deepEqual(r.data, { x: 2 });
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 });
  assert.equal(r.usd, null);
});

test("usage log sums this month's spend only", async () => {
  let now = new Date("2026-09-30T23:00:00Z");
  const log = createUsageLog({ dataDir: await mkdtemp(join(tmpdir(), "spellbook-usage-")), now: () => now });
  await log.record({ feature: "profile", usd: 1.25 });
  await log.record({ feature: "rank", usd: 0.5 });
  now = new Date("2026-10-01T01:00:00Z");
  await log.record({ feature: "rank", usd: 0.1 });
  assert.ok(close(await log.monthUsd(), 0.1));
  now = new Date("2026-09-15T00:00:00Z");
  assert.ok(close(await log.monthUsd(), 1.75));
});

await run("AI client");
