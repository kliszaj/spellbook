// ManaBox CSV parsing and collection diffing. Pure functions — no IO.

export const REQUIRED_COLUMNS = ["Scryfall ID", "Quantity", "Name"];

export class CollectionFormatError extends Error {}

// RFC 4180: quoted fields, "" escapes, commas/newlines inside quotes, CRLF or LF, optional BOM.
export function parseCsv(text) {
  const src = String(text || "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function parseManaBoxCsv(text) {
  const [header = [], ...body] = parseCsv(text);
  const col = new Map(header.map((h, i) => [h.trim(), i]));
  const missing = REQUIRED_COLUMNS.filter((c) => !col.has(c));
  if (missing.length) {
    throw new CollectionFormatError(`This doesn't look like a ManaBox export (missing: ${missing.join(", ")})`);
  }
  const get = (r, name) => (col.has(name) ? r[col.get(name)] ?? "" : "");
  return body
    .map((r) => ({
      scryfallId: get(r, "Scryfall ID").trim(),
      foil: (get(r, "Foil").trim() || "normal").toLowerCase(),
      binder: get(r, "Binder Name"),
      qty: Math.max(0, parseInt(get(r, "Quantity"), 10) || 0),
      added: get(r, "Added").trim(),
      condition: get(r, "Condition").trim(),
      language: get(r, "Language").trim(),
      name: get(r, "Name").trim(),
      set: get(r, "Set code").trim(),
      number: get(r, "Collector number").trim(),
    }))
    .filter((r) => r.scryfallId && r.qty > 0);
}

export const entryKey = (r) => `${r.scryfallId}|${r.foil}|${r.binder}`;
export const rowFingerprint = (r) => `${entryKey(r)}|${r.condition}|${r.language}|${r.added}`;

const newEntry = (r) => ({
  scryfallId: r.scryfallId, foil: r.foil, binder: r.binder, qty: r.qty, added: r.added,
  name: r.name, set: r.set, number: r.number,
});

function detail(e, extra = {}) {
  return { name: e.name, set: e.set, number: e.number, foil: e.foil, binder: String(e.binder || "").trim(), qty: e.qty, ...extra };
}

export function aggregateRows(rows) {
  const entries = {};
  for (const r of rows) {
    const key = entryKey(r);
    const e = entries[key];
    if (!e) entries[key] = newEntry(r);
    else {
      e.qty += r.qty;
      if (r.added && (!e.added || r.added < e.added)) e.added = r.added;
    }
  }
  return entries;
}

export function totalQty(entries) {
  return Object.values(entries || {}).reduce((n, e) => n + e.qty, 0);
}

export function diffSync(current, rows) {
  const before = current?.entries || {};
  const next = aggregateRows(rows);
  const details = { added: [], changed: [], removed: [] };
  for (const [key, e] of Object.entries(next)) {
    const old = before[key];
    if (!old) { details.added.push(detail(e)); continue; }
    if (old.added && (!e.added || old.added < e.added)) e.added = old.added;
    if (old.qty !== e.qty) details.changed.push(detail(e, { qtyBefore: old.qty, qtyAfter: e.qty }));
  }
  let removedQty = 0;
  for (const [key, old] of Object.entries(before)) {
    if (!next[key]) { details.removed.push(detail(old)); removedQty += old.qty; }
  }
  const currentTotal = totalQty(before);
  const warning = currentTotal > 0 && removedQty > currentTotal / 2
    ? `This would remove ${removedQty.toLocaleString("en-US")} of ${currentTotal.toLocaleString("en-US")} cards — is this a whole-collection export?`
    : null;
  return {
    entries: next,
    importedRows: [...new Set(rows.map(rowFingerprint))],
    summary: { added: details.added.length, changed: details.changed.length, removed: details.removed.length, totalAfter: totalQty(next) },
    details,
    warning,
  };
}

export function diffAdd(current, rows) {
  const entries = structuredClone(current?.entries || {});
  const seen = new Set(current?.importedRows || []);
  const importedRows = [...seen];
  const details = { added: [], increased: [], skipped: [] };
  for (const r of rows) {
    const fp = rowFingerprint(r);
    if (seen.has(fp)) { details.skipped.push(detail(r)); continue; }
    seen.add(fp);
    importedRows.push(fp);
    const key = entryKey(r);
    const e = entries[key];
    if (!e) { entries[key] = newEntry(r); details.added.push(detail(r)); }
    else { details.increased.push(detail(r, { qtyBefore: e.qty, qtyAfter: e.qty + r.qty })); e.qty += r.qty; }
  }
  return {
    entries,
    importedRows,
    summary: {
      added: details.added.length,
      increased: details.increased.length,
      skipped: details.skipped.reduce((n, d) => n + d.qty, 0),
      totalAfter: totalQty(entries),
    },
    details,
  };
}

// A full sync that would wipe out most of the collection is almost certainly a
// partial export (e.g. one freshly scanned binder), so default to adding it.
export function defaultMode(current, syncDiff) {
  const total = totalQty(current?.entries);
  if (!total) return "sync";
  const removedQty = syncDiff.details.removed.reduce((n, d) => n + d.qty, 0);
  return removedQty > total / 2 ? "add" : "sync";
}

export const SLIM_CARD_FIELDS = [
  "id", "oracle_id", "name", "layout", "mana_cost", "cmc", "type_line", "oracle_text", "power", "toughness",
  "loyalty", "colors", "color_identity", "keywords", "produced_mana", "set", "set_name", "collector_number",
  "rarity", "scryfall_uri", "edhrec_rank",
];
const SLIM_FACE_FIELDS = ["name", "oracle_id", "mana_cost", "type_line", "oracle_text", "power", "toughness", "colors"];
const IMAGE_SIZES = ["small", "normal", "large", "png"];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

// Keep only what the app reads, so ~2,000 cards stay a few MB instead of tens.
export function slimCard(card) {
  const out = pick(card, SLIM_CARD_FIELDS);
  if (card.legalities?.commander) out.legalities = { commander: card.legalities.commander };
  if (card.prices) out.prices = { eur: card.prices.eur ?? null, eur_foil: card.prices.eur_foil ?? null, usd: card.prices.usd ?? null };
  if (card.image_uris) out.image_uris = pick(card.image_uris, IMAGE_SIZES);
  if (Array.isArray(card.card_faces)) {
    out.card_faces = card.card_faces.map((f) => {
      const face = pick(f, SLIM_FACE_FIELDS);
      if (f.image_uris) face.image_uris = pick(f.image_uris, IMAGE_SIZES);
      return face;
    });
  }
  return out;
}
