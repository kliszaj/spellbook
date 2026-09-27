import { createHash } from "crypto";
import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

const faceTexts = (card) => (card.oracle_text != null
  ? [card.oracle_text]
  : (card.card_faces || []).map((f) => f.oracle_text || ""));
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Rules text without reminder text, with the card's own name(s) replaced, so
// similarity reflects what cards do rather than what they're called.
export function cleanRulesText(card) {
  let text = faceTexts(card).join("\n").replace(/\([^)]*\)/g, "");
  const names = new Set([card.name, ...(card.card_faces || []).map((f) => f.name)].filter(Boolean));
  if (card.name?.includes(",")) names.add(card.name.split(",")[0].trim()); // legendary short name
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(escapeRegExp(name), "g"), "CARDNAME");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text || String(card.type_line || "").trim();
}

export function profileText(profile) {
  const parts = [profile.summary];
  if (profile.mechanics?.length) parts.push(`Mechanics: ${profile.mechanics.join(", ")}.`);
  if (profile.synergies?.length) parts.push(`Synergies: ${profile.synergies.join("; ")}.`);
  return parts.join(" ");
}

export const embeddingText = (card, profile) => (profile ? profileText(profile) : cleanRulesText(card));
export const textHash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 16);

export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

const toBase64 = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64");
function fromBase64(s) {
  const bytes = Buffer.from(s, "base64");
  const copy = new Uint8Array(bytes.length); // copy: Buffer's pool offset may not be 4-byte aligned
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

// Loads the model on first use (downloads ~23 MB into cacheDir the first time).
export async function createLocalEmbedder({ cacheDir }) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;
  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8" });
  return {
    async embed(texts) {
      const out = await extractor(texts, { pooling: "mean", normalize: true });
      const dims = out.dims[out.dims.length - 1];
      return texts.map((_, i) => Float32Array.from(out.data.subarray(i * dims, (i + 1) * dims)));
    },
  };
}

export function createEmbeddingStore({ dataDir }) {
  const path = join(dataDir, "collection-embeddings.json");
  let loading = null;

  // Concurrent cold calls must all await the same read instead of each racing past
  // "not loaded yet" and clobbering one another's in-memory object once it resolves.
  function load() {
    if (!loading) {
      loading = (async () => {
        const raw = await readJson(path, null);
        const c = { model: EMBEDDING_MODEL, vectors: {} };
        if (raw && raw.model === EMBEDDING_MODEL) {
          for (const [id, e] of Object.entries(raw.vectors || {})) c.vectors[id] = { h: e.h, v: fromBase64(e.v) };
        }
        return c;
      })();
      loading.catch(() => { loading = null; });
    }
    return loading;
  }

  const get = async (oracleId) => (await load()).vectors[oracleId] || null;

  async function putMany(items) {
    const c = await load();
    for (const { oracleId, hash, vector } of items) c.vectors[oracleId] = { h: hash, v: vector };
  }

  async function save() {
    const c = await load();
    const vectors = {};
    let dims = 0;
    for (const [id, e] of Object.entries(c.vectors)) { vectors[id] = { h: e.h, v: toBase64(e.v) }; dims = e.v.length; }
    await writeJsonAtomic(path, { model: c.model, dims, vectors });
  }

  return { load, get, putMany, save };
}

async function staleItems({ items, store }) {
  const stale = [];
  for (const it of items) {
    const hash = textHash(it.text);
    const e = await store.get(it.oracleId);
    if (!e || e.h !== hash) stale.push({ ...it, hash });
  }
  return stale;
}

export async function countStale({ items, store }) {
  return (await staleItems({ items, store })).length;
}

export async function ensureEmbeddings({ items, store, embedder, onProgress = () => {}, batchSize = 64 }) {
  const stale = await staleItems({ items, store });
  let done = 0;
  for (let i = 0; i < stale.length; i += batchSize) {
    const chunk = stale.slice(i, i + batchSize);
    const vectors = await embedder.embed(chunk.map((c) => c.text));
    await store.putMany(chunk.map((c, j) => ({ oracleId: c.oracleId, hash: c.hash, vector: vectors[j] })));
    await store.save();
    done += chunk.length;
    onProgress({ embedded: done, total: stale.length });
  }
  return stale.length;
}
