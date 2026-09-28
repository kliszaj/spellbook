// EDHREC (unofficial JSON API) client: commander page fetch + parse, with an
// in-memory + on-disk cache so repeat lookups for the same commander don't hit
// the network every render.
import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";

export class EdhrecError extends Error {}

const EDHREC_TTL_MS = 1000 * 60 * 60 * 24; // 24h

// Front face of a " // " name, lowercased, apostrophes dropped, then every run of
// non-alphanumeric characters collapsed to a single dash and trimmed.
// "Atraxa, Praetors' Voice" -> "atraxa-praetors-voice"; "K'rrik, Son of Yawgmoth" -> "krrik-son-of-yawgmoth".
export function commanderSlug(name) {
  return String(name || "")
    .split(" // ")[0]
    .trim()
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Parses a raw `json.edhrec.com/pages/commanders/<slug>.json` response into
// { numDecks, cards: [{ name, category, synergy, inclusion, numDecks }] }.
// A card can appear on more than one list (e.g. "High Synergy Cards" and
// "Creatures") — only the first list it appears in is kept as its category.
export function parseCommanderPage(json) {
  const dict = json?.container?.json_dict || {};
  const numDecks = dict.card?.num_decks || 0;
  const cardlists = Array.isArray(dict.cardlists) ? dict.cardlists : [];
  const seen = new Set();
  const cards = [];
  for (const list of cardlists) {
    const category = list?.header || "";
    const cardviews = Array.isArray(list?.cardviews) ? list.cardviews : [];
    for (const cv of cardviews) {
      const name = cv?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const potential = cv.potential_decks || 0;
      cards.push({
        name,
        category,
        synergy: typeof cv.synergy === "number" ? cv.synergy : 0,
        inclusion: potential ? (cv.num_decks || 0) / potential : 0,
        numDecks: cv.num_decks || 0,
      });
    }
  }
  return { numDecks, cards };
}

export function createEdhrecClient({ dataDir, fetchImpl = fetch, now = () => Date.now(), ttlMs = EDHREC_TTL_MS } = {}) {
  const cachePath = join(dataDir, "edhrec-cache.json");
  const memory = new Map(); // slug -> { ts, data }

  async function readDiskEntry(slug) {
    const disk = await readJson(cachePath, {});
    return disk[slug];
  }

  async function writeDiskEntry(slug, entry) {
    const disk = await readJson(cachePath, {});
    disk[slug] = entry;
    await writeJsonAtomic(cachePath, disk);
  }

  async function fetchCommander(slug) {
    let res;
    try {
      res = await fetchImpl(`https://json.edhrec.com/pages/commanders/${slug}.json`, {
        headers: { "User-Agent": "Spellbook/0.1", Accept: "application/json" },
      });
    } catch {
      throw new EdhrecError("Couldn't reach EDHREC.");
    }
    if (res.status === 404) throw new EdhrecError("EDHREC has no page for this commander.");
    if (!res.ok) throw new EdhrecError("Couldn't reach EDHREC.");
    let json;
    try {
      json = await res.json();
    } catch {
      throw new EdhrecError("Couldn't reach EDHREC.");
    }
    return parseCommanderPage(json);
  }

  async function getCommander(name) {
    const slug = commanderSlug(name);
    const fromMemory = memory.get(slug);
    if (fromMemory && now() - fromMemory.ts < ttlMs) return fromMemory.data;

    const fromDisk = await readDiskEntry(slug);
    if (fromDisk && now() - fromDisk.ts < ttlMs) {
      memory.set(slug, fromDisk);
      return fromDisk.data;
    }

    const data = await fetchCommander(slug);
    const entry = { ts: now(), data };
    memory.set(slug, entry);
    await writeDiskEntry(slug, entry);
    return data;
  }

  return { getCommander };
}
