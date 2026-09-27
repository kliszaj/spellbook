import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import {
  cleanRulesText, profileText, embeddingText, textHash, dot, createEmbeddingStore, countStale, ensureEmbeddings,
} from "../lib/embeddings.js";

const tempDir = () => mkdtemp(join(tmpdir(), "spellbook-embeddings-"));
function fakeEmbedder() {
  const calls = [];
  return {
    calls,
    async embed(texts) {
      calls.push(texts.slice());
      return texts.map((t) => Float32Array.from({ length: 4 }, (_, i) => (t.length + i) / 100));
    },
  };
}

test("cleanRulesText strips reminder text and self-references", () => {
  const legend = { name: "Mira, Keeper of Tides", type_line: "Legendary Creature", oracle_text: "Mira enters (This is reminder text.) and Mira, Keeper of Tides attacks." };
  assert.equal(cleanRulesText(legend), "CARDNAME enters and CARDNAME attacks.");
  const dfc = { name: "Dawn // Dusk", type_line: "Sorcery // Sorcery", card_faces: [{ name: "Dawn", oracle_text: "Dawn gains you 2 life." }, { name: "Dusk", oracle_text: "Destroy target creature." }] };
  assert.equal(cleanRulesText(dfc), "CARDNAME gains you 2 life. Destroy target creature.");
  assert.equal(cleanRulesText({ name: "Grizzly Bears", type_line: "Creature — Bear", oracle_text: "" }), "Creature — Bear");
});

test("profileText and embeddingText prefer the AI profile", () => {
  const profile = { summary: "Blinks a creature.", mechanics: ["flicker", "etb-value"], synergies: ["ETB creatures", "tokens"] };
  assert.equal(profileText(profile), "Blinks a creature. Mechanics: flicker, etb-value. Synergies: ETB creatures; tokens.");
  const card = { name: "X", oracle_text: "Draw a card.", type_line: "Instant" };
  assert.equal(embeddingText(card, profile), profileText(profile));
  assert.equal(embeddingText(card, null), "Draw a card.");
});

test("dot and textHash", () => {
  assert.equal(dot(Float32Array.from([1, 2]), Float32Array.from([3, 4])), 11);
  assert.equal(textHash("a"), textHash("a"));
  assert.notEqual(textHash("a"), textHash("b"));
});

test("ensureEmbeddings only embeds new or changed texts, and vectors survive a reload", async () => {
  const dataDir = await tempDir();
  const store = createEmbeddingStore({ dataDir });
  const embedder = fakeEmbedder();
  const items = [{ oracleId: "o1", text: "alpha" }, { oracleId: "o2", text: "beta" }];
  assert.equal(await countStale({ items, store }), 2);
  assert.equal(await ensureEmbeddings({ items, store, embedder }), 2);
  assert.equal(await ensureEmbeddings({ items, store, embedder }), 0);
  assert.equal(await ensureEmbeddings({ items: [items[0], { oracleId: "o2", text: "beta changed" }], store, embedder }), 1);
  assert.deepEqual(embedder.calls.at(-1), ["beta changed"]);
  const reloaded = createEmbeddingStore({ dataDir });
  const v = (await reloaded.get("o1")).v;
  assert.ok(v instanceof Float32Array);
  assert.ok(Math.abs(v[0] - 0.05) < 1e-6);
});

test("vectors from a different model are discarded", async () => {
  const dataDir = await tempDir();
  await writeFile(join(dataDir, "collection-embeddings.json"), JSON.stringify({ model: "other-model", dims: 4, vectors: { o1: { h: "x", v: "AAAAAA==" } } }));
  assert.equal(await createEmbeddingStore({ dataDir }).get("o1"), null);
});

await run("Embeddings");
