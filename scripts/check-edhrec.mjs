import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test, run } from "./lib/tiny-test.mjs";
import { commanderSlug, parseCommanderPage, createEdhrecClient, EdhrecError } from "../lib/edhrec.js";

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/edhrec/hei-bai-forest-guardian.json", import.meta.url), "utf8"));
const tempDir = () => mkdtemp(join(tmpdir(), "spellbook-edhrec-"));

// ── commanderSlug ────────────────────────────────────────────────────
test("commanderSlug: simple name", () => {
  assert.equal(commanderSlug("Hei Bai, Forest Guardian"), "hei-bai-forest-guardian");
});

test("commanderSlug: apostrophe is dropped, not dashed", () => {
  assert.equal(commanderSlug("Atraxa, Praetors' Voice"), "atraxa-praetors-voice");
});

test("commanderSlug: only the front face of a DFC name is used", () => {
  assert.equal(commanderSlug("Valki, God of Lies // Tibalt, Cosmic Impostor"), "valki-god-of-lies");
});

test("commanderSlug: apostrophe touching a letter doesn't leave a stray dash", () => {
  assert.equal(commanderSlug("K'rrik, Son of Yawgmoth"), "krrik-son-of-yawgmoth");
});

// ── parseCommanderPage ───────────────────────────────────────────────
test("parseCommanderPage: numDecks comes from container.json_dict.card.num_decks", () => {
  const { numDecks } = parseCommanderPage(FIXTURE);
  assert.equal(numDecks, 7174);
});

test("parseCommanderPage: inclusion is num_decks / potential_decks", () => {
  const { cards } = parseCommanderPage(FIXTURE);
  const sanctum = cards.find((c) => c.name === "Sanctum of All");
  assert.ok(sanctum);
  assert.equal(sanctum.numDecks, 6801);
  assert.ok(Math.abs(sanctum.inclusion - 6801 / 7174) < 1e-9);
  assert.ok(Math.abs(sanctum.synergy - 0.9054770430741654) < 1e-9);
});

test("parseCommanderPage: inclusion is 0 when potential_decks is 0 (never divides by zero)", () => {
  const json = {
    container: { json_dict: { card: { num_decks: 100 }, cardlists: [
      { header: "Top Cards", tag: "topcards", cardviews: [{ name: "Zero Potential", sanitized: "z", synergy: 0.1, num_decks: 0, potential_decks: 0 }] },
    ] } },
  };
  const { cards } = parseCommanderPage(json);
  assert.equal(cards[0].inclusion, 0);
});

test("parseCommanderPage: category is the first list header a card appears in, deduped by name", () => {
  const json = {
    container: { json_dict: { card: { num_decks: 10 }, cardlists: [
      { header: "High Synergy Cards", tag: "highsynergycards", cardviews: [{ name: "Dupe Card", sanitized: "d", synergy: 0.9, num_decks: 9, potential_decks: 10 }] },
      { header: "Creatures", tag: "creatures", cardviews: [
        { name: "Dupe Card", sanitized: "d", synergy: 0.1, num_decks: 1, potential_decks: 10 },
        { name: "Only Here", sanitized: "o", synergy: 0.4, num_decks: 4, potential_decks: 10 },
      ] },
    ] } },
  };
  const { cards } = parseCommanderPage(json);
  assert.equal(cards.length, 2); // "Dupe Card" counted once
  const dupe = cards.find((c) => c.name === "Dupe Card");
  assert.equal(dupe.category, "High Synergy Cards"); // first list wins
  assert.equal(dupe.synergy, 0.9); // first occurrence's stats, not the later one
  const onlyHere = cards.find((c) => c.name === "Only Here");
  assert.equal(onlyHere.category, "Creatures");
});

test("parseCommanderPage: covers every list header in the real fixture (24 cards, 6 categories)", () => {
  const { cards } = parseCommanderPage(FIXTURE);
  assert.equal(cards.length, 24);
  const categories = new Set(cards.map((c) => c.category));
  assert.deepEqual(categories, new Set(["High Synergy Cards", "Top Cards", "Creatures", "Instants", "Enchantments", "Lands"]));
});

// ── createEdhrecClient (fake fetch, no network) ─────────────────────
function fakeFetch(json, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => json };
  };
  return { fetchImpl, calls };
}

test("createEdhrecClient: caches in memory within the TTL (second call doesn't refetch)", async () => {
  const dataDir = await tempDir();
  const { fetchImpl, calls } = fakeFetch(FIXTURE);
  let now = 0;
  const client = createEdhrecClient({ dataDir, fetchImpl, now: () => now, ttlMs: 1000 });
  const first = await client.getCommander("Hei Bai, Forest Guardian");
  assert.equal(first.numDecks, 7174);
  now += 500;
  const second = await client.getCommander("Hei Bai, Forest Guardian");
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
});

test("createEdhrecClient: refetches once the TTL has passed", async () => {
  const dataDir = await tempDir();
  const { fetchImpl, calls } = fakeFetch(FIXTURE);
  let now = 0;
  const client = createEdhrecClient({ dataDir, fetchImpl, now: () => now, ttlMs: 1000 });
  await client.getCommander("Hei Bai, Forest Guardian");
  now += 2000;
  await client.getCommander("Hei Bai, Forest Guardian");
  assert.equal(calls.length, 2);
});

test("createEdhrecClient: requests the expected URL with the right headers", async () => {
  const dataDir = await tempDir();
  const { fetchImpl, calls } = fakeFetch(FIXTURE);
  const client = createEdhrecClient({ dataDir, fetchImpl });
  await client.getCommander("Atraxa, Praetors' Voice");
  assert.equal(calls[0].url, "https://json.edhrec.com/pages/commanders/atraxa-praetors-voice.json");
  assert.equal(calls[0].init.headers["User-Agent"], "Spellbook/0.1");
  assert.equal(calls[0].init.headers.Accept, "application/json");
});

test("createEdhrecClient: the on-disk cache survives a new client instance", async () => {
  const dataDir = await tempDir();
  const { fetchImpl, calls } = fakeFetch(FIXTURE);
  let now = 0;
  const clientA = createEdhrecClient({ dataDir, fetchImpl, now: () => now, ttlMs: 1000 });
  await clientA.getCommander("Hei Bai, Forest Guardian");
  assert.equal(calls.length, 1);

  // Second instance, empty in-memory cache, same on-disk cache directory.
  const clientB = createEdhrecClient({ dataDir, fetchImpl, now: () => now, ttlMs: 1000 });
  const data = await clientB.getCommander("Hei Bai, Forest Guardian");
  assert.equal(data.numDecks, 7174);
  assert.equal(calls.length, 1); // still fresh on disk — no network call

  const raw = JSON.parse(await readFile(join(dataDir, "edhrec-cache.json"), "utf8"));
  assert.ok(raw["hei-bai-forest-guardian"]);
});

test("createEdhrecClient: a fetch throw becomes 'Couldn't reach EDHREC.'", async () => {
  const dataDir = await tempDir();
  const fetchImpl = async () => { throw new Error("network down"); };
  const client = createEdhrecClient({ dataDir, fetchImpl });
  await assert.rejects(client.getCommander("Hei Bai, Forest Guardian"), (err) => {
    assert.ok(err instanceof EdhrecError);
    assert.equal(err.message, "Couldn't reach EDHREC.");
    return true;
  });
});

test("createEdhrecClient: a non-OK, non-404 status becomes 'Couldn't reach EDHREC.'", async () => {
  const dataDir = await tempDir();
  const { fetchImpl } = fakeFetch({}, { ok: false, status: 500 });
  const client = createEdhrecClient({ dataDir, fetchImpl });
  await assert.rejects(client.getCommander("Hei Bai, Forest Guardian"), (err) => {
    assert.ok(err instanceof EdhrecError);
    assert.equal(err.message, "Couldn't reach EDHREC.");
    return true;
  });
});

test("createEdhrecClient: a 404 becomes the no-page message", async () => {
  const dataDir = await tempDir();
  const { fetchImpl } = fakeFetch({}, { ok: false, status: 404 });
  const client = createEdhrecClient({ dataDir, fetchImpl });
  await assert.rejects(client.getCommander("Nobody, The Unbuilt"), (err) => {
    assert.ok(err instanceof EdhrecError);
    assert.equal(err.message, "EDHREC has no page for this commander.");
    return true;
  });
});

await run("EDHREC client");
