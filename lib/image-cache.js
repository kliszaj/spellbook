import { mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";

// On-disk cache for Scryfall card images, so every device on the LAN gets them from the
// server after the first fetch (and they keep working when Scryfall is unreachable).
// Only paths shaped like Scryfall's image CDN are accepted, so this can't be used as an
// open proxy: /img/<size>/<face>/<h>/<h>/<uuid>.<ext> → https://cards.scryfall.io/<same>.
const UPSTREAM = "https://cards.scryfall.io/";
const PATH_RE = /^(small|normal|large|art_crop|border_crop)\/(front|back)\/[0-9a-f]\/[0-9a-f]\/[0-9a-f-]{36}\.(jpg|png)$/;
const MAX_UPSTREAM = 6; // concurrent fetches to Scryfall's CDN

export function isCacheablePath(p) {
  return PATH_RE.test(String(p || ""));
}

// Rewrites a Scryfall image URL to the local cache route; anything else is returned as-is.
export function toCachedUrl(url) {
  const s = String(url || "");
  if (!s.startsWith(UPSTREAM)) return s;
  const p = s.slice(UPSTREAM.length).split("?")[0];
  return isCacheablePath(p) ? `/img/${p}` : s;
}

export function createImageCache({ dataDir, fetchImpl = fetch }) {
  const root = join(dataDir, "image-cache");
  const inFlight = new Map();
  let active = 0;
  const waiting = [];
  const slot = () => (active < MAX_UPSTREAM ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

  async function fetchAndStore(p, file) {
    await slot();
    try {
      const res = await fetchImpl(UPSTREAM + p, { headers: { "User-Agent": "Spellbook/1.0 (self-hosted)", Accept: "image/*" } });
      if (!res.ok) throw Object.assign(new Error(`Scryfall image ${res.status}`), { status: res.status === 404 ? 404 : 502 });
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, buf);
      await rename(tmp, file); // atomic: a half-written image is never served
      return buf;
    } finally {
      release();
    }
  }

  // Returns { buf, hit } for a validated path; concurrent requests share one fetch.
  async function get(p) {
    if (!isCacheablePath(p)) throw Object.assign(new Error("Not a card image path"), { status: 400 });
    const file = join(root, ...p.split("/"));
    try {
      await stat(file);
      return { buf: await readFile(file), hit: true };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    if (!inFlight.has(p)) inFlight.set(p, fetchAndStore(p, file).finally(() => inFlight.delete(p)));
    return { buf: await inFlight.get(p), hit: false };
  }

  return { get, root };
}
