import { randomUUID } from "crypto";
import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";
import { CollectionFormatError, MANUAL_BINDER, defaultMode, diffAdd, diffSync, parseManaBoxCsv, slimCard } from "./collection.js";
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

  function cardOracleId(card) {
    return card && (card.oracle_id || card.card_faces?.[0]?.oracle_id);
  }

  // Toggle-on: a normal collection entry in a synthetic binder, for cards never
  // scanned into ManaBox. No-op if some non-manual entry already owns this oracle id.
  function markOwned(scryfallId) {
    const run = writeChain.then(async () => {
      const [current, cards] = await Promise.all([load(), loadCards()]);
      let card = cards[scryfallId];
      if (!card) {
        const { found, notFound } = await lookup([scryfallId]); // throws before any write
        if (notFound.has(scryfallId) || !found[scryfallId]) throw new CollectionFormatError("Unknown card");
        card = found[scryfallId];
      }
      const oracleId = cardOracleId(card);
      const cardsWithNew = { ...cards, [scryfallId]: cards[scryfallId] || card };
      const alreadyOwned = Object.values(current.entries).some(
        (e) => !e.manual && cardOracleId(cardsWithNew[e.scryfallId]) === oracleId,
      );
      if (alreadyOwned) return payload();
      const key = `${scryfallId}|normal|${MANUAL_BINDER}`;
      const entries = {
        ...current.entries,
        [key]: {
          scryfallId, foil: "normal", binder: MANUAL_BINDER, qty: 1, added: new Date(now()).toISOString(),
          name: card.name, set: card.set, number: card.collector_number, manual: true,
        },
      };
      await writeJsonAtomic(cardsPath, cardsWithNew);
      await writeJsonAtomic(collectionPath, {
        syncedAt: new Date(now()).toISOString(),
        entries,
        importedRows: current.importedRows,
      });
      return payload();
    });
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  // Toggle-off: remove every manual entry for this oracle id and drop any card left
  // unreferenced by the remaining entries. No-op if no manual entry matched.
  function unmarkOwned(oracleId) {
    const run = writeChain.then(async () => {
      const [current, cards] = await Promise.all([load(), loadCards()]);
      const entries = { ...current.entries };
      let changed = false;
      for (const [key, e] of Object.entries(entries)) {
        if (e.manual && cardOracleId(cards[e.scryfallId]) === oracleId) {
          delete entries[key];
          changed = true;
        }
      }
      if (!changed) return payload();
      const referenced = new Set(Object.values(entries).map((e) => e.scryfallId));
      const nextCards = { ...cards };
      for (const id of Object.keys(nextCards)) if (!referenced.has(id)) delete nextCards[id];
      await writeJsonAtomic(cardsPath, nextCards);
      await writeJsonAtomic(collectionPath, {
        syncedAt: new Date(now()).toISOString(),
        entries,
        importedRows: current.importedRows,
      });
      return payload();
    });
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  return { load, loadCards, payload, preview, apply, markOwned, unmarkOwned };
}
