import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import { createImageCache, isCacheablePath, toCachedUrl } from "../lib/image-cache.js";

const P = "normal/front/6/d/6da045f8-6278-4c84-9d39-025adf0789c1.jpg";

test("isCacheablePath accepts Scryfall image paths only", () => {
  assert.ok(isCacheablePath(P));
  assert.ok(isCacheablePath("large/back/0/a/0a1b2c3d-0000-4000-8000-000000000000.jpg"));
  assert.ok(!isCacheablePath("../state.json"));
  assert.ok(!isCacheablePath("normal/front/6/d/x.jpg"));
  assert.ok(!isCacheablePath(`normal/front/6/d/../../${P}`));
});

test("toCachedUrl rewrites Scryfall CDN URLs and leaves others alone", () => {
  assert.equal(toCachedUrl(`https://cards.scryfall.io/${P}?1562404626`), `/img/${P}`);
  assert.equal(toCachedUrl("https://example.com/a.jpg"), "https://example.com/a.jpg");
});

test("get fetches once, then serves from disk; concurrent requests share the fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
  const cache = createImageCache({ dataDir: await mkdtemp(join(tmpdir(), "spellbook-img-")), fetchImpl });
  const [a, b] = await Promise.all([cache.get(P), cache.get(P)]);
  assert.equal(calls, 1);
  assert.equal(a.hit, false);
  assert.deepEqual([...b.buf], [1, 2, 3]);
  const c = await cache.get(P);
  assert.equal(c.hit, true);
  assert.equal(calls, 1);
});

test("get rejects bad paths and passes through upstream 404s without caching", async () => {
  let calls = 0;
  const cache = createImageCache({ dataDir: await mkdtemp(join(tmpdir(), "spellbook-img-")), fetchImpl: async () => { calls++; return { ok: false, status: 404 }; } });
  await assert.rejects(cache.get("../x"), (e) => e.status === 400);
  await assert.rejects(cache.get(P), (e) => e.status === 404);
  await assert.rejects(cache.get(P), (e) => e.status === 404);
  assert.equal(calls, 2);
});

await run("Image cache");
