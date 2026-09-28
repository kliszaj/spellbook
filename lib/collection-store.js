import { randomUUID } from "crypto";
import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";
import { defaultMode, diffAdd, diffSync, parseManaBoxCsv, slimCard } from "./collection.js";
import { postCardCollection } from "./scryfall.js";

export { ScryfallError } from "./scryfall.js";
export class PreviewExpiredError extends Error {}
export class PreviewStaleError extends Error {}

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const PREVIEW_MAX = 5;
const SCRYFALL_BATCH = 75; // /cards/collection accepts at most 75 identifiers
export const SCRYFALL_BATCH_PAUSE_MS = 500; // ~2 requests/second between batches
const EMPTY = { syncedAt: null, entries: {}, importedRows: [] };

export function createCollectionStore({
  dataDir,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  const collectionPath = join(dataDir, "collection.json");
  const cardsPath = join(dataDir, "collection-cards.json");
  const previews = new Map();
  let writeChain = Promise.resolve();

  const load = () => readJson(collectionPath, EMPTY);
  const loadCards = () => readJson(cardsPath, {});

  async function payload() {
    const [collection, cards] = await Promise.all([load(), loadCards()]);
    const visible = {};
    for (const e of Object.values(collection.entries)) {
      if (cards[e.scryfallId]) visible[e.scryfallId] = cards[e.scryfallId];
    }
    return { syncedAt: collection.syncedAt, entries: collection.entries, cards: visible };
  }

  async function preview(csv) {
    const rows = parseManaBoxCsv(csv);
    const current = await load();
    const sync = diffSync(current, rows);
    const add = diffAdd(current, rows);
    for (const [id, p] of previews) if (now() - p.at > PREVIEW_TTL_MS) previews.delete(id);
    const previewId = randomUUID();
    previews.set(previewId, { at: now(), sync, add, syncedAt: current.syncedAt });
    while (previews.size > PREVIEW_MAX) previews.delete(previews.keys().next().value);
    return {
      previewId,
      defaultMode: defaultMode(current, sync),
      sync: { summary: sync.summary, details: sync.details, warning: sync.warning },
      add: { summary: add.summary, details: add.details },
    };
  }

  async function lookup(ids) {
    const found = {};
    const notFound = new Set();
    for (let i = 0; i < ids.length; i += SCRYFALL_BATCH) {
      if (i) await sleep(SCRYFALL_BATCH_PAUSE_MS);
      const chunk = ids.slice(i, i + SCRYFALL_BATCH);
      const json = await postCardCollection(chunk.map((id) => ({ id })), { fetchImpl, sleep });
      for (const card of json.data || []) found[card.id] = slimCard(card);
      for (const nf of json.not_found || []) if (nf.id) notFound.add(nf.id);
    }
    return { found, notFound };
  }

  function apply(previewId, mode) {
    const run = writeChain.then(async () => {
      const p = previews.get(previewId);
      if (!p || now() - p.at > PREVIEW_TTL_MS) throw new PreviewExpiredError("Preview expired — upload the file again.");
      const { syncedAt } = await load();
      if (syncedAt !== p.syncedAt) {
        throw new PreviewStaleError("Your collection changed since this preview — upload the file again.");
      }
      const diff = mode === "add" ? p.add : p.sync;
      const cards = await loadCards();
      const referenced = new Set(Object.values(diff.entries).map((e) => e.scryfallId));
      const { found, notFound } = await lookup([...referenced].filter((id) => !cards[id])); // throws before any write
      Object.assign(cards, found);
      for (const id of Object.keys(cards)) if (!referenced.has(id)) delete cards[id];
      await writeJsonAtomic(cardsPath, cards);
      await writeJsonAtomic(collectionPath, {
        syncedAt: new Date(now()).toISOString(),
        entries: diff.entries,
        importedRows: diff.importedRows,
      });
      previews.delete(previewId);
      const unmatched = Object.values(diff.entries)
        .filter((e) => notFound.has(e.scryfallId))
        .map((e) => ({ scryfallId: e.scryfallId, name: e.name }));
      return { ...(await payload()), unmatched };
    });
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  return { load, loadCards, payload, preview, apply };
}
