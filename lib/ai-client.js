import Anthropic from "@anthropic-ai/sdk";

// Thrown for an API response that was billed but unusable (refused, truncated, or
// unparseable). Carries `usage`/`usd` so callers can still record the spend.
export class AiResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiResponseError";
  }
}

// $ per million tokens [input, output] — Anthropic list prices.
export const AI_PRICES = {
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-haiku-4-5": [1, 5],
  "claude-fable-5": [10, 50],
};

// Cache writes bill at 1.25x input, cache reads at 0.1x input.
export function priceUsd(model, u = {}) {
  const p = AI_PRICES[model];
  if (!p) return null;
  const input = (u.inputTokens || 0) + 1.25 * (u.cacheWriteTokens || 0) + 0.1 * (u.cacheReadTokens || 0);
  return (input * p[0] + (u.outputTokens || 0) * p[1]) / 1e6;
}

// output_config.effort is rejected (400) by Haiku 4.5 and older models.
const EFFORT_MODELS = /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable-5)/;
export const supportsEffort = (model) => EFFORT_MODELS.test(String(model || ""));

export function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    return start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : {};
  }
}

export async function callOpenAIJsonRaw({ apiKey, model, system, user, maxTokens = 2048, fetchImpl = fetch }) {
  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: maxTokens,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `OpenAI request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  const usage = { inputTokens: data?.usage?.prompt_tokens || 0, outputTokens: data?.usage?.completion_tokens || 0 };
  try {
    return { data: parseJsonObject(data?.choices?.[0]?.message?.content || ""), usage };
  } catch (err) {
    throw Object.assign(new AiResponseError(err.message), { usage, usd: priceUsd(model, usage) });
  }
}

// One JSON-returning call shape for both providers. `cachedContext` is the stable
// per-deck block: Anthropic caches it (cache_control), OpenAI just appends it.
export function createAiClient({ provider, apiKey, model, anthropic, fetchImpl = fetch }) {
  async function json({ system, cachedContext = "", user, maxTokens = 8000, effort, schema }) {
    let data;
    let usage;
    if (provider === "openai") {
      const r = await callOpenAIJsonRaw({
        apiKey, model, maxTokens, fetchImpl,
        system: cachedContext ? `${system}\n\n${cachedContext}` : system,
        user,
      });
      data = r.data;
      usage = r.usage;
    } else {
      const client = anthropic || new Anthropic({ apiKey });
      const systemBlocks = [{ type: "text", text: system }];
      if (cachedContext) systemBlocks.push({ type: "text", text: cachedContext, cache_control: { type: "ephemeral" } });
      const outputConfig = {
        ...(effort && supportsEffort(model) ? { effort } : {}),
        ...(schema ? { format: { type: "json_schema", schema } } : {}),
      };
      const message = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
        messages: [{ role: "user", content: user }],
      });
      usage = {
        inputTokens: message.usage?.input_tokens || 0,
        outputTokens: message.usage?.output_tokens || 0,
        cacheWriteTokens: message.usage?.cache_creation_input_tokens || 0,
        cacheReadTokens: message.usage?.cache_read_input_tokens || 0,
      };
      const usd = priceUsd(model, usage);
      if (message.stop_reason === "refusal") {
        throw Object.assign(new AiResponseError("The AI declined this request."), { status: 422, usage, usd });
      }
      if (message.stop_reason === "max_tokens") {
        throw Object.assign(new AiResponseError("The AI response was cut off."), { usage, usd });
      }
      try {
        data = parseJsonObject(message.content.find((b) => b.type === "text")?.text || "");
      } catch (err) {
        throw Object.assign(new AiResponseError(err.message), { usage, usd });
      }
    }
    return { data, usage, usd: priceUsd(model, usage) };
  }

  // Anthropic Message Batches: same request shape as json(), billed at 50%, results
  // arrive asynchronously (usually minutes, up to 24h). `resumeBatchId` re-attaches to a
  // batch submitted earlier (e.g. before a restart) instead of paying for a new one;
  // `onSubmitted(batchId)` lets the caller persist the id. Returns Map<id, result> where a
  // result is { data, usage, usd } or { error, usage?, usd? }.
  async function jsonBatch(items, { resumeBatchId = null, onSubmitted = async () => {}, pollMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const client = anthropic || new Anthropic({ apiKey });
    let batchId = resumeBatchId;
    if (!batchId) {
      const batch = await client.messages.batches.create({
        requests: items.map((it) => {
          const outputConfig = {
            ...(it.effort && supportsEffort(model) ? { effort: it.effort } : {}),
            ...(it.schema ? { format: { type: "json_schema", schema: it.schema } } : {}),
          };
          return {
            custom_id: it.id,
            params: {
              model,
              max_tokens: it.maxTokens || 8000,
              system: it.system,
              ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
              messages: [{ role: "user", content: it.user }],
            },
          };
        }),
      });
      batchId = batch.id;
      await onSubmitted(batchId);
    }
    for (;;) {
      const b = await client.messages.batches.retrieve(batchId);
      if (b.processing_status === "ended") break;
      await sleep(pollMs);
    }
    const out = new Map();
    for await (const entry of await client.messages.batches.results(batchId)) {
      const res = entry.result;
      if (res.type !== "succeeded") { out.set(entry.custom_id, { error: res.type }); continue; }
      const message = res.message;
      const usage = {
        inputTokens: message.usage?.input_tokens || 0,
        outputTokens: message.usage?.output_tokens || 0,
        cacheWriteTokens: message.usage?.cache_creation_input_tokens || 0,
        cacheReadTokens: message.usage?.cache_read_input_tokens || 0,
      };
      const full = priceUsd(model, usage);
      const usd = full == null ? null : full / 2; // batch discount
      if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") {
        out.set(entry.custom_id, { error: message.stop_reason, usage, usd });
        continue;
      }
      try {
        out.set(entry.custom_id, { data: parseJsonObject(message.content.find((c) => c.type === "text")?.text || ""), usage, usd });
      } catch (err) {
        out.set(entry.custom_id, { error: err.message, usage, usd });
      }
    }
    return out;
  }

  return { provider, model, json, ...(provider === "openai" ? {} : { jsonBatch }) };
}
