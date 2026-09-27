import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import { createCollectionStore, PreviewExpiredError, PreviewStaleError, ScryfallError } from "../lib/collection-store.js";

const HEADER = "Binder Name,Name,Set code,Collector number,Foil,Quantity,Scryfall ID,Condition,Language,Added";
const row = (id, qty = 1, binder = "Main", added = "2026-01-01T00:00:00.000Z") =>
  `${binder},Card ${id},SET,1,normal,${qty},${id},near_mint,en,${added}`;
const csv = (...rows) => [HEADER, ...rows].join("\n");
const tempDir = () => mkdtemp(join(tmpdir(), "spellbook-collection-"));
const exists = (p) => access(p).then(() => true, () => false);
const noSleep = async () => {};

function fakeScryfall({ fail = false, notFound = [], rateLimitFirst = false } = {}) {
  const requests = [];
  let rateLimited = false;
  const fetchImpl = async (url, init) => {
    const ids = JSON.parse(init.body).identifiers.map((i) => i.id);
    requests.push(ids);
    if (fail) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
    if (rateLimitFirst && !rateLimited) {
      rateLimited = true;
      return { ok: false, status: 429, headers: { get: (h) => (h === "Retry-After" ? "1" : null) }, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        data: ids.filter((id) => !notFound.includes(id)).map((id) => ({
          id, oracle_id: `o-${id}`, name: `Card ${id}`, type_line: "Instant", color_identity: [], artist: "Someone",
          legalities: { commander: "legal", modern: "legal" }, prices: { eur: "1.00", usd: "1.10", tix: "0.10" },
          image_uris: { normal: "n", art_crop: "a" },
        })),
        not_found: notFound.filter((id) => ids.includes(id)).map((id) => ({ id })),
      }),
    };
  };
  return { fetchImpl, requests };
}

test("preview + apply(sync) writes the collection and slim cards", async () => {
  const dataDir = await tempDir();
  const store = createCollectionStore({ dataDir, fetchImpl: fakeScryfall().fetchImpl, sleep: noSleep });
  const p = await store.preview(csv(row("a", 2), row("b")));
  assert.equal(p.defaultMode, "sync");
  assert.deepEqual(p.sync.summary, { added: 2, changed: 0, removed: 0, totalAfter: 3 });
  const result = await store.apply(p.previewId, "sync");
  assert.deepEqual(Object.keys(result.cards).sort(), ["a", "b"]);
  assert.equal(result.cards.a.artist, undefined);
  assert.deepEqual(result.unmatched, []);
  const saved = JSON.parse(await readFile(join(dataDir, "collection.json"), "utf8"));
  assert.equal(saved.entries["a|normal|Main"].qty, 2);
  assert.ok(saved.syncedAt);
});

test("a Scryfall failure writes nothing", async () => {
  const dataDir = await tempDir();
  const store = createCollectionStore({ dataDir, fetchImpl: fakeScryfall({ fail: true }).fetchImpl, sleep: noSleep });
  const p = await store.preview(csv(row("a")));
  await assert.rejects(store.apply(p.previewId, "sync"), ScryfallError);
  assert.equal(await exists(join(dataDir, "collection.json")), false);
  assert.equal(await exists(join(dataDir, "collection-cards.json")), false);
});

test("a rate-limited first request retries and still applies", async () => {
  const dataDir = await tempDir();
  const scry = fakeScryfall({ rateLimitFirst: true });
  const sleeps = [];
  const store = createCollectionStore({ dataDir, fetchImpl: scry.fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  const p = await store.preview(csv(row("a")));
  const result = await store.apply(p.previewId, "sync");
  assert.deepEqual(Object.keys(result.cards), ["a"]);
  assert.ok(sleeps.includes(1000));
  const saved = JSON.parse(await readFile(join(dataDir, "collection.json"), "utf8"));
  assert.ok(saved.entries["a|normal|Main"]);
});

test("an expired or unknown preview is rejected", async () => {
  let t = 0;
  const store = createCollectionStore({ dataDir: await tempDir(), fetchImpl: fakeScryfall().fetchImpl, sleep: noSleep, now: () => t });
  const p = await store.preview(csv(row("a")));
  t = 16 * 60 * 1000;
  await assert.rejects(store.apply(p.previewId, "sync"), PreviewExpiredError);
  await assert.rejects(store.apply("nope", "sync"), PreviewExpiredError);
});

test("cards Scryfall can't find stay in entries and are reported as unmatched", async () => {
  const store = createCollectionStore({ dataDir: await tempDir(), fetchImpl: fakeScryfall({ notFound: ["b"] }).fetchImpl, sleep: noSleep });
  const result = await store.apply((await store.preview(csv(row("a"), row("b")))).previewId, "sync");
  assert.deepEqual(result.unmatched, [{ scryfallId: "b", name: "Card b" }]);
  assert.ok(result.entries["b|normal|Main"]);
  assert.equal(result.cards.b, undefined);
});

test("only uncached cards are looked up, 75 per request", async () => {
  const scry = fakeScryfall();
  let sleeps = 0;
  const store = createCollectionStore({ dataDir: await tempDir(), fetchImpl: scry.fetchImpl, sleep: async () => { sleeps++; } });
  const ids = Array.from({ length: 80 }, (_, i) => `id${i}`);
  await store.apply((await store.preview(csv(...ids.map((id) => row(id))))).previewId, "sync");
  assert.deepEqual(scry.requests.map((r) => r.length), [75, 5]);
  assert.equal(sleeps, 1);
  await store.apply((await store.preview(csv(...ids.map((id) => row(id)), row("new")))).previewId, "sync");
  assert.deepEqual(scry.requests.at(-1), ["new"]);
});

test("add mode imports a scan once; uploading it again skips every row", async () => {
  const store = createCollectionStore({ dataDir: await tempDir(), fetchImpl: fakeScryfall().fetchImpl, sleep: noSleep });
  await store.apply((await store.preview(csv(row("a")))).previewId, "sync");
  const scan = csv(row("a", 1, "Main", "2026-09-01T00:00:00.000Z"), row("c", 1, "Scans", "2026-09-01T00:00:00.000Z"));
  const first = await store.preview(scan);
  assert.deepEqual(first.add.summary, { added: 1, increased: 1, skipped: 0, totalAfter: 3 });
  await store.apply(first.previewId, "add");
  const again = await store.preview(scan);
  assert.deepEqual(again.add.summary, { added: 0, increased: 0, skipped: 2, totalAfter: 3 });
});

test("sync drops cards no longer referenced from the card cache", async () => {
  const dataDir = await tempDir();
  const store = createCollectionStore({ dataDir, fetchImpl: fakeScryfall().fetchImpl, sleep: noSleep });
  await store.apply((await store.preview(csv(row("a"), row("b")))).previewId, "sync");
  await store.apply((await store.preview(csv(row("a")))).previewId, "sync");
  const cards = JSON.parse(await readFile(join(dataDir, "collection-cards.json"), "utf8"));
  assert.deepEqual(Object.keys(cards), ["a"]);
});

test("applying a preview after another apply already changed the collection is rejected as stale", async () => {
  const dataDir = await tempDir();
  const store = createCollectionStore({ dataDir, fetchImpl: fakeScryfall().fetchImpl, sleep: noSleep });
  const p1 = await store.preview(csv(row("a")));
  const p2 = await store.preview(csv(row("b")));
  await store.apply(p1.previewId, "sync");
  await assert.rejects(store.apply(p2.previewId, "sync"), PreviewStaleError);
  const saved = JSON.parse(await readFile(join(dataDir, "collection.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.entries), ["a|normal|Main"]);
  const cards = JSON.parse(await readFile(join(dataDir, "collection-cards.json"), "utf8"));
  assert.deepEqual(Object.keys(cards), ["a"]);
});

test("previews are capped at 5; the oldest is evicted", async () => {
  const dataDir = await tempDir();
  const store = createCollectionStore({ dataDir, fetchImpl: fakeScryfall().fetchImpl, sleep: noSleep });
  const previewIds = [];
  for (let i = 0; i < 6; i++) previewIds.push((await store.preview(csv(row(`c${i}`)))).previewId);
  await assert.rejects(store.apply(previewIds[0], "sync"), PreviewExpiredError);
  const result = await store.apply(previewIds[5], "sync");
  assert.deepEqual(Object.keys(result.cards), ["c5"]);
});

await run("Collection store");
