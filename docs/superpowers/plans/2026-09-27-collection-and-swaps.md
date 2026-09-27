# Collection Tab & View Swaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a ManaBox collection into a new Collection tab and, for any card, show owned replacements ranked by an AI that understands what cards do and how they fit the deck's game plan.

**Architecture:** New server logic lives in small ES modules under `lib/` (pure logic separated from IO so it is testable offline); `server.js` only wires routes. AI calls go through one client (`lib/ai-client.js`) that records spend. Card profiles (AI) and embeddings (local model) are cached in `DATA_DIR`. The frontend stays in the single `public/index.html`, following its existing patterns; its pure helpers sit in one marked block that a Node test evaluates.

**Tech Stack:** Node 22 (ESM), Express 4, `@anthropic-ai/sdk`, `@huggingface/transformers` 3.8.1 (native `onnxruntime-node`), vanilla JS/HTML/CSS, plain-Node test scripts (`scripts/check-*.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-27-collection-and-swaps-design.md`

## Global Constraints

- Deck-agnostic: no prompt, constant, or code path may name a specific deck or commander (tests assert this for the prompts).
- Default model: `claude-sonnet-5` (already set; the Settings provider/model drive every AI call).
- Never start AI profiling of more than `PROFILE_AUTO_LIMIT = 50` cards without the user pressing **Start**.
- AI rankings only on explicit View Swaps; every AI result cached; failed batches retried once, never looped.
- Tests never call a real AI or download the model (fakes are injected); only `test:swaps:model` and the pilot touch real services.
- Swap constants: `SWAP_SHORTLIST = 15`, `SWAP_MIN_MATCH = 40`, `SWAP_MAX_RESULTS = 8`, shortlist weights `0.60 text / 0.25 mechanics / 0.10 type / 0.05 mv`.
- Game plan limit 20,000 characters, never silently truncated in the UI.
- Upload row fingerprint: Scryfall ID | foil | binder | condition | language | Added. (The spec lists `Scryfall ID|Foil|Binder Name|Added`; condition and language are added so two copies scanned together in different conditions are not collapsed.)
- Collection entries also store `name`, `set`, `number` for preview/detail lists (small addition to the spec's entry shape).
- All new JSON files in `DATA_DIR` are written atomically (tmp + rename).
- Docker base image `node:22-slim`; data folder, port, and `compose.yaml` unchanged.
- UI verification is done by the user; do not use browser automation.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

Create:
- `lib/json-file.js` — `readJson`, `writeJsonAtomic`.
- `lib/collection.js` — pure CSV parsing, aggregation, diffs, slimming.
- `lib/collection-store.js` — collection files, previews, Scryfall lookup.
- `lib/ai-client.js` — provider-neutral JSON calls with usage + price; shared `parseJsonObject`, `callOpenAIJsonRaw`.
- `lib/ai-usage.js` — spend log.
- `lib/profiles.js` — AI card profiles: prompt, vocabulary, store, batch job.
- `lib/embeddings.js` — embedding texts, local model, embedding store.
- `lib/swaps.js` — candidate filters, shortlist, ranking prompt/parse, ranking cache.
- `lib/swaps-service.js` — prepare-job state machine and the `/api/swaps` flow.
- `lib/deck-notes.js` — Game plan normalization/merge for app state.
- `scripts/lib/tiny-test.mjs` — minimal test runner.
- `scripts/check-collection.mjs`, `check-collection-store.mjs`, `check-collection-ui.mjs`, `check-ai-client.mjs`, `check-profiles.mjs`, `check-embeddings.mjs`, `check-swaps.mjs`, `check-swaps-service.mjs`, `check-deck-notes.mjs`, `check-swaps-model.mjs`, `pilot-swaps.mjs`.
- `fixtures/collection/whole-export.csv`, `per-binder.csv`, `missing-columns.csv`.

Modify:
- `server.js` — imports, deck notes in app state, new routes, shared AI helpers.
- `public/index.html` — Collection tab, upload modal, View Swaps, Swaps view, Game plan, Owned badges, deck color filter.
- `package.json` / `package-lock.json` — dependency and scripts.
- `Dockerfile` — `node:22-slim`, models dir.
- `README.md` — Collection & Swaps section.

---

### Task 1: Collection CSV parsing and diffs

**Files:**
- Create: `scripts/lib/tiny-test.mjs`, `lib/collection.js`, `fixtures/collection/whole-export.csv`, `fixtures/collection/per-binder.csv`, `fixtures/collection/missing-columns.csv`
- Test: `scripts/check-collection.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces (`lib/collection.js`):
  - `parseCsv(text: string): string[][]`
  - `parseManaBoxCsv(text: string): Row[]` where `Row = { scryfallId, foil, binder, qty, added, condition, language, name, set, number }`; throws `CollectionFormatError`
  - `class CollectionFormatError extends Error`
  - `entryKey(row): string` = `scryfallId|foil|binder`; `rowFingerprint(row): string` = `entryKey|condition|language|added`
  - `aggregateRows(rows): Entries` where `Entries = { [key]: { scryfallId, foil, binder, qty, added, name, set, number } }`
  - `totalQty(entries): number`
  - `diffSync(current: {entries, importedRows}|null, rows): { entries, importedRows, summary: {added, changed, removed, totalAfter}, details: {added, changed, removed}, warning: string|null }`
  - `diffAdd(current, rows): { entries, importedRows, summary: {added, increased, skipped, totalAfter}, details: {added, increased, skipped} }`
  - `defaultMode(current, syncDiff): "sync"|"add"`
  - `slimCard(card): SlimCard`, `SLIM_CARD_FIELDS: string[]`
  - Detail rows: `{ name, set, number, foil, binder (trimmed), qty, qtyBefore?, qtyAfter? }`
- Produces (`scripts/lib/tiny-test.mjs`): `test(name, fn)`, `run(label)`

- [ ] **Step 1: Create the test runner**

`scripts/lib/tiny-test.mjs`:

```js
// Minimal test runner for the plain-Node check scripts.
const cases = [];

export function test(name, fn) {
  cases.push({ name, fn });
}

export async function run(label) {
  let failed = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
    } catch (err) {
      failed++;
      console.error(`✗ ${name}\n  ${err.stack || err.message}`);
    }
  }
  if (failed) {
    console.error(`${label}: ${failed} of ${cases.length} tests failed.`);
    process.exit(1);
  }
  console.log(`${label}: ${cases.length} tests passed.`);
}
```

- [ ] **Step 2: Create the fixtures**

`fixtures/collection/whole-export.csv`:

```csv
Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Signed,Condition,Language,Proxy,Purchase price currency,Added
New Releases,binder,Mountain,ECL,Lorwyn Eclipsed,272,foil,common,2,110313,295b92bc-d66f-45d8-9bbe-5f5f13e39fd4,0.23,false,false,false,near_mint,en,false,EUR,2026-01-18T15:41:37.551Z
New Releases,binder,Mountain,ECL,Lorwyn Eclipsed,272,foil,common,1,110313,295b92bc-d66f-45d8-9bbe-5f5f13e39fd4,0.23,false,false,false,lightly_played,en,false,EUR,2026-01-18T15:41:37.551Z
"all cards ",binder,Elfsworn Giant,FDN,Foundations,103,normal,common,1,100497,5128a5be-ffa6-4998-8488-872d80b24cb2,0.05,false,false,false,near_mint,en,false,EUR,2026-05-24T10:00:00.000Z
LotR and Hobbit,binder,"Grond, the Gatebreaker",LTR,The Lord of the Rings: Tales of Middle-earth,89,normal,uncommon,1,83056,4bc61b28-afdd-4de9-829b-ffe5ca7c7f19,0.09,false,false,false,near_mint,en,false,EUR,2026-05-26T16:41:28.830Z
```

`fixtures/collection/per-binder.csv`:

```csv
Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Signed,Condition,Language,Proxy,Purchase price currency,Added
Traitor's Clutch,TSP,Time Spiral,137,normal,common,1,26763,6313a601-5d26-487b-a70c-2c7184b7cc91,0.09,false,false,false,near_mint,en,false,EUR,2026-08-10T16:38:03.232Z
Eternal Thirst,IMA,Iconic Masters,89,normal,common,1,3536,14ab1802-1756-44cf-8cf5-ca69f24875f2,0.11,false,false,false,near_mint,en,false,EUR,2026-08-10T16:38:03.234Z
```

`fixtures/collection/missing-columns.csv`:

```csv
Name,Set code,Quantity
Sol Ring,C21,1
```

- [ ] **Step 3: Write the failing test**

`scripts/check-collection.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, run } from "./lib/tiny-test.mjs";
import {
  parseCsv, parseManaBoxCsv, CollectionFormatError, aggregateRows, entryKey, rowFingerprint,
  diffSync, diffAdd, defaultMode, totalQty, slimCard, SLIM_CARD_FIELDS,
} from "../lib/collection.js";

const fixture = (name) => readFileSync(new URL(`../fixtures/collection/${name}`, import.meta.url), "utf8");
const whole = fixture("whole-export.csv");
const lines = whole.trim().split("\n");
const MOUNTAIN_KEY = "295b92bc-d66f-45d8-9bbe-5f5f13e39fd4|foil|New Releases";

test("parseCsv handles quotes, escaped quotes, commas, BOM and CRLF", () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
});

test("parseManaBoxCsv reads a whole-collection export", () => {
  const rows = parseManaBoxCsv(whole);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].foil, "foil");
  assert.equal(rows[0].qty, 2);
  assert.equal(rows[2].binder, "all cards ");
  assert.equal(rows[3].name, "Grond, the Gatebreaker");
  assert.equal(rows[1].condition, "lightly_played");
});

test("parseManaBoxCsv accepts a BOM and CRLF line endings", () => {
  const rows = parseManaBoxCsv("\uFEFF" + whole.replace(/\r?\n/g, "\r\n"));
  assert.equal(rows.length, 4);
  assert.equal(rows[3].added, "2026-05-26T16:41:28.830Z");
});

test("parseManaBoxCsv accepts per-binder exports without binder columns", () => {
  const rows = parseManaBoxCsv(fixture("per-binder.csv"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].binder, "");
  assert.equal(rows[0].name, "Traitor's Clutch");
});

test("parseManaBoxCsv rejects files missing required columns", () => {
  assert.throws(
    () => parseManaBoxCsv(fixture("missing-columns.csv")),
    (err) => err instanceof CollectionFormatError && /missing: Scryfall ID/.test(err.message),
  );
});

test("aggregateRows sums rows sharing printing, foil and binder", () => {
  const entries = aggregateRows(parseManaBoxCsv(whole));
  assert.equal(Object.keys(entries).length, 3);
  assert.equal(entries[MOUNTAIN_KEY].qty, 3);
  assert.equal(totalQty(entries), 5);
});

test("row fingerprints include condition and language", () => {
  const [a, b] = parseManaBoxCsv(whole);
  assert.equal(entryKey(a), entryKey(b));
  assert.notEqual(rowFingerprint(a), rowFingerprint(b));
});

test("diffSync on a first upload adds everything without a warning", () => {
  const d = diffSync(null, parseManaBoxCsv(whole));
  assert.deepEqual(d.summary, { added: 3, changed: 0, removed: 0, totalAfter: 5 });
  assert.equal(d.warning, null);
  assert.equal(d.importedRows.length, 4);
});

test("diffSync reports new, changed and removed entries and keeps the stored added date", () => {
  const first = diffSync(null, parseManaBoxCsv(whole));
  const next = [
    lines[0], lines[1], lines[2],
    lines[3].replace(",1,100497,", ",2,100497,").replace("2026-05-24T10:00:00.000Z", "2026-09-01T00:00:00.000Z"),
    "New Releases,binder,Forest,ECL,Lorwyn Eclipsed,273,normal,common,1,110396,b460f5f7-c7c9-400c-8419-23d614f45bf9,0.16,false,false,false,near_mint,en,false,EUR,2026-01-18T15:41:37.551Z",
  ].join("\n");
  const d = diffSync({ entries: first.entries, importedRows: first.importedRows }, parseManaBoxCsv(next));
  assert.deepEqual(d.summary, { added: 1, changed: 1, removed: 1, totalAfter: 6 });
  assert.equal(d.details.changed[0].name, "Elfsworn Giant");
  assert.equal(d.details.changed[0].binder, "all cards");
  assert.deepEqual([d.details.changed[0].qtyBefore, d.details.changed[0].qtyAfter], [1, 2]);
  assert.equal(d.details.removed[0].name, "Grond, the Gatebreaker");
  const elf = Object.values(d.entries).find((e) => e.name === "Elfsworn Giant");
  assert.equal(elf.added, "2026-05-24T10:00:00.000Z");
  assert.equal(d.warning, null);
});

test("diffSync warns and defaultMode picks add when over half the cards would be removed", () => {
  const first = diffSync(null, parseManaBoxCsv(whole));
  const current = { entries: first.entries };
  const d = diffSync(current, parseManaBoxCsv([lines[0], lines[4]].join("\n")));
  assert.match(d.warning, /This would remove 4 of 5 cards/);
  assert.equal(defaultMode(current, d), "add");
});

test("defaultMode is sync for a first upload or a normal re-export", () => {
  const first = diffSync(null, parseManaBoxCsv(whole));
  assert.equal(defaultMode(null, first), "sync");
  const current = { entries: first.entries };
  assert.equal(defaultMode(current, diffSync(current, parseManaBoxCsv(whole))), "sync");
});

test("diffAdd adds new keys and increases existing ones without mutating the input", () => {
  const first = diffSync(null, parseManaBoxCsv(whole));
  const current = { entries: first.entries, importedRows: first.importedRows };
  const scan = [
    lines[0],
    "Pack scan,binder,Forest,ECL,Lorwyn Eclipsed,273,normal,common,2,110396,b460f5f7-c7c9-400c-8419-23d614f45bf9,0.16,false,false,false,near_mint,en,false,EUR,2026-09-20T12:00:00.000Z",
    "New Releases,binder,Mountain,ECL,Lorwyn Eclipsed,272,foil,common,1,110313,295b92bc-d66f-45d8-9bbe-5f5f13e39fd4,0.23,false,false,false,near_mint,en,false,EUR,2026-09-20T12:00:00.000Z",
  ].join("\n");
  const d = diffAdd(current, parseManaBoxCsv(scan));
  assert.deepEqual(d.summary, { added: 1, increased: 1, skipped: 0, totalAfter: 8 });
  assert.deepEqual([d.details.increased[0].qtyBefore, d.details.increased[0].qtyAfter], [3, 4]);
  assert.equal(current.entries[MOUNTAIN_KEY].qty, 3);
});

test("diffAdd skips rows already imported, so re-applying a file is a no-op", () => {
  const first = diffSync(null, parseManaBoxCsv(whole));
  const again = diffAdd({ entries: first.entries, importedRows: first.importedRows }, parseManaBoxCsv(whole));
  assert.deepEqual(again.summary, { added: 0, increased: 0, skipped: 5, totalAfter: 5 });
  assert.equal(again.importedRows.length, first.importedRows.length);
});

test("slimCard keeps only the documented fields", () => {
  const slim = slimCard({
    id: "x", oracle_id: "o", name: "N", type_line: "Instant", artist: "A",
    legalities: { commander: "legal", modern: "banned" },
    prices: { eur: "1", eur_foil: "2", usd: "3", tix: "4" },
    image_uris: { small: "s", normal: "n", large: "l", png: "p", art_crop: "a" },
    card_faces: [{ name: "F", oracle_text: "t", artist: "A", oracle_id: "o2", image_uris: { normal: "fn", art_crop: "fa" } }],
  });
  assert.equal(slim.artist, undefined);
  assert.deepEqual(slim.legalities, { commander: "legal" });
  assert.deepEqual(slim.prices, { eur: "1", eur_foil: "2", usd: "3" });
  assert.deepEqual(slim.image_uris, { small: "s", normal: "n", large: "l", png: "p" });
  assert.deepEqual(slim.card_faces, [{ name: "F", oracle_text: "t", oracle_id: "o2", image_uris: { normal: "fn" } }]);
  const extra = ["legalities", "prices", "image_uris", "card_faces"];
  assert.ok(Object.keys(slim).every((k) => SLIM_CARD_FIELDS.includes(k) || extra.includes(k)));
});

await run("Collection parsing");
```

- [ ] **Step 4: Run it to verify it fails**

Run: `node scripts/check-collection.mjs`
Expected: FAIL with `Cannot find module '.../lib/collection.js'`.

- [ ] **Step 5: Implement `lib/collection.js`**

```js
// ManaBox CSV parsing and collection diffing. Pure functions — no IO.

export const REQUIRED_COLUMNS = ["Scryfall ID", "Quantity", "Name"];

export class CollectionFormatError extends Error {}

// RFC 4180: quoted fields, "" escapes, commas/newlines inside quotes, CRLF or LF, optional BOM.
export function parseCsv(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node scripts/check-collection.mjs`
Expected: `Collection parsing: 14 tests passed.`

- [ ] **Step 7: Add the npm script**

In `package.json` `"scripts"`, add after `"test:deck-analysis"`:

```json
    "test:collection": "node scripts/check-collection.mjs"
```

Run: `npm run test:collection` → Expected: `Collection parsing: 14 tests passed.`

- [ ] **Step 8: Commit**

```bash
git add lib/collection.js scripts/lib/tiny-test.mjs scripts/check-collection.mjs fixtures/collection package.json
git commit -m "Add ManaBox CSV parsing and collection diffs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Collection store and Scryfall lookup

**Files:**
- Create: `lib/json-file.js`, `lib/collection-store.js`
- Test: `scripts/check-collection-store.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `parseManaBoxCsv`, `diffSync`, `diffAdd`, `defaultMode`, `slimCard` (Task 1).
- Produces (`lib/json-file.js`): `readJson(path, fallback): Promise<any>`, `writeJsonAtomic(path, value): Promise<void>`.
- Produces (`lib/collection-store.js`):
  - `createCollectionStore({ dataDir, fetchImpl?, sleep?, now? })` →
    - `load(): Promise<{ syncedAt: string|null, entries, importedRows: string[] }>`
    - `loadCards(): Promise<{ [scryfallId]: SlimCard }>`
    - `payload(): Promise<{ syncedAt, entries, cards }>` (cards only for entries Scryfall matched)
    - `preview(csv): Promise<{ previewId, defaultMode, sync: {summary, details, warning}, add: {summary, details} }>`
    - `apply(previewId, mode: "sync"|"add"): Promise<{ syncedAt, entries, cards, unmatched: {scryfallId, name}[] }>`
  - `class PreviewExpiredError`, `class ScryfallError`

- [ ] **Step 1: Write the failing test**

`scripts/check-collection-store.mjs`:

```js
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import { createCollectionStore, PreviewExpiredError, ScryfallError } from "../lib/collection-store.js";

const HEADER = "Binder Name,Name,Set code,Collector number,Foil,Quantity,Scryfall ID,Condition,Language,Added";
const row = (id, qty = 1, binder = "Main", added = "2026-01-01T00:00:00.000Z") =>
  `${binder},Card ${id},SET,1,normal,${qty},${id},near_mint,en,${added}`;
const csv = (...rows) => [HEADER, ...rows].join("\n");
const tempDir = () => mkdtemp(join(tmpdir(), "spellbook-collection-"));
const exists = (p) => access(p).then(() => true, () => false);
const noSleep = async () => {};

function fakeScryfall({ fail = false, notFound = [] } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const ids = JSON.parse(init.body).identifiers.map((i) => i.id);
    requests.push(ids);
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    return {
      ok: true,
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

await run("Collection store");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-collection-store.mjs`
Expected: FAIL with `Cannot find module '.../lib/collection-store.js'`.

- [ ] **Step 3: Implement `lib/json-file.js`**

```js
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

// Write to a temp file, then rename over the target, so a crash mid-write
// never leaves a half-written file behind.
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, "utf8");
  await rename(tmp, path);
}
```

- [ ] **Step 4: Implement `lib/collection-store.js`**

```js
import { randomUUID } from "crypto";
import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";
import { defaultMode, diffAdd, diffSync, parseManaBoxCsv, slimCard } from "./collection.js";

export class PreviewExpiredError extends Error {}
export class ScryfallError extends Error {}

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const SCRYFALL_BATCH = 75; // /cards/collection accepts at most 75 identifiers
const SCRYFALL_URL = "https://api.scryfall.com/cards/collection";
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
    previews.set(previewId, { at: now(), sync, add });
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
      if (i) await sleep(100); // Scryfall asks for ~10 requests/second at most
      const chunk = ids.slice(i, i + SCRYFALL_BATCH);
      let res;
      try {
        res = await fetchImpl(SCRYFALL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Spellbook/0.1" },
          body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }),
        });
      } catch {
        throw new ScryfallError("Couldn't reach Scryfall. Try again.");
      }
      if (!res.ok) throw new ScryfallError("Couldn't reach Scryfall. Try again.");
      const json = await res.json();
      for (const card of json.data || []) found[card.id] = slimCard(card);
      for (const nf of json.not_found || []) if (nf.id) notFound.add(nf.id);
    }
    return { found, notFound };
  }

  function apply(previewId, mode) {
    const run = writeChain.then(async () => {
      const p = previews.get(previewId);
      if (!p || now() - p.at > PREVIEW_TTL_MS) throw new PreviewExpiredError("Preview expired — upload the file again.");
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/check-collection-store.mjs`
Expected: `Collection store: 7 tests passed.`

- [ ] **Step 6: Extend the npm script**

In `package.json`, set:

```json
    "test:collection": "node scripts/check-collection.mjs && node scripts/check-collection-store.mjs"
```

Run: `npm run test:collection` → both suites pass.

- [ ] **Step 7: Commit**

```bash
git add lib/json-file.js lib/collection-store.js scripts/check-collection-store.mjs package.json
git commit -m "Add collection store with Scryfall lookup and previews

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: AI client and spend log

**Files:**
- Create: `lib/ai-client.js`, `lib/ai-usage.js`
- Test: `scripts/check-ai-client.mjs`
- Modify: `server.js:1-5` (imports), `server.js:630-640` (remove `parseJsonObject`), `server.js:648-670` (`callOpenAIJson` body), `package.json`

**Interfaces:**
- Produces (`lib/ai-client.js`):
  - `AI_PRICES: { [model]: [inputUsdPerMTok, outputUsdPerMTok] }`
  - `priceUsd(model, { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens }): number|null`
  - `supportsEffort(model): boolean`
  - `parseJsonObject(text): object`
  - `callOpenAIJsonRaw({ apiKey, model, system, user, maxTokens?, fetchImpl? }): Promise<{ data, usage: { inputTokens, outputTokens } }>`
  - `createAiClient({ provider, apiKey, model, anthropic?, fetchImpl? })` → `{ provider, model, json({ system, cachedContext?, user, maxTokens?, effort? }): Promise<{ data, usage, usd }> }`
- Produces (`lib/ai-usage.js`): `createUsageLog({ dataDir, now? })` → `{ record(entry): Promise<void>, monthUsd(): Promise<number> }`; entry = `{ feature, provider, model, inputTokens, outputTokens, cacheWriteTokens?, cacheReadTokens?, usd }`

- [ ] **Step 1: Write the failing test**

`scripts/check-ai-client.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import { priceUsd, supportsEffort, parseJsonObject, createAiClient } from "../lib/ai-client.js";
import { createUsageLog } from "../lib/ai-usage.js";

const close = (a, b) => Math.abs(a - b) < 1e-9;

test("priceUsd prices input, output and cache tokens", () => {
  assert.equal(priceUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 100_000 }), 3);
  assert.equal(priceUsd("claude-sonnet-5", { cacheWriteTokens: 1_000_000 }), 2.5);
  assert.ok(close(priceUsd("claude-sonnet-5", { cacheReadTokens: 1_000_000 }), 0.2));
  assert.equal(priceUsd("gpt-4.1", { inputTokens: 5 }), null);
});

test("supportsEffort matches models that accept output_config.effort", () => {
  for (const m of ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5"]) assert.ok(supportsEffort(m), m);
  for (const m of ["claude-haiku-4-5", "gpt-4.1", ""]) assert.ok(!supportsEffort(m), m);
});

test("parseJsonObject tolerates prose around the JSON", () => {
  assert.deepEqual(parseJsonObject('Here you go: {"a":1} thanks'), { a: 1 });
  assert.deepEqual(parseJsonObject(""), {});
});

function fakeAnthropic(reply) {
  const calls = [];
  return { calls, messages: { create: async (params) => { calls.push(params); return reply; } } };
}
const okReply = {
  stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"ok":true}' }],
  usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 0 },
};

test("anthropic json() caches the deck context block and sends effort when supported", async () => {
  const anthropic = fakeAnthropic(okReply);
  const ai = createAiClient({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5", anthropic });
  const r = await ai.json({ system: "SYS", cachedContext: "DECK", user: "USER", maxTokens: 1234, effort: "low" });
  const p = anthropic.calls[0];
  assert.deepEqual(p.system, [{ type: "text", text: "SYS" }, { type: "text", text: "DECK", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(p.output_config, { effort: "low" });
  assert.equal(p.max_tokens, 1234);
  assert.deepEqual(p.messages, [{ role: "user", content: "USER" }]);
  assert.deepEqual(r.data, { ok: true });
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 500, cacheReadTokens: 0 });
  assert.ok(close(r.usd, (1000 * 2 + 500 * 1.25 * 2 + 200 * 10) / 1e6));
});

test("anthropic json() omits effort for models that reject it", async () => {
  const anthropic = fakeAnthropic(okReply);
  await createAiClient({ provider: "anthropic", apiKey: "k", model: "claude-haiku-4-5", anthropic }).json({ system: "S", user: "U", effort: "low" });
  assert.equal(anthropic.calls[0].output_config, undefined);
  assert.deepEqual(anthropic.calls[0].system, [{ type: "text", text: "S" }]);
});

test("anthropic json() throws on refusal or truncation", async () => {
  for (const stop_reason of ["refusal", "max_tokens"]) {
    const ai = createAiClient({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5", anthropic: fakeAnthropic({ ...okReply, stop_reason }) });
    await assert.rejects(ai.json({ system: "S", user: "U" }));
  }
});

test("openai json() folds the deck context into the system prompt and reports usage", async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"x":2}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  };
  const r = await createAiClient({ provider: "openai", apiKey: "k", model: "gpt-4.1", fetchImpl }).json({ system: "S", cachedContext: "D", user: "U" });
  assert.equal(body.messages[0].content, "S\n\nD");
  assert.deepEqual(r.data, { x: 2 });
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5 });
  assert.equal(r.usd, null);
});

test("usage log sums this month's spend only", async () => {
  let now = new Date("2026-09-30T23:00:00Z");
  const log = createUsageLog({ dataDir: await mkdtemp(join(tmpdir(), "spellbook-usage-")), now: () => now });
  await log.record({ feature: "profile", usd: 1.25 });
  await log.record({ feature: "rank", usd: 0.5 });
  now = new Date("2026-10-01T01:00:00Z");
  await log.record({ feature: "rank", usd: 0.1 });
  assert.ok(close(await log.monthUsd(), 0.1));
  now = new Date("2026-09-15T00:00:00Z");
  assert.ok(close(await log.monthUsd(), 1.75));
});

await run("AI client");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-ai-client.mjs`
Expected: FAIL with `Cannot find module '.../lib/ai-client.js'`.

- [ ] **Step 3: Implement `lib/ai-client.js`**

```js
import Anthropic from "@anthropic-ai/sdk";

// $ per million tokens [input, output] — Anthropic list prices.
export const AI_PRICES = {
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-haiku-4-5": [1, 5],
  "claude-fable-5": [10, 50],
};

// Cache writes bill at 1.25x input, cache reads at 0.1x input.
export function priceUsd(model, u = {}) {
  const p = AI_PRICES[model];
  if (!p) return null;
  const input = (u.inputTokens || 0) + 1.25 * (u.cacheWriteTokens || 0) + 0.1 * (u.cacheReadTokens || 0);
  return (input * p[0] + (u.outputTokens || 0) * p[1]) / 1e6;
}

// output_config.effort is rejected (400) by Haiku 4.5 and older models.
const EFFORT_MODELS = /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable-5)/;
export const supportsEffort = (model) => EFFORT_MODELS.test(String(model || ""));

export function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    return start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : {};
  }
}

export async function callOpenAIJsonRaw({ apiKey, model, system, user, maxTokens = 2048, fetchImpl = fetch }) {
  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: maxTokens,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `OpenAI request failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return {
    data: parseJsonObject(data?.choices?.[0]?.message?.content || ""),
    usage: { inputTokens: data?.usage?.prompt_tokens || 0, outputTokens: data?.usage?.completion_tokens || 0 },
  };
}

// One JSON-returning call shape for both providers. `cachedContext` is the stable
// per-deck block: Anthropic caches it (cache_control), OpenAI just appends it.
export function createAiClient({ provider, apiKey, model, anthropic, fetchImpl = fetch }) {
  async function json({ system, cachedContext = "", user, maxTokens = 8000, effort }) {
    let data;
    let usage;
    if (provider === "openai") {
      const r = await callOpenAIJsonRaw({
        apiKey, model, maxTokens, fetchImpl,
        system: cachedContext ? `${system}\n\n${cachedContext}` : system,
        user,
      });
      data = r.data;
      usage = r.usage;
    } else {
      const client = anthropic || new Anthropic({ apiKey });
      const systemBlocks = [{ type: "text", text: system }];
      if (cachedContext) systemBlocks.push({ type: "text", text: cachedContext, cache_control: { type: "ephemeral" } });
      const message = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        ...(effort && supportsEffort(model) ? { output_config: { effort } } : {}),
        messages: [{ role: "user", content: user }],
      });
      if (message.stop_reason === "refusal") throw Object.assign(new Error("The AI declined this request."), { status: 422 });
      if (message.stop_reason === "max_tokens") throw new Error("The AI response was cut off.");
      data = parseJsonObject(message.content.find((b) => b.type === "text")?.text || "");
      usage = {
        inputTokens: message.usage?.input_tokens || 0,
        outputTokens: message.usage?.output_tokens || 0,
        cacheWriteTokens: message.usage?.cache_creation_input_tokens || 0,
        cacheReadTokens: message.usage?.cache_read_input_tokens || 0,
      };
    }
    return { data, usage, usd: priceUsd(model, usage) };
  }
  return { provider, model, json };
}
```

- [ ] **Step 4: Implement `lib/ai-usage.js`**

```js
import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";

// Append-only record of every swaps-related AI call, so the UI can show spend.
export function createUsageLog({ dataDir, now = () => new Date() }) {
  const path = join(dataDir, "ai-usage.json");
  let chain = Promise.resolve();

  function record(entry) {
    const run = chain.then(async () => {
      const log = await readJson(path, { entries: [] });
      log.entries.push({ at: now().toISOString(), ...entry });
      await writeJsonAtomic(path, log);
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function monthUsd() {
    await chain;
    const log = await readJson(path, { entries: [] });
    const month = now().toISOString().slice(0, 7);
    return log.entries.filter((e) => String(e.at).startsWith(month)).reduce((n, e) => n + (e.usd || 0), 0);
  }

  return { record, monthUsd };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/check-ai-client.mjs`
Expected: `AI client: 8 tests passed.`

- [ ] **Step 6: Make `server.js` use the shared helpers**

At the top of `server.js`, after `import express from "express";`, add:

```js
import { callOpenAIJsonRaw, parseJsonObject } from "./lib/ai-client.js";
```

Delete the whole `function parseJsonObject(text) { … }` block (currently `server.js:630-640`).

Replace the whole `async function callOpenAIJson({ apiKey, model, system, user, maxTokens = 2048 }) { … }` block (currently `server.js:648-670`) with:

```js
async function callOpenAIJson(args) {
  return (await callOpenAIJsonRaw(args)).data;
}
```

Run: `node --check server.js && npm run test:deck-analysis`
Expected: no syntax error; the deck-analysis suites pass.

- [ ] **Step 7: Add the npm script**

In `package.json`, add:

```json
    "test:swaps": "node scripts/check-ai-client.mjs"
```

Run: `npm run test:swaps` → `AI client: 8 tests passed.`

- [ ] **Step 8: Commit**

```bash
git add lib/ai-client.js lib/ai-usage.js scripts/check-ai-client.mjs server.js package.json
git commit -m "Add AI client with spend tracking; share JSON helpers with server

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: AI card profiles

**Files:**
- Create: `lib/profiles.js`
- Test: `scripts/check-profiles.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `readJson`, `writeJsonAtomic` (Task 2); `priceUsd` (Task 3); AI client shape `{ provider, model, json() }` (Task 3); usage log `{ record() }` (Task 3).
- Produces (`lib/profiles.js`):
  - `PROMPT_VERSION = 1`, `PROFILE_BATCH_SIZE = 25`, `PROFILE_TOKENS_PER_CARD = { input, output }`, `MECHANICS: string[]`, `PROFILE_SYSTEM_PROMPT: string`
  - `oracleIdOf(card): string|null`
  - `cardPromptLine(card, id): string`
  - `buildProfileRequest(cards): { user: string, ids: Map<string, oracleId> }`
  - `normalizeProfile(raw, model): Profile|null`, `Profile = { summary, mechanics: string[], synergies: string[], model }`
  - `parseProfileResponse(data, ids, model): { profiles: {[oracleId]: Profile}, missing: oracleId[] }`
  - `estimateProfileUsd(count, model): number|null`
  - `createProfileStore({ dataDir })` → `{ load(), get(oracleId): Promise<Profile|null>, pending(oracleIds): Promise<oracleId[]>, saveMany(profiles): Promise<void> }`
  - `runProfileJob({ cards, store, ai, usageLog, onProgress? }): Promise<{ profiled: number, failed: oracleId[] }>`
  - `profileOne(card, { store, ai, usageLog }): Promise<Profile|null>`

- [ ] **Step 1: Write the failing test**

`scripts/check-profiles.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import {
  MECHANICS, PROFILE_SYSTEM_PROMPT, PROMPT_VERSION, cardPromptLine, buildProfileRequest, normalizeProfile,
  parseProfileResponse, estimateProfileUsd, createProfileStore, runProfileJob, profileOne,
} from "../lib/profiles.js";

const tempDir = () => mkdtemp(join(tmpdir(), "spellbook-profiles-"));
const card = (n) => ({ id: `s${n}`, oracle_id: `o${n}`, name: `Card ${n}`, mana_cost: "{1}{U}", type_line: "Instant", oracle_text: `Draw ${n} cards.` });
const usageLog = () => { const entries = []; return { entries, record: async (e) => { entries.push(e); } }; };

// Answers profile requests by reading the "cN: Name" lines back out of the prompt.
function fakeAi({ skipOnce = [], skipAlways = [], failTimes = 0, failStatus } = {}) {
  const calls = [];
  const skipped = new Set();
  let fails = failTimes;
  return {
    provider: "anthropic", model: "claude-sonnet-5", calls,
    async json(req) {
      calls.push(req);
      if (fails > 0) { fails--; throw Object.assign(new Error("boom"), { status: failStatus }); }
      const cards = [...req.user.matchAll(/^(c\d+): ([^|\n]+)/gm)]
        .map(([, id, name]) => ({ id, name: name.trim() }))
        .filter(({ name }) => {
          if (skipAlways.includes(name)) return false;
          if (skipOnce.includes(name) && !skipped.has(name)) { skipped.add(name); return false; }
          return true;
        })
        .map(({ id, name }) => ({ id, summary: `Profile of ${name}.`, mechanics: ["card-draw", "not-a-tag"], synergies: ["spells"] }));
      return { data: { cards }, usage: { inputTokens: 100, outputTokens: 50 }, usd: 0.001 };
    },
  };
}

test("cardPromptLine formats single-faced and multi-faced cards", () => {
  assert.equal(cardPromptLine(card(1), "c1"), "c1: Card 1 | {1}{U} | Instant | Draw 1 cards.");
  const dfc = {
    name: "Front // Back",
    card_faces: [
      { name: "Front", mana_cost: "{G}", type_line: "Creature — Elf", oracle_text: "Tap: add {G}.", power: "1", toughness: "1" },
      { name: "Back", mana_cost: "", type_line: "Land", oracle_text: "Tap: add {G}." },
    ],
  };
  assert.equal(cardPromptLine(dfc, "c2"), "c2: Front // Back | Front | {G} | Creature — Elf | Tap: add {G}. | 1/1 // Back | Land | Tap: add {G}.");
});

test("the system prompt lists every mechanic and names no deck", () => {
  for (const m of MECHANICS) assert.ok(PROFILE_SYSTEM_PROMPT.includes(m), m);
  assert.doesNotMatch(PROFILE_SYSTEM_PROMPT, /hei bai|shrine|kynaios|mikaeus|giada/i);
});

test("buildProfileRequest maps short ids back to oracle ids", () => {
  const { user, ids } = buildProfileRequest([card(1), card(2)]);
  assert.match(user, /^c1: Card 1/m);
  assert.match(user, /^c2: Card 2/m);
  assert.deepEqual([...ids.entries()], [["c1", "o1"], ["c2", "o2"]]);
});

test("normalizeProfile keeps vocabulary tags only and caps lengths", () => {
  const p = normalizeProfile({ summary: "  Draws   cards. ", mechanics: ["card-draw", "Card-Draw", "made-up", "ramp"], synergies: ["a", "b", "c", "d", "e"] }, "m");
  assert.deepEqual(p, { summary: "Draws cards.", mechanics: ["card-draw", "ramp"], synergies: ["a", "b", "c", "d"], model: "m" });
  assert.equal(normalizeProfile({ summary: "" }, "m"), null);
});

test("parseProfileResponse reports cards the AI left out", () => {
  const { ids } = buildProfileRequest([card(1), card(2)]);
  const { profiles, missing } = parseProfileResponse({ cards: [{ id: "c1", summary: "x", mechanics: [] }, { id: "c9", summary: "y" }] }, ids, "m");
  assert.deepEqual(Object.keys(profiles), ["o1"]);
  assert.deepEqual(missing, ["o2"]);
});

test("runProfileJob profiles in batches of 25, records spend and saves progress", async () => {
  const dataDir = await tempDir();
  const store = createProfileStore({ dataDir });
  const ai = fakeAi();
  const log = usageLog();
  let last = 0;
  const cards = Array.from({ length: 30 }, (_, i) => card(i + 1));
  const result = await runProfileJob({ cards, store, ai, usageLog: log, onProgress: ({ profiled }) => { last = profiled; } });
  assert.deepEqual(result, { profiled: 30, failed: [] });
  assert.equal(ai.calls.length, 2);
  assert.equal(ai.calls[0].effort, "low");
  assert.equal(log.entries.length, 2);
  assert.equal(log.entries[0].feature, "profile");
  assert.equal(last, 30);
  const saved = JSON.parse(await readFile(join(dataDir, "card-profiles.json"), "utf8"));
  assert.equal(Object.keys(saved.profiles).length, 30);
  assert.deepEqual(saved.profiles.o1.mechanics, ["card-draw"]);
});

test("a card the AI skips once is retried once; skipped twice it is reported as failed", async () => {
  const cards = Array.from({ length: 30 }, (_, i) => card(i + 1));
  const once = await runProfileJob({ cards, store: createProfileStore({ dataDir: await tempDir() }), ai: fakeAi({ skipOnce: ["Card 3"] }), usageLog: usageLog() });
  assert.deepEqual(once, { profiled: 30, failed: [] });
  const ai = fakeAi({ skipAlways: ["Card 3"] });
  const always = await runProfileJob({ cards, store: createProfileStore({ dataDir: await tempDir() }), ai, usageLog: usageLog() });
  assert.deepEqual(always, { profiled: 29, failed: ["o3"] });
  assert.equal(ai.calls.length, 2);
});

test("a failed request is retried once; auth errors are not retried", async () => {
  const cards = [card(1)];
  const flaky = fakeAi({ failTimes: 1 });
  assert.deepEqual(await runProfileJob({ cards, store: createProfileStore({ dataDir: await tempDir() }), ai: flaky, usageLog: usageLog() }), { profiled: 1, failed: [] });
  await assert.rejects(runProfileJob({ cards, store: createProfileStore({ dataDir: await tempDir() }), ai: fakeAi({ failTimes: 2 }), usageLog: usageLog() }));
  const unauthorized = fakeAi({ failTimes: 1, failStatus: 401 });
  await assert.rejects(runProfileJob({ cards, store: createProfileStore({ dataDir: await tempDir() }), ai: unauthorized, usageLog: usageLog() }));
  assert.equal(unauthorized.calls.length, 1);
});

test("profiles from an older prompt version are ignored", async () => {
  const dataDir = await tempDir();
  await writeFile(join(dataDir, "card-profiles.json"), JSON.stringify({ promptVersion: PROMPT_VERSION - 1, profiles: { o1: { summary: "old" } } }));
  const store = createProfileStore({ dataDir });
  assert.equal(await store.get("o1"), null);
  assert.deepEqual(await store.pending(["o1"]), ["o1"]);
});

test("profileOne uses the cache before calling the AI", async () => {
  const store = createProfileStore({ dataDir: await tempDir() });
  const ai = fakeAi();
  const first = await profileOne(card(7), { store, ai, usageLog: usageLog() });
  const second = await profileOne(card(7), { store, ai, usageLog: usageLog() });
  assert.equal(first.summary, "Profile of Card 7.");
  assert.deepEqual(second, first);
  assert.equal(ai.calls.length, 1);
});

test("estimateProfileUsd uses the per-card token constants", () => {
  assert.ok(estimateProfileUsd(1000, "claude-sonnet-5") > 0);
  assert.equal(estimateProfileUsd(1000, "gpt-4.1"), null);
});

await run("Card profiles");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-profiles.mjs`
Expected: FAIL with `Cannot find module '.../lib/profiles.js'`.

- [ ] **Step 3: Implement `lib/profiles.js`**

```js
import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";
import { priceUsd } from "./ai-client.js";

// Bump when PROFILE_SYSTEM_PROMPT or MECHANICS change meaning: every profile is regenerated.
export const PROMPT_VERSION = 1;
export const PROFILE_BATCH_SIZE = 25;
// Average tokens per card in one batched profiling request. Starting values; Task 12
// replaces them with the pilot's measured numbers so estimates are realistic.
export const PROFILE_TOKENS_PER_CARD = { input: 150, output: 110 };

export const MECHANICS = [
  "flicker", "etb-value", "trigger-doubling", "ramp", "fast-mana", "mana-fixing", "cost-reduction", "untap",
  "card-draw", "card-selection", "tutor", "spot-removal", "board-wipe", "bounce", "counterspell", "protection",
  "pillowfort", "stax", "recursion", "reanimation", "self-mill", "graveyard-hate", "tokens", "plus-one-counters",
  "sacrifice-outlet", "death-trigger", "lifegain", "drain", "evasion", "combat-trick", "anthem", "copy", "theft",
  "extra-turn", "wincon", "enchantment-matters", "artifact-matters", "legends-matter", "tribal", "spellslinger",
  "landfall", "land", "vanilla",
];
const MECHANIC_SET = new Set(MECHANICS);

export const PROFILE_SYSTEM_PROMPT = `You profile Magic: The Gathering cards for Commander (EDH) deckbuilding. For each card, describe what it actually does and why a Commander deck plays it. Judge by function, not wording: a card that exiles your own creature and returns it is flicker, not removal.

Input lines look like: <id>: <name> | <mana cost> | <type line> | <rules text> | <power/toughness>. Multi-faced cards list their faces separated by " // ".

Respond with ONLY minified JSON, no prose or code fences:
{"cards":[{"id":"c1","summary":"...","mechanics":["..."],"synergies":["..."]}]}
- id: the exact id from the input line. Return exactly one entry per input card.
- summary: 1-2 sentences, under 220 characters, plain language: the effect and the job it does in a deck. Do not repeat the card name or mana cost.
- mechanics: 1-5 tags chosen ONLY from this list: ${MECHANICS.join(", ")}. Use "vanilla" only for cards with no rules text.
- synergies: up to 4 short phrases (under 50 characters each) naming what the card rewards or enables, e.g. "creatures with enters-the-battlefield abilities".`;

export function oracleIdOf(card) {
  return card?.oracle_id || card?.card_faces?.[0]?.oracle_id || null;
}

export function cardPromptLine(card, id) {
  const faces = !card.oracle_text && Array.isArray(card.card_faces) && card.card_faces.length ? card.card_faces : [card];
  const text = faces
    .map((f) => [
      f.name !== card.name ? f.name : "",
      f.mana_cost,
      f.type_line,
      String(f.oracle_text || "").replace(/\s+/g, " ").trim(),
      f.power != null ? `${f.power}/${f.toughness}` : "",
    ].filter(Boolean).join(" | "))
    .join(" // ");
  return `${id}: ${card.name} | ${text}`;
}

export function buildProfileRequest(cards) {
  const ids = new Map();
  const lines = cards.map((card, i) => {
    const id = `c${i + 1}`;
    ids.set(id, oracleIdOf(card));
    return cardPromptLine(card, id);
  });
  return { user: `Profile these ${cards.length} cards:\n${lines.join("\n")}`, ids };
}

export function normalizeProfile(raw, model) {
  if (!raw || typeof raw !== "object") return null;
  const summary = String(raw.summary || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!summary) return null;
  const mechanics = [...new Set((Array.isArray(raw.mechanics) ? raw.mechanics : [])
    .map((m) => String(m).trim().toLowerCase())
    .filter((m) => MECHANIC_SET.has(m)))].slice(0, 5);
  const synergies = (Array.isArray(raw.synergies) ? raw.synergies : [])
    .map((s) => String(s).replace(/\s+/g, " ").trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 4);
  return { summary, mechanics, synergies, model };
}

export function parseProfileResponse(data, ids, model) {
  const profiles = {};
  for (const item of Array.isArray(data?.cards) ? data.cards : []) {
    const oracleId = ids.get(String(item?.id || "").trim());
    const profile = oracleId ? normalizeProfile(item, model) : null;
    if (profile) profiles[oracleId] = profile;
  }
  const missing = [...ids.values()].filter((oid) => !profiles[oid]);
  return { profiles, missing };
}

export function estimateProfileUsd(count, model) {
  return priceUsd(model, {
    inputTokens: count * PROFILE_TOKENS_PER_CARD.input,
    outputTokens: count * PROFILE_TOKENS_PER_CARD.output,
  });
}

export function createProfileStore({ dataDir }) {
  const path = join(dataDir, "card-profiles.json");
  let cache = null;
  let chain = Promise.resolve();

  async function load() {
    if (!cache) {
      const raw = await readJson(path, null);
      cache = raw && raw.promptVersion === PROMPT_VERSION
        ? { promptVersion: PROMPT_VERSION, profiles: raw.profiles || {} }
        : { promptVersion: PROMPT_VERSION, profiles: {} };
    }
    return cache;
  }

  const get = async (oracleId) => (await load()).profiles[oracleId] || null;

  async function pending(oracleIds) {
    const { profiles } = await load();
    return oracleIds.filter((id) => !profiles[id]);
  }

  function saveMany(profiles) {
    const run = chain.then(async () => {
      const data = await load();
      Object.assign(data.profiles, profiles);
      await writeJsonAtomic(path, data);
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  return { load, get, pending, saveMany };
}

const NO_RETRY_STATUSES = new Set([400, 401, 403, 404]);

async function withOneRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (NO_RETRY_STATUSES.has(err.status)) throw err;
    return fn();
  }
}

async function recordUsage(usageLog, ai, r) {
  await usageLog?.record({ feature: "profile", provider: ai.provider, model: ai.model, ...r.usage, usd: r.usd });
}

// Profiles `cards` (one representative card per oracle id, all still unprofiled).
// A card the AI leaves out is retried once in a later batch, then reported as failed.
// A failing request is retried once; a second failure aborts the job (progress is saved).
export async function runProfileJob({ cards, store, ai, usageLog, onProgress = () => {} }) {
  const queue = cards.slice();
  const retried = new Set();
  const failed = [];
  let profiled = 0;
  while (queue.length) {
    const batch = queue.splice(0, PROFILE_BATCH_SIZE);
    const req = buildProfileRequest(batch);
    const r = await withOneRetry(() => ai.json({ system: PROFILE_SYSTEM_PROMPT, user: req.user, maxTokens: 16000, effort: "low" }));
    await recordUsage(usageLog, ai, r);
    const { profiles, missing } = parseProfileResponse(r.data, req.ids, ai.model);
    await store.saveMany(profiles);
    profiled += Object.keys(profiles).length;
    for (const oid of missing) {
      if (retried.has(oid)) failed.push(oid);
      else {
        retried.add(oid);
        queue.push(batch.find((c) => oracleIdOf(c) === oid));
      }
    }
    onProgress({ profiled });
  }
  return { profiled, failed };
}

export async function profileOne(card, { store, ai, usageLog }) {
  const oid = oracleIdOf(card);
  if (!oid) return null;
  const existing = await store.get(oid);
  if (existing) return existing;
  const req = buildProfileRequest([card]);
  const r = await ai.json({ system: PROFILE_SYSTEM_PROMPT, user: req.user, maxTokens: 4000, effort: "low" });
  await recordUsage(usageLog, ai, r);
  const { profiles } = parseProfileResponse(r.data, req.ids, ai.model);
  await store.saveMany(profiles);
  return profiles[oid] || null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/check-profiles.mjs`
Expected: `Card profiles: 11 tests passed.`

- [ ] **Step 5: Extend the npm script**

```json
    "test:swaps": "node scripts/check-ai-client.mjs && node scripts/check-profiles.mjs"
```

- [ ] **Step 6: Commit**

```bash
git add lib/profiles.js scripts/check-profiles.mjs package.json
git commit -m "Add AI card profiles with batching, retries, and cache

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Embeddings, local model, and Docker base image

**Files:**
- Create: `lib/embeddings.js`
- Test: `scripts/check-embeddings.mjs`, `scripts/check-swaps-model.mjs`
- Modify: `package.json`, `package-lock.json`, `Dockerfile`

**Interfaces:**
- Consumes: `readJson`, `writeJsonAtomic` (Task 2).
- Produces (`lib/embeddings.js`):
  - `EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2"`
  - `cleanRulesText(card): string`, `profileText(profile): string`, `embeddingText(card, profile|null): string`
  - `textHash(text): string`, `dot(a, b): number`
  - `createLocalEmbedder({ cacheDir }): Promise<{ embed(texts: string[]): Promise<Float32Array[]> }>`
  - `createEmbeddingStore({ dataDir })` → `{ load(), get(oracleId): Promise<{h, v: Float32Array}|null>, putMany([{oracleId, hash, vector}]), save() }`
  - `countStale({ items: [{oracleId, text}], store }): Promise<number>`
  - `ensureEmbeddings({ items, store, embedder, onProgress?, batchSize? }): Promise<number>` (number embedded)

- [ ] **Step 1: Install the model library**

Run: `npm install @huggingface/transformers@3.8.1`
Expected: `package.json` gains `"@huggingface/transformers": "^3.8.1"`; `onnxruntime-node` appears in `package-lock.json`.

- [ ] **Step 2: Write the failing test**

`scripts/check-embeddings.mjs`:

```js
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node scripts/check-embeddings.mjs`
Expected: FAIL with `Cannot find module '.../lib/embeddings.js'`.

- [ ] **Step 4: Implement `lib/embeddings.js`**

```js
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
  let cache = null;

  async function load() {
    if (!cache) {
      const raw = await readJson(path, null);
      cache = { model: EMBEDDING_MODEL, vectors: {} };
      if (raw && raw.model === EMBEDDING_MODEL) {
        for (const [id, e] of Object.entries(raw.vectors || {})) cache.vectors[id] = { h: e.h, v: fromBase64(e.v) };
      }
    }
    return cache;
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node scripts/check-embeddings.mjs`
Expected: `Embeddings: 5 tests passed.`

- [ ] **Step 6: Write the real-model sanity check**

`scripts/check-swaps-model.mjs`:

```js
// Slow check: downloads the real embedding model into data/models on first run.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, run } from "./lib/tiny-test.mjs";
import { cleanRulesText, createLocalEmbedder, dot, profileText } from "../lib/embeddings.js";

const cacheDir = join(fileURLToPath(new URL("..", import.meta.url)), "data", "models");
const embedder = await createLocalEmbedder({ cacheDir });
const sims = async (texts) => { const v = await embedder.embed(texts); return (i, j) => dot(v[i], v[j]); };

test("flicker profiles are closer to each other than to exile removal", async () => {
  const sim = await sims([
    profileText({ summary: "Temporarily exiles one of your creatures and returns it, re-triggering its enters-the-battlefield ability or dodging removal.", mechanics: ["flicker", "protection"], synergies: ["creatures with ETB abilities"] }),
    profileText({ summary: "Blinks your creatures at instant speed to reuse their enter effects and fizzle targeted removal.", mechanics: ["flicker", "etb-value"], synergies: ["ETB creatures"] }),
    profileText({ summary: "Permanently exiles an opponent's creature; efficient single-target removal.", mechanics: ["spot-removal"], synergies: [] }),
  ]);
  assert.ok(sim(0, 1) > sim(0, 2), `flicker~flicker ${sim(0, 1)} vs flicker~removal ${sim(0, 2)}`);
});

test("rules text: Cloudshift is closer to Conjurer's Closet than to Llanowar Elves", async () => {
  const sim = await sims([
    cleanRulesText({ name: "Cloudshift", oracle_text: "Exile target creature you control, then return that card to the battlefield under your control." }),
    cleanRulesText({ name: "Conjurer's Closet", oracle_text: "At the beginning of your end step, you may exile target creature you control, then return that card to the battlefield under your control." }),
    cleanRulesText({ name: "Llanowar Elves", oracle_text: "{T}: Add {G}." }),
  ]);
  assert.ok(sim(0, 1) > sim(0, 2));
});

await run("Embedding model");
```

Run: `node scripts/check-swaps-model.mjs`
Expected: first run downloads the model, then `Embedding model: 2 tests passed.`

- [ ] **Step 7: Switch the Docker base image**

Replace `Dockerfile` with:

```dockerfile
# glibc base: onnxruntime-node (local embedding model) has no musl/Alpine build.
FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN mkdir -p /app/data/models && chown -R node:node /app/data

COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

USER node

EXPOSE 3000

CMD ["npm", "start"]
```

(Note the new `COPY lib ./lib` — the server now imports from `lib/`.)

If Docker is available locally, run: `docker build -t kliszaj/spellbook:latest . && docker image ls kliszaj/spellbook:latest`
Expected: build succeeds; note the image size for the README (Task 12). If Docker is not installed locally, record that the build is verified on Unraid instead.

- [ ] **Step 8: Extend the npm scripts**

```json
    "test:swaps": "node scripts/check-ai-client.mjs && node scripts/check-profiles.mjs && node scripts/check-embeddings.mjs",
    "test:swaps:model": "node scripts/check-swaps-model.mjs"
```

- [ ] **Step 9: Commit**

```bash
git add lib/embeddings.js scripts/check-embeddings.mjs scripts/check-swaps-model.mjs package.json package-lock.json Dockerfile
git commit -m "Add local embedding model and switch Docker base to node:22-slim

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Swap filtering, shortlist, and AI ranking logic

**Files:**
- Create: `lib/swaps.js`
- Test: `scripts/check-swaps.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `dot` (Task 5); `cardPromptLine`, `oracleIdOf` (Task 4); `readJson`, `writeJsonAtomic` (Task 2).
- Produces (`lib/swaps.js`):
  - Constants `SWAP_SHORTLIST`, `SWAP_MIN_MATCH`, `SWAP_MAX_RESULTS`, `SHORTLIST_WEIGHTS`, `RANK_SYSTEM_PROMPT`
  - `isLand(card)`, `isBasicLand(card)`, `primaryTypes(card): Set`, `typeScore(a, b)`, `mvScore(a, b)`, `jaccard(a, b)`, `normalizeName(name)`
  - `Candidate = { oracleId, card, scryfallIds }`
  - `filterCandidates({ original, allowedIdentity, deckNames, candidates }): Candidate[]`
  - `shortlist({ original, originalVector, originalProfile, candidates, vectorFor, profileFor, size? }): (Candidate & { textScore, score })[]`
  - `deckContext(deck|null): string`; `Deck = { name, commander: {name, typeLine, text}|null, gamePlan, identityTags, cardNames, signature }`
  - `buildRankRequest({ deck, original, originalProfile, shortlisted, profileFor }): { system, cachedContext, user, ids }`
  - `parseRankResponse(data, ids): { oracleId, match, fits, reason }[]`
  - `finalizeAi(shortlisted, ranked)` / `finalizeLocal(shortlisted)`: `Result[]`, `Result = { oracle_id, scryfallIds, card, match, reason }`
  - `rankingCacheKey({ originalOracleId, deckSignature, gamePlan, syncedAt, model }): string`
  - `createRankingCache({ dataDir })` → `{ get(key): Promise<Result[]|null>, set(key, results): Promise<void> }`

- [ ] **Step 1: Write the failing test**

`scripts/check-swaps.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import {
  RANK_SYSTEM_PROMPT, SWAP_MAX_RESULTS, typeScore, mvScore, jaccard, filterCandidates, shortlist, deckContext,
  buildRankRequest, parseRankResponse, finalizeAi, finalizeLocal, rankingCacheKey, createRankingCache,
} from "../lib/swaps.js";

const mk = (name, extra = {}) => ({
  id: `s-${name}`, oracle_id: `o-${name}`, name, type_line: "Instant", cmc: 1, color_identity: ["W"],
  legalities: { commander: "legal" }, oracle_text: `${name} text.`, ...extra,
});
const cand = (card) => ({ oracleId: card.oracle_id, card, scryfallIds: [card.id] });

test("scoring helpers", () => {
  assert.equal(typeScore(mk("a"), mk("b")), 1);
  assert.equal(typeScore(mk("a"), mk("b", { type_line: "Sorcery" })), 0.5);
  assert.equal(typeScore(mk("a", { type_line: "Artifact Creature — Golem" }), mk("b", { type_line: "Creature — Elf" })), 0.5);
  assert.equal(typeScore(mk("a"), mk("b", { type_line: "Land" })), 0);
  assert.equal(mvScore(mk("a", { cmc: 1 }), mk("b", { cmc: 3 })), 0.5);
  assert.equal(mvScore(mk("a", { cmc: 1 }), mk("b", { cmc: 9 })), 0);
  assert.equal(jaccard(["x", "y"], ["y", "z"]), 1 / 3);
  assert.equal(jaccard([], ["y"]), 0);
});

test("filterCandidates applies every rule", () => {
  const original = mk("Cloudshift");
  const keep = mk("Ephemeral Blink");
  const candidates = [
    cand(keep),
    cand({ ...mk("Cloudshift"), id: "s-other-printing" }),
    cand(mk("In The Deck")),
    cand(mk("Blue Card", { color_identity: ["U"] })),
    cand(mk("Banned Card", { legalities: { commander: "banned" } })),
    cand(mk("Some Land", { type_line: "Land" })),
    cand(mk("Plains", { type_line: "Basic Land — Plains" })),
  ];
  const out = filterCandidates({ original, allowedIdentity: ["W"], deckNames: ["In The Deck"], candidates });
  assert.deepEqual(out.map((c) => c.card.name), ["Ephemeral Blink"]);
  const landOut = filterCandidates({ original: mk("Temple", { type_line: "Land" }), allowedIdentity: ["W"], deckNames: [], candidates });
  assert.deepEqual(landOut.map((c) => c.card.name), ["Some Land"]);
});

test("shortlist blends text, mechanics, type and mana value", () => {
  const original = mk("Orig");
  const a = cand(mk("A"));
  const b = cand(mk("B"));
  const vectors = { "o-A": Float32Array.from([1, 0]), "o-B": Float32Array.from([0, 1]) };
  const profiles = { "o-A": { mechanics: ["flicker"] }, "o-B": { mechanics: ["flicker"] } };
  const args = { original, originalVector: Float32Array.from([1, 0]), candidates: [b, a], vectorFor: (id) => vectors[id], profileFor: (id) => profiles[id] };
  const withMech = shortlist({ ...args, originalProfile: { mechanics: ["flicker"] } });
  assert.deepEqual(withMech.map((c) => c.card.name), ["A", "B"]);
  assert.ok(Math.abs(withMech[0].score - 1) < 1e-9);
  assert.ok(Math.abs(withMech[1].score - 0.4) < 1e-9);
  const noMech = shortlist({ ...args, originalProfile: null });
  assert.ok(Math.abs(noMech[1].score - 0.15) < 1e-9);
  assert.equal(shortlist({ ...args, originalProfile: null, size: 1 }).length, 1);
});

test("deckContext includes the plan, commander and decklist, with a fallback when there is no plan", () => {
  const deck = { name: "Test Deck", commander: { name: "Cmdr", typeLine: "Legendary Creature", text: "Does things." }, gamePlan: "Win by flickering.", identityTags: ["Blink / Flicker"], cardNames: ["A", "B"] };
  const ctx = deckContext(deck);
  for (const part of ["DECK: Test Deck", "Commander: Cmdr | Legendary Creature | Does things.", "Win by flickering.", "Deck themes: Blink / Flicker", "Decklist: A; B"]) assert.ok(ctx.includes(part), part);
  assert.match(deckContext({ ...deck, gamePlan: "" }), /Not provided — infer the plan/);
  assert.match(deckContext(null), /DECK: none/);
});

test("buildRankRequest puts the deck in the cached block and candidates in the user message", () => {
  const shortlisted = [cand(mk("A")), cand(mk("B"))];
  const req = buildRankRequest({
    deck: { name: "D", commander: null, gamePlan: "Plan", identityTags: [], cardNames: [] },
    original: mk("Orig"), originalProfile: { summary: "Blinks.", mechanics: ["flicker"] },
    shortlisted, profileFor: () => ({ summary: "Also blinks.", mechanics: ["flicker"] }),
  });
  assert.equal(req.system, RANK_SYSTEM_PROMPT);
  assert.ok(req.cachedContext.includes("Plan"));
  assert.match(req.user, /^original: Orig/m);
  assert.match(req.user, /^k1: A/m);
  assert.match(req.user, /Does: Also blinks\. \[flicker\]/);
  assert.deepEqual([...req.ids.entries()], [["k1", "o-A"], ["k2", "o-B"]]);
});

test("parseRankResponse clamps and maps ids", () => {
  const ids = new Map([["k1", "o1"], ["k2", "o2"]]);
  const out = parseRankResponse({ results: [{ id: "k1", match: 140, fits: true, reason: "  Great   fit " }, { id: "k9", match: 50 }, { id: "k2", match: "55.4", fits: "yes" }] }, ids);
  assert.deepEqual(out, [
    { oracleId: "o1", match: 100, fits: true, reason: "Great fit" },
    { oracleId: "o2", match: 55, fits: false, reason: "" },
  ]);
});

test("finalizeAi keeps fitting results above the threshold, best first, capped", () => {
  const shortlisted = Array.from({ length: 12 }, (_, i) => cand(mk(`C${i}`)));
  const ranked = shortlisted.map((c, i) => ({ oracleId: c.oracleId, match: 95 - i * 5, fits: i !== 1, reason: `r${i}` }));
  const out = finalizeAi(shortlisted, ranked);
  assert.equal(out.length, SWAP_MAX_RESULTS);
  assert.deepEqual(out.slice(0, 2).map((r) => r.card.name), ["C0", "C2"]);
  assert.ok(out.every((r) => r.match >= 40));
  assert.deepEqual(Object.keys(out[0]).sort(), ["card", "match", "oracle_id", "reason", "scryfallIds"]);
});

test("finalizeLocal uses the shortlist score with the same threshold", () => {
  const out = finalizeLocal([{ ...cand(mk("Hi")), score: 0.8 }, { ...cand(mk("Lo")), score: 0.39 }]);
  assert.deepEqual(out.map((r) => [r.card.name, r.match, r.reason]), [["Hi", 80, ""]]);
});

test("rankingCacheKey changes with the deck version, game plan, collection sync and model", () => {
  const base = { originalOracleId: "o", deckSignature: "sig", gamePlan: "plan", syncedAt: "t1", model: "m" };
  const key = rankingCacheKey(base);
  assert.equal(rankingCacheKey({ ...base }), key);
  for (const change of [{ deckSignature: "sig2" }, { gamePlan: "plan2" }, { syncedAt: "t2" }, { model: "m2" }]) {
    assert.notEqual(rankingCacheKey({ ...base, ...change }), key);
  }
});

test("ranking cache persists across instances", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "spellbook-rank-"));
  await createRankingCache({ dataDir }).set("k", [{ match: 70 }]);
  assert.deepEqual(await createRankingCache({ dataDir }).get("k"), [{ match: 70 }]);
  assert.equal(await createRankingCache({ dataDir }).get("missing"), null);
});

test("the ranking prompt names no deck", () => {
  assert.doesNotMatch(RANK_SYSTEM_PROMPT, /hei bai|shrine|kynaios|mikaeus|giada/i);
});

await run("Swaps ranking");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-swaps.mjs`
Expected: FAIL with `Cannot find module '.../lib/swaps.js'`.

- [ ] **Step 3: Implement `lib/swaps.js`**

```js
import { createHash } from "crypto";
import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";
import { dot } from "./embeddings.js";
import { cardPromptLine, oracleIdOf } from "./profiles.js";

export const SWAP_SHORTLIST = 15;
export const SWAP_MIN_MATCH = 40;
export const SWAP_MAX_RESULTS = 8;
export const SHORTLIST_WEIGHTS = { text: 0.6, mechanics: 0.25, type: 0.1, mv: 0.05 };

const PRIMARY_TYPES = ["Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker", "Battle", "Land"];
const frontType = (c) => (c.type_line || c.card_faces?.[0]?.type_line || "").split(" // ")[0];

export const isLand = (c) => /\bLand\b/.test(frontType(c));
export const isBasicLand = (c) => /\bBasic\b/.test(frontType(c)) && isLand(c);
export const primaryTypes = (c) => new Set(PRIMARY_TYPES.filter((t) => frontType(c).includes(t)));
export const normalizeName = (name) => String(name || "").split(" // ")[0].trim().toLowerCase();

export function typeScore(a, b) {
  const A = primaryTypes(a);
  const B = primaryTypes(b);
  if (A.size === B.size && [...A].every((t) => B.has(t))) return 1;
  if ([...A].some((t) => B.has(t))) return 0.5;
  if ((A.has("Instant") && B.has("Sorcery")) || (A.has("Sorcery") && B.has("Instant"))) return 0.5;
  return 0;
}

export const mvScore = (a, b) => Math.max(0, 1 - Math.abs((a.cmc || 0) - (b.cmc || 0)) / 4);

export function jaccard(a = [], b = []) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  return shared / new Set([...A, ...B]).size;
}

export function filterCandidates({ original, allowedIdentity, deckNames, candidates }) {
  const allowed = new Set((allowedIdentity || []).map((c) => String(c).toUpperCase()));
  const excluded = new Set((deckNames || []).map(normalizeName));
  const originalOid = oracleIdOf(original);
  const originalIsLand = isLand(original);
  return candidates.filter(({ card, oracleId }) =>
    oracleId !== originalOid
    && !excluded.has(normalizeName(card.name))
    && (card.color_identity || []).every((c) => allowed.has(c))
    && card.legalities?.commander === "legal"
    && isLand(card) === originalIsLand
    && !isBasicLand(card));
}

export function shortlist({ original, originalVector, originalProfile, candidates, vectorFor, profileFor, size = SWAP_SHORTLIST }) {
  const w = SHORTLIST_WEIGHTS;
  return candidates
    .map((c) => {
      const vec = vectorFor(c.oracleId);
      const text = vec ? dot(originalVector, vec) : 0;
      const profile = profileFor(c.oracleId);
      // Without mechanics on both sides, that weight moves onto text similarity.
      const hasMechanics = Boolean(originalProfile?.mechanics?.length && profile?.mechanics?.length);
      const score = (hasMechanics ? w.text : w.text + w.mechanics) * text
        + (hasMechanics ? w.mechanics * jaccard(originalProfile.mechanics, profile.mechanics) : 0)
        + w.type * typeScore(original, c.card)
        + w.mv * mvScore(original, c.card);
      return { ...c, textScore: text, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, size);
}

export const RANK_SYSTEM_PROMPT = `You are an expert Commander (EDH) deckbuilder. A player wants to replace one card in their deck with a card they already own, so they don't have to buy it. You get the deck (commander, the player's game plan if provided, and the decklist), the card to replace, and candidate cards from the player's collection, each with a short profile of what it does.

For each candidate, judge it as a replacement IN THIS DECK: does it do the same job the replaced card does here, and does it work with this commander and game plan? Judge by function and synergy, not shared wording: a card that shares keywords but not the role should score low. If the game plan is missing, infer it from the commander and decklist.

Respond with ONLY minified JSON, no prose or code fences:
{"results":[{"id":"k1","match":72,"fits":true,"reason":"..."}]}
- id: the candidate's exact id. Return exactly one entry per candidate.
- match: 0-100, how well it replaces the card in this deck (100 = does the same job at least as well here).
- fits: true only if a thoughtful player of this deck would actually make this swap.
- reason: one sentence under 140 characters: what it does for this deck, plus the main tradeoff if any.`;

const profileLine = (p) => (p ? `   Does: ${p.summary} [${(p.mechanics || []).join(", ")}]` : "");

export function deckContext(deck) {
  if (!deck) return "DECK: none — judge the candidates as general replacements in a Commander deck of these colors.";
  const plan = String(deck.gamePlan || "").trim();
  return [
    `DECK: ${deck.name || "Unnamed deck"}`,
    deck.commander
      ? `Commander: ${deck.commander.name} | ${deck.commander.typeLine || ""} | ${String(deck.commander.text || "").replace(/\s+/g, " ").trim()}`
      : "Commander: none set",
    `Game plan (written by the player; may include website boilerplate to ignore):\n${plan || "Not provided — infer the plan from the commander and decklist."}`,
    deck.identityTags?.length ? `Deck themes: ${deck.identityTags.join(", ")}` : "",
    `Decklist: ${(deck.cardNames || []).join("; ")}`,
  ].filter(Boolean).join("\n");
}

export function buildRankRequest({ deck, original, originalProfile, shortlisted, profileFor }) {
  const ids = new Map();
  const lines = shortlisted.map((c, i) => {
    const id = `k${i + 1}`;
    ids.set(id, c.oracleId);
    return [cardPromptLine(c.card, id), profileLine(profileFor(c.oracleId))].filter(Boolean).join("\n");
  });
  const user = [
    "CARD TO REPLACE:",
    [cardPromptLine(original, "original"), profileLine(originalProfile)].filter(Boolean).join("\n"),
    "",
    "CANDIDATES FROM THE PLAYER'S COLLECTION:",
    ...lines,
  ].join("\n");
  return { system: RANK_SYSTEM_PROMPT, cachedContext: deckContext(deck), user, ids };
}

export function parseRankResponse(data, ids) {
  const out = [];
  for (const r of Array.isArray(data?.results) ? data.results : []) {
    const oracleId = ids.get(String(r?.id || "").trim());
    if (!oracleId) continue;
    out.push({
      oracleId,
      match: Math.max(0, Math.min(100, Math.round(Number(r.match) || 0))),
      fits: r.fits === true,
      reason: String(r.reason || "").replace(/\s+/g, " ").trim().slice(0, 160),
    });
  }
  return out;
}

const resultItem = (c, match, reason) => ({ oracle_id: c.oracleId, scryfallIds: c.scryfallIds, card: c.card, match, reason });

export function finalizeAi(shortlisted, ranked) {
  const byOid = new Map(shortlisted.map((c) => [c.oracleId, c]));
  return ranked
    .filter((r) => r.fits && r.match >= SWAP_MIN_MATCH && byOid.has(r.oracleId))
    .sort((a, b) => b.match - a.match)
    .slice(0, SWAP_MAX_RESULTS)
    .map((r) => resultItem(byOid.get(r.oracleId), r.match, r.reason));
}

export function finalizeLocal(shortlisted) {
  return shortlisted
    .map((c) => ({ c, match: Math.round(c.score * 100) }))
    .filter((x) => x.match >= SWAP_MIN_MATCH)
    .sort((a, b) => b.match - a.match)
    .slice(0, SWAP_MAX_RESULTS)
    .map((x) => resultItem(x.c, x.match, ""));
}

export function rankingCacheKey({ originalOracleId, deckSignature, gamePlan, syncedAt, model }) {
  return createHash("sha1")
    .update(JSON.stringify([originalOracleId, deckSignature || "", String(gamePlan || ""), syncedAt || "", model || ""]))
    .digest("hex");
}

export function createRankingCache({ dataDir }) {
  const path = join(dataDir, "swap-rankings.json");
  let cache = null;
  let chain = Promise.resolve();
  const load = async () => (cache ||= await readJson(path, {}));
  const get = async (key) => (await load())[key] || null;
  function set(key, results) {
    const run = chain.then(async () => {
      const data = await load();
      data[key] = results;
      await writeJsonAtomic(path, data);
    });
    chain = run.then(() => {}, () => {});
    return run;
  }
  return { get, set };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/check-swaps.mjs`
Expected: `Swaps ranking: 11 tests passed.`

- [ ] **Step 5: Extend the npm script**

```json
    "test:swaps": "node scripts/check-ai-client.mjs && node scripts/check-profiles.mjs && node scripts/check-embeddings.mjs && node scripts/check-swaps.mjs",
```

- [ ] **Step 6: Commit**

```bash
git add lib/swaps.js scripts/check-swaps.mjs package.json
git commit -m "Add swap candidate filters, shortlist scoring, and AI ranking prompt

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Swaps service (prepare job + request flow)

**Files:**
- Create: `lib/swaps-service.js`
- Test: `scripts/check-swaps-service.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: collection store `{ load, loadCards }` (Task 2); profiles (Task 4); embeddings (Task 5); swaps (Task 6); usage log (Task 3).
- Produces (`lib/swaps-service.js`):
  - `PROFILE_AUTO_LIMIT = 50`
  - `collectionOracleCards(cards): Map<oracleId, Candidate>`
  - `createSwapsService({ collectionStore, profileStore, embeddingStore, rankingCache, usageLog, getAi, getEmbedder })` →
    - `status(): Promise<Status>`; `Status = { phase: "idle"|"awaiting-confirmation"|"profiling"|"embedding"|"ready"|"error", profiled, embedded, total, pending, estimate: {usd, model}|null, aiAvailable, spend: {monthUsd}, error }`
    - `prepare(): Promise<Status>` (manual Start / Retry)
    - `afterSync(): Promise<Status>`
    - `swaps({ card, colorIdentity, deck }): Promise<{ httpStatus, body }>` — bodies: 200 `{ results, mode: "ai"|"local", cached, aiError? }`; 202 `{ status }`; 409 `{ needsConfirmation: true, status }` or `{ error, status }`; 503 `{ error, status }`
    - `idle(): Promise<void>` (resolves when no job runs; used by tests and the pilot)
  - `getAi(): Promise<AiClient|null>` returns null when no API key.

- [ ] **Step 1: Write the failing test**

`scripts/check-swaps-service.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";
import { createSwapsService, PROFILE_AUTO_LIMIT } from "../lib/swaps-service.js";
import { createProfileStore } from "../lib/profiles.js";
import { createEmbeddingStore } from "../lib/embeddings.js";
import { createRankingCache } from "../lib/swaps.js";

const card = (i, extra = {}) => ({
  id: `s${i}`, oracle_id: `o${i}`, name: `Card ${i}`, type_line: "Instant", cmc: 2, color_identity: ["W"],
  legalities: { commander: "legal" }, prices: { eur: "0.10" },
  oracle_text: `Exile target creature you control, then return it to the battlefield. Variant ${i}.`, ...extra,
});
const original = {
  id: "orig", oracle_id: "o-orig", name: "Cloudshift", type_line: "Instant", cmc: 1, color_identity: ["W"],
  legalities: { commander: "legal" }, prices: { eur: "2.00" },
  oracle_text: "Exile target creature you control, then return that card to the battlefield under your control.",
};
const deck = (extra = {}) => ({ name: "Deck", commander: null, gamePlan: "Blink things.", identityTags: [], cardNames: ["Card 2"], signature: "sig1", ...extra });

// Letter-frequency vectors: deterministic, and similar texts score higher.
function fakeEmbedder() {
  return {
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(26);
        for (const ch of t.toLowerCase()) { const k = ch.charCodeAt(0) - 97; if (k >= 0 && k < 26) v[k]++; }
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}

function fakeAi({ failProfiles = false, failRank = false, skipAlways = [] } = {}) {
  const calls = { profile: 0, rank: 0 };
  return {
    provider: "anthropic", model: "claude-sonnet-5", calls,
    async json({ user }) {
      if (user.includes("CARD TO REPLACE")) {
        calls.rank++;
        if (failRank) throw new Error("rank down");
        const ids = [...user.matchAll(/^(k\d+):/gm)].map((m) => m[1]);
        return { data: { results: ids.map((id, i) => ({ id, match: 90 - i * 10, fits: true, reason: `Reason ${id}` })) }, usage: { inputTokens: 1, outputTokens: 1 }, usd: 0.01 };
      }
      calls.profile++;
      if (failProfiles) throw Object.assign(new Error("profile down"), { status: 500 });
      const cards = [...user.matchAll(/^(c\d+): ([^|\n]+)/gm)]
        .filter(([, , name]) => !skipAlways.includes(name.trim()))
        .map(([, id]) => ({ id, summary: "Blinks a creature you control.", mechanics: ["flicker"], synergies: [] }));
      return { data: { cards }, usage: { inputTokens: 1, outputTokens: 1 }, usd: 0.001 };
    },
  };
}

async function setup({ cards, ai = null }) {
  const dataDir = await mkdtemp(join(tmpdir(), "spellbook-service-"));
  const collectionStore = {
    load: async () => ({ syncedAt: "2026-09-27T00:00:00.000Z", entries: {}, importedRows: [] }),
    loadCards: async () => Object.fromEntries(cards.map((c) => [c.id, c])),
  };
  const usage = { entries: [], record: async (e) => { usage.entries.push(e); }, monthUsd: async () => usage.entries.reduce((n, e) => n + (e.usd || 0), 0) };
  const aiRef = { current: ai };
  const service = createSwapsService({
    collectionStore, usageLog: usage,
    profileStore: createProfileStore({ dataDir }),
    embeddingStore: createEmbeddingStore({ dataDir }),
    rankingCache: createRankingCache({ dataDir }),
    getAi: async () => aiRef.current,
    getEmbedder: async () => fakeEmbedder(),
  });
  return { service, usage, aiRef };
}
const cardsN = (n) => Array.from({ length: n }, (_, i) => card(i + 1));

test("an empty collection is idle and swaps asks for an upload", async () => {
  const { service } = await setup({ cards: [] });
  assert.equal((await service.status()).phase, "idle");
  const r = await service.swaps({ card: original, colorIdentity: ["W"], deck: null });
  assert.equal(r.httpStatus, 409);
});

test("more than the auto limit waits for confirmation and spends nothing", async () => {
  const ai = fakeAi();
  const { service } = await setup({ cards: cardsN(PROFILE_AUTO_LIMIT + 10), ai });
  const st = await service.status();
  assert.equal(st.phase, "awaiting-confirmation");
  assert.equal(st.pending, 60);
  assert.equal(st.estimate.model, "claude-sonnet-5");
  assert.ok(st.estimate.usd > 0);
  const r = await service.swaps({ card: original, colorIdentity: ["W"], deck: deck() });
  assert.deepEqual([r.httpStatus, r.body.needsConfirmation], [409, true]);
  assert.equal(ai.calls.profile, 0);
});

test("Start profiles everything, then embeds, then is ready", async () => {
  const ai = fakeAi();
  const { service, usage } = await setup({ cards: cardsN(60), ai });
  await service.prepare();
  await service.idle();
  const st = await service.status();
  assert.equal(st.phase, "ready");
  assert.equal(st.pending, 0);
  assert.equal(ai.calls.profile, 3);
  assert.equal(usage.entries.length, 3);
});

test("a small number of new cards is profiled automatically", async () => {
  const ai = fakeAi();
  const { service } = await setup({ cards: cardsN(10), ai });
  assert.ok(["profiling", "embedding"].includes((await service.status()).phase));
  await service.idle();
  assert.equal((await service.status()).phase, "ready");
  assert.equal(ai.calls.profile, 1);
});

test("without an API key the collection is embedded from rules text and swaps run locally", async () => {
  const { service } = await setup({ cards: cardsN(5) });
  await service.status();
  await service.idle();
  assert.equal((await service.status()).phase, "ready");
  const r = await service.swaps({ card: original, colorIdentity: ["W"], deck: deck() });
  assert.equal(r.httpStatus, 200);
  assert.equal(r.body.mode, "local");
  assert.ok(r.body.results.every((x) => x.reason === ""));
});

test("AI swaps exclude deck cards, are cached, and re-rank when the game plan changes", async () => {
  const ai = fakeAi();
  const { service } = await setup({ cards: cardsN(10), ai });
  await service.status();
  await service.idle();
  const first = await service.swaps({ card: original, colorIdentity: ["W"], deck: deck() });
  assert.equal(first.httpStatus, 200);
  assert.equal(first.body.mode, "ai");
  assert.equal(first.body.cached, false);
  assert.ok(first.body.results.length > 0);
  assert.ok(first.body.results.every((r) => r.card.name !== "Card 2"));
  assert.ok(first.body.results[0].reason.startsWith("Reason"));
  const again = await service.swaps({ card: original, colorIdentity: ["W"], deck: deck() });
  assert.equal(again.body.cached, true);
  assert.equal(ai.calls.rank, 1);
  await service.swaps({ card: original, colorIdentity: ["W"], deck: deck({ gamePlan: "Different plan." }) });
  assert.equal(ai.calls.rank, 2);
});

test("an AI ranking failure falls back to local matches with the error", async () => {
  const { service } = await setup({ cards: cardsN(5), ai: fakeAi({ failRank: true }) });
  await service.status();
  await service.idle();
  const r = await service.swaps({ card: original, colorIdentity: ["W"], deck: deck() });
  assert.equal(r.body.mode, "local");
  assert.equal(r.body.aiError, "rank down");
});

test("a profiling failure is sticky until Retry — no automatic re-spend", async () => {
  const ai = fakeAi({ failProfiles: true });
  const { service } = await setup({ cards: cardsN(5), ai });
  await service.status();
  await service.idle();
  const st = await service.status();
  assert.equal(st.phase, "error");
  assert.equal(ai.calls.profile, 2);
  await service.status();
  assert.equal(ai.calls.profile, 2);
  await service.prepare();
  await service.idle();
  assert.equal(ai.calls.profile, 4);
});

test("cards the AI never profiles are not retried automatically", async () => {
  const ai = fakeAi({ skipAlways: ["Card 3"] });
  const { service } = await setup({ cards: cardsN(5), ai });
  await service.status();
  await service.idle();
  const st = await service.status();
  assert.equal(st.phase, "ready");
  assert.equal(st.pending, 1);
  const calls = ai.calls.profile;
  await service.status();
  await service.idle();
  assert.equal(ai.calls.profile, calls);
});

await run("Swaps service");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-swaps-service.mjs`
Expected: FAIL with `Cannot find module '.../lib/swaps-service.js'`.

- [ ] **Step 3: Implement `lib/swaps-service.js`**

```js
import { estimateProfileUsd, oracleIdOf, profileOne, runProfileJob } from "./profiles.js";
import { countStale, embeddingText, ensureEmbeddings } from "./embeddings.js";
import {
  buildRankRequest, filterCandidates, finalizeAi, finalizeLocal, parseRankResponse, rankingCacheKey, shortlist,
} from "./swaps.js";

// Profiling more cards than this needs the user to press Start (spend control).
export const PROFILE_AUTO_LIMIT = 50;

// One representative card per oracle id (printings share rules text).
export function collectionOracleCards(cards) {
  const byOid = new Map();
  for (const card of Object.values(cards || {})) {
    const oid = oracleIdOf(card);
    if (!oid) continue;
    const e = byOid.get(oid);
    if (e) e.scryfallIds.push(card.id);
    else byOid.set(oid, { oracleId: oid, card, scryfallIds: [card.id] });
  }
  return byOid;
}

export function createSwapsService({ collectionStore, profileStore, embeddingStore, rankingCache, usageLog, getAi, getEmbedder }) {
  let job = null; // { phase, profiled, embedded, promise }
  let lastError = null;
  const skipped = new Set(); // oracle ids the AI failed to profile this session — never auto-retried

  async function snapshot() {
    const [collection, cards, ai] = await Promise.all([collectionStore.load(), collectionStore.loadCards(), getAi()]);
    const byOid = collectionOracleCards(cards);
    const pending = ai ? await profileStore.pending([...byOid.keys()]) : [];
    return { collection, byOid, ai, pending };
  }

  async function embeddingItems(byOid) {
    const items = [];
    for (const { oracleId, card } of byOid.values()) {
      items.push({ oracleId, text: embeddingText(card, await profileStore.get(oracleId)) });
    }
    return items;
  }

  function start({ manual }) {
    if (job) return job.promise;
    lastError = null;
    if (manual) skipped.clear();
    job = { phase: "profiling", profiled: 0, embedded: 0 };
    const current = job;
    current.promise = (async () => {
      try {
        const { byOid, ai, pending } = await snapshot();
        const todo = pending.filter((oid) => !skipped.has(oid));
        current.phase = ai && todo.length ? "profiling" : "embedding";
        if (ai && todo.length) {
          const { failed } = await runProfileJob({
            cards: todo.map((oid) => byOid.get(oid).card),
            store: profileStore, ai, usageLog,
            onProgress: ({ profiled }) => { current.profiled = profiled; },
          });
          failed.forEach((oid) => skipped.add(oid));
        }
        current.phase = "embedding";
        const embedder = await getEmbedder();
        await ensureEmbeddings({
          items: await embeddingItems(byOid), store: embeddingStore, embedder,
          onProgress: ({ embedded }) => { current.embedded = embedded; },
        });
      } catch (err) {
        lastError = err.message || "Preparing swaps failed";
      } finally {
        job = null;
      }
    })();
    return current.promise;
  }

  async function status() {
    const { byOid, ai, pending } = await snapshot();
    const base = {
      profiled: 0, embedded: 0, total: byOid.size, pending: pending.length, estimate: null,
      aiAvailable: Boolean(ai), spend: { monthUsd: await usageLog.monthUsd() }, error: lastError,
    };
    if (ai && pending.length) {
      const usd = estimateProfileUsd(pending.length, ai.model);
      base.estimate = usd == null ? null : { usd: Math.round(usd * 100) / 100, model: ai.model };
    }
    if (job) return { ...base, phase: job.phase, profiled: job.profiled, embedded: job.embedded };
    if (!byOid.size) return { ...base, phase: "idle" };
    if (lastError) return { ...base, phase: "error" };
    const autoPending = ai ? pending.filter((oid) => !skipped.has(oid)) : [];
    if (autoPending.length > PROFILE_AUTO_LIMIT) return { ...base, phase: "awaiting-confirmation" };
    const stale = await countStale({ items: await embeddingItems(byOid), store: embeddingStore });
    if (autoPending.length || stale) {
      start({ manual: false });
      return { ...base, phase: autoPending.length ? "profiling" : "embedding" };
    }
    return { ...base, phase: "ready" };
  }

  async function prepare() {
    start({ manual: true });
    return status();
  }

  async function swaps({ card, colorIdentity, deck }) {
    const st = await status();
    if (st.phase === "idle") return { httpStatus: 409, body: { error: "Upload your collection first.", status: st } };
    if (st.phase === "awaiting-confirmation") return { httpStatus: 409, body: { needsConfirmation: true, status: st } };
    if (st.phase === "profiling" || st.phase === "embedding") return { httpStatus: 202, body: { status: st } };
    if (st.phase === "error") return { httpStatus: 503, body: { error: st.error, status: st } };

    const { collection, byOid, ai } = await snapshot();
    let originalProfile = null;
    if (ai) {
      try { originalProfile = await profileOne(card, { store: profileStore, ai, usageLog }); } catch { originalProfile = null; }
    }
    const embedder = await getEmbedder();
    const [originalVector] = await embedder.embed([embeddingText(card, originalProfile)]);
    const candidates = filterCandidates({ original: card, allowedIdentity: colorIdentity, deckNames: deck?.cardNames, candidates: [...byOid.values()] });
    const vectors = new Map();
    const profiles = new Map();
    for (const c of candidates) {
      vectors.set(c.oracleId, (await embeddingStore.get(c.oracleId))?.v || null);
      profiles.set(c.oracleId, await profileStore.get(c.oracleId));
    }
    const short = shortlist({
      original: card, originalVector, originalProfile, candidates,
      vectorFor: (id) => vectors.get(id), profileFor: (id) => profiles.get(id),
    });
    if (!short.length) return { httpStatus: 200, body: { results: [], mode: ai ? "ai" : "local", cached: false } };
    if (!ai) return { httpStatus: 200, body: { results: finalizeLocal(short), mode: "local", cached: false } };

    const key = rankingCacheKey({
      originalOracleId: oracleIdOf(card), deckSignature: deck?.signature, gamePlan: deck?.gamePlan,
      syncedAt: collection.syncedAt, model: ai.model,
    });
    const hit = await rankingCache.get(key);
    if (hit) return { httpStatus: 200, body: { results: hit, mode: "ai", cached: true } };
    try {
      const req = buildRankRequest({ deck, original: card, originalProfile, shortlisted: short, profileFor: (id) => profiles.get(id) });
      const r = await ai.json({ system: req.system, cachedContext: req.cachedContext, user: req.user, maxTokens: 8000, effort: "medium" });
      await usageLog.record({ feature: "rank", provider: ai.provider, model: ai.model, ...r.usage, usd: r.usd });
      const results = finalizeAi(short, parseRankResponse(r.data, req.ids));
      await rankingCache.set(key, results);
      return { httpStatus: 200, body: { results, mode: "ai", cached: false } };
    } catch (err) {
      return { httpStatus: 200, body: { results: finalizeLocal(short), mode: "local", cached: false, aiError: err.message || "AI ranking failed" } };
    }
  }

  const idle = async () => { while (job) await job.promise; };

  return { status, prepare, afterSync: status, swaps, idle };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/check-swaps-service.mjs`
Expected: `Swaps service: 9 tests passed.`

- [ ] **Step 5: Extend the npm script**

```json
    "test:swaps": "node scripts/check-ai-client.mjs && node scripts/check-profiles.mjs && node scripts/check-embeddings.mjs && node scripts/check-swaps.mjs && node scripts/check-swaps-service.mjs",
```

- [ ] **Step 6: Commit**

```bash
git add lib/swaps-service.js scripts/check-swaps-service.mjs package.json
git commit -m "Add swaps service: gated profiling job and deck-aware ranking flow

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Server routes and deck Game plan state

**Files:**
- Create: `lib/deck-notes.js`
- Test: `scripts/check-deck-notes.mjs`
- Modify: `server.js` (imports, `DEFAULT_APP_STATE`, `normalizeAppState`, `mergeStates`, `applyOps`, new routes before `const PORT`), `package.json`

**Interfaces:**
- Consumes: every `lib/` module from Tasks 2–7; existing `readAppState`, `activeAiConfig`, `DATA_DIR`.
- Produces:
  - `lib/deck-notes.js`: `DECK_NOTES_MAX = 20000`, `normalizeDeckNotes(value): {[folderId]: string}`, `mergeDeckNotes(base, incoming)`
  - App state field `deckNotes`; op `{ type: "setDeckNotes", deckNotes }`
  - Routes: `GET /api/collection`, `POST /api/collection/preview` `{csv}`, `POST /api/collection/apply` `{previewId, mode}`, `GET /api/swaps/status`, `POST /api/swaps/prepare`, `POST /api/swaps` `{card, colorIdentity, deck}`

- [ ] **Step 1: Write the failing test**

`scripts/check-deck-notes.mjs`:

```js
import assert from "node:assert/strict";
import { test, run } from "./lib/tiny-test.mjs";
import { DECK_NOTES_MAX, normalizeDeckNotes, mergeDeckNotes } from "../lib/deck-notes.js";

test("normalizeDeckNotes keeps non-empty strings per deck, capped at the limit", () => {
  const long = "x".repeat(DECK_NOTES_MAX + 10);
  assert.deepEqual(normalizeDeckNotes({ a: "Plan", b: "   ", c: 5, d: long }), { a: "Plan", d: long.slice(0, DECK_NOTES_MAX) });
  assert.deepEqual(normalizeDeckNotes(null), {});
  assert.deepEqual(normalizeDeckNotes(["x"]), {});
});

test("mergeDeckNotes lets the incoming note win per deck", () => {
  assert.deepEqual(mergeDeckNotes({ a: "old", b: "keep" }, { a: "new" }), { a: "new", b: "keep" });
});

await run("Deck notes");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-deck-notes.mjs`
Expected: FAIL with `Cannot find module '.../lib/deck-notes.js'`.

- [ ] **Step 3: Implement `lib/deck-notes.js`**

```js
// Per-deck "Game plan" text (a pasted primer or the player's own notes).
export const DECK_NOTES_MAX = 20000;

export function normalizeDeckNotes(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [folderId, text] of Object.entries(value)) {
    if (typeof text === "string" && text.trim()) out[folderId] = text.slice(0, DECK_NOTES_MAX);
  }
  return out;
}

export function mergeDeckNotes(base, incoming) {
  return { ...normalizeDeckNotes(base), ...normalizeDeckNotes(incoming) };
}
```

Run: `node scripts/check-deck-notes.mjs` → `Deck notes: 2 tests passed.`

- [ ] **Step 4: Add `deckNotes` to server app state**

In `server.js`, add to the imports:

```js
import { mergeDeckNotes, normalizeDeckNotes } from "./lib/deck-notes.js";
```

In `DEFAULT_APP_STATE`, after the `maybeboard` line:

```js
  deckNotes: {}, // { [folderId]: string } — per-deck Game plan used by View Swaps
```

In `normalizeAppState`, after the `maybeboard:` line:

```js
    deckNotes: normalizeDeckNotes(input.deckNotes),
```

In `mergeStates`, after the `maybeboard:` line:

```js
    deckNotes: mergeDeckNotes(base.deckNotes, incoming.deckNotes),
```

In `applyOps`, after the `case "setMaybeboard":` block:

```js
      case "setDeckNotes":
        if (op.deckNotes && typeof op.deckNotes === "object") state.deckNotes = normalizeDeckNotes(op.deckNotes);
        break;
```

- [ ] **Step 5: Wire the collection and swaps routes**

Add to the `server.js` imports:

```js
import { createCollectionStore, PreviewExpiredError, ScryfallError } from "./lib/collection-store.js";
import { CollectionFormatError } from "./lib/collection.js";
import { createAiClient } from "./lib/ai-client.js";
import { createUsageLog } from "./lib/ai-usage.js";
import { createProfileStore } from "./lib/profiles.js";
import { createEmbeddingStore, createLocalEmbedder } from "./lib/embeddings.js";
import { createRankingCache } from "./lib/swaps.js";
import { createSwapsService } from "./lib/swaps-service.js";
```

(Merge `createAiClient` into the existing `./lib/ai-client.js` import line from Task 3 rather than importing twice.)

Insert immediately before `const PORT = process.env.PORT || 3000;`:

```js
// ── Collection & swaps ─────────────────────────────────────────────
const collectionStore = createCollectionStore({ dataDir: DATA_DIR });
let embedderPromise = null;
const swapsService = createSwapsService({
  collectionStore,
  profileStore: createProfileStore({ dataDir: DATA_DIR }),
  embeddingStore: createEmbeddingStore({ dataDir: DATA_DIR }),
  rankingCache: createRankingCache({ dataDir: DATA_DIR }),
  usageLog: createUsageLog({ dataDir: DATA_DIR }),
  getAi: async () => {
    const ai = activeAiConfig(await readAppState());
    return ai.apiKey ? createAiClient(ai) : null;
  },
  getEmbedder: () => (embedderPromise ||= createLocalEmbedder({ cacheDir: join(DATA_DIR, "models") })
    .catch((err) => { embedderPromise = null; throw err; })),
});

app.get("/api/collection", async (req, res) => {
  try {
    res.json(await collectionStore.payload());
  } catch (err) {
    res.status(500).json({ error: err.message || "Couldn't load the collection" });
  }
});

app.post("/api/collection/preview", async (req, res) => {
  try {
    res.json(await collectionStore.preview(String(req.body?.csv || "")));
  } catch (err) {
    res.status(err instanceof CollectionFormatError ? 400 : 500).json({ error: err.message || "Couldn't read that file" });
  }
});

app.post("/api/collection/apply", async (req, res) => {
  const mode = req.body?.mode === "add" ? "add" : "sync";
  try {
    const result = await collectionStore.apply(String(req.body?.previewId || ""), mode);
    swapsService.afterSync().catch(() => {});
    res.json(result);
  } catch (err) {
    const status = err instanceof PreviewExpiredError ? 410 : err instanceof ScryfallError ? 502 : 500;
    res.status(status).json({ error: err.message || "Sync failed" });
  }
});

app.get("/api/swaps/status", async (req, res) => {
  try {
    res.json(await swapsService.status());
  } catch (err) {
    res.status(500).json({ error: err.message || "Couldn't read swap status" });
  }
});

app.post("/api/swaps/prepare", async (req, res) => {
  try {
    res.json(await swapsService.prepare());
  } catch (err) {
    res.status(500).json({ error: err.message || "Couldn't start preparing swaps" });
  }
});

app.post("/api/swaps", async (req, res) => {
  const card = req.body?.card;
  if (!card || !card.name) return res.status(400).json({ error: "Missing card" });
  try {
    const { httpStatus, body } = await swapsService.swaps({
      card,
      colorIdentity: Array.isArray(req.body?.colorIdentity) ? req.body.colorIdentity : card.color_identity || [],
      deck: req.body?.deck && typeof req.body.deck === "object" ? req.body.deck : null,
    });
    res.status(httpStatus).json(body);
  } catch (err) {
    res.status(500).json({ error: err.message || "Swaps failed" });
  }
});
```

- [ ] **Step 6: Smoke-test the server**

Run (Git Bash):

```bash
cd /c/Users/Adrian/Documents/Coding/spellbook && node --check server.js && \
TMP=$(mktemp -d) && (DATA_DIR="$TMP" PORT=3999 node server.js & echo $! > "$TMP/pid") && \
curl -s --retry 20 --retry-connrefused --retry-delay 1 localhost:3999/api/collection && echo && \
curl -s localhost:3999/api/swaps/status && echo && \
curl -s -X POST -H "Content-Type: application/json" -d '{"csv":"Name,Quantity\nSol Ring,1"}' localhost:3999/api/collection/preview && echo; \
kill $(cat "$TMP/pid")
```

(`curl --retry-connrefused` waits for the server to come up; don't use `sleep`.)

Expected:
- `{"syncedAt":null,"entries":{},"cards":{}}`
- a status with `"phase":"idle"`
- `{"error":"This doesn't look like a ManaBox export (missing: Scryfall ID)"}`

- [ ] **Step 7: Add the npm scripts**

```json
    "test:swaps": "node scripts/check-ai-client.mjs && node scripts/check-profiles.mjs && node scripts/check-embeddings.mjs && node scripts/check-swaps.mjs && node scripts/check-swaps-service.mjs && node scripts/check-deck-notes.mjs",
    "test": "npm run test:collection && npm run test:swaps && npm run test:deck-analysis"
```

Run: `npm test` → every suite passes.

- [ ] **Step 8: Commit**

```bash
git add lib/deck-notes.js scripts/check-deck-notes.mjs server.js package.json
git commit -m "Add collection and swaps API routes and synced deck Game plan

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Collection tab (frontend)

**Files:**
- Modify: `public/index.html` (CSS before `</style>`; header nav + rail tabs ~1947-1970; new section after `#saved-section` ~2075; new modal after `#import-modal` ~2180; script: `let` declarations near `let comboMoreBtn` ~2232, Search color-toggle selectors ~2335/2343, `setActiveTab` ~2356, `refreshResultsSaveState` ~5420, new code at the end of the script)
- Test: `scripts/check-collection-ui.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `GET /api/collection`, `POST /api/collection/preview`, `POST /api/collection/apply`, `GET /api/swaps/status`, `POST /api/swaps/prepare` (Task 8); existing `getPrice`, `getCardImage`, `esc`, `flipBtnHtml`, `wireFlipBtn`, `bookmarkIcon`, `ICON_DOTS`, `openSavePopover`, `showDetail`, `isCardSaved`, `scheduleTiltInit`, `MANA_SVG`, `renderSavedCards`.
- Produces (globals in `index.html`, used by Tasks 10–11):
  - `let collectionData`, `let collectionIndex` (declared near the top of the script)
  - Helpers block (pure): `buildCollectionIndex(data)`, `ownedQty(index, card)`, `filterCollectionItems(items, {query, colors, binder})`, `sortCollectionItems(items, field)`, `collectionTotals(data, index)`, `deckColorMatch(card, selectedSet)`, `ownCount(index, cards)`
  - `loadCollection(force?)`, `hasCollection()`, `buildColorPicker(container, selectedSet, onChange, {colorless})`, `fetchSwapsStatus()`, `swapsStatusText(status)`, `refreshSwapsStatus()`

- [ ] **Step 1: Write the failing helper test**

`scripts/check-collection-ui.mjs`:

```js
// Evaluates the pure helper block from public/index.html (between the markers).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, run } from "./lib/tiny-test.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const BEGIN = "// @testable collection-helpers begin";
const END = "// @testable collection-helpers end";
if (!html.includes(BEGIN) || !html.includes(END)) throw new Error("collection helper markers not found in public/index.html");
const block = html.split(BEGIN)[1].split(END)[0];
const h = Function(`${block}; return { buildCollectionIndex, ownedQty, filterCollectionItems, sortCollectionItems, collectionTotals, deckColorMatch, ownCount };`)();

const card = (id, name, extra = {}) => ({ id, oracle_id: `o-${name}`, name, cmc: 2, color_identity: ["W"], prices: { eur: "1.00", eur_foil: "3.00" }, ...extra });
const data = {
  syncedAt: "2026-09-27T00:00:00.000Z",
  entries: {
    "a|normal|Main": { scryfallId: "a", foil: "normal", binder: "Main", qty: 2 },
    "a2|foil|Trade ": { scryfallId: "a2", foil: "foil", binder: "Trade ", qty: 1 },
    "b|normal|Main": { scryfallId: "b", foil: "normal", binder: "Main", qty: 1 },
    "x|normal|Main": { scryfallId: "x", foil: "normal", binder: "Main", qty: 4 },
  },
  cards: {
    a: card("a", "Alpha Strike"),
    a2: card("a2", "Alpha Strike"),
    b: card("b", "Blue Thing", { color_identity: ["U"], cmc: 1, prices: { eur: "5.00" } }),
  },
};
const index = h.buildCollectionIndex(data);

test("buildCollectionIndex groups printings by oracle id", () => {
  assert.equal(index.list.length, 2);
  const alpha = index.byOracle.get("o-Alpha Strike");
  assert.equal(alpha.qty, 3);
  assert.deepEqual(alpha.scryfallIds, ["a", "a2"]);
  assert.deepEqual([...alpha.binders].sort(), ["Main", "Trade"]);
});

test("ownedQty matches any printing", () => {
  assert.equal(h.ownedQty(index, card("zzz", "Alpha Strike")), 3);
  assert.equal(h.ownedQty(index, card("q", "Unknown")), 0);
  assert.equal(h.ownedQty(null, card("q", "Unknown")), 0);
});

test("filterCollectionItems: name, fits-within colors, binder", () => {
  const names = (items) => items.map((it) => it.card.name).sort();
  assert.deepEqual(names(h.filterCollectionItems(index.list, { query: "blue" })), ["Blue Thing"]);
  assert.deepEqual(names(h.filterCollectionItems(index.list, { colors: ["W"] })), ["Alpha Strike"]);
  assert.deepEqual(names(h.filterCollectionItems(index.list, { colors: ["W", "U"] })), ["Alpha Strike", "Blue Thing"]);
  assert.deepEqual(names(h.filterCollectionItems(index.list, { binder: "Trade" })), ["Alpha Strike"]);
});

test("sortCollectionItems by name, price and mana value", () => {
  const order = (field) => h.sortCollectionItems(index.list, field).map((it) => it.card.name);
  assert.deepEqual(order("name"), ["Alpha Strike", "Blue Thing"]);
  assert.deepEqual(order("price"), ["Blue Thing", "Alpha Strike"]);
  assert.deepEqual(order("cmc"), ["Blue Thing", "Alpha Strike"]);
});

test("collectionTotals counts matched cards and prices foils as foil", () => {
  assert.deepEqual(h.collectionTotals(data, index), { unique: 2, copies: 4, value: 2 * 1 + 1 * 3 + 5 });
});

test("deckColorMatch uses contains semantics with a Colorless option", () => {
  const sel = (...c) => new Set(c);
  assert.equal(h.deckColorMatch({ color_identity: ["W", "U"] }, sel("U")), true);
  assert.equal(h.deckColorMatch({ color_identity: ["W"] }, sel("U")), false);
  assert.equal(h.deckColorMatch({ color_identity: [] }, sel("C")), true);
  assert.equal(h.deckColorMatch({ color_identity: [] }, sel("W")), false);
  assert.equal(h.deckColorMatch({ color_identity: ["W"] }, sel()), true);
});

test("ownCount counts distinct owned cards", () => {
  const deck = [card("d1", "Alpha Strike"), card("d2", "Alpha Strike"), card("d3", "Missing Card")];
  assert.deepEqual(h.ownCount(index, deck), { owned: 1, total: 2 });
});

await run("Collection UI helpers");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-collection-ui.mjs`
Expected: FAIL with `collection helper markers not found in public/index.html`.

- [ ] **Step 3: Add the markup**

In the header nav (after `<button class="tab-btn" data-tab="saved">Decks</button>`):

```html
        <button class="tab-btn" data-tab="collection">Collection</button>
```

In the rail workspace section (after the Decks `rail-tab` button):

```html
          <button class="rail-tab" data-tab="collection">
            <span>Collection</span>
          </button>
```

Immediately after the closing `</div>` of `#saved-section` (before `</section>`):

```html
        <div class="collection-section" id="collection-section">
          <div class="collection-header">
            <div class="collection-stats" id="collection-stats"></div>
            <button class="export-btn" id="collection-upload-btn" type="button">Upload CSV</button>
            <input type="file" id="collection-file" accept=".csv,text/csv" hidden>
          </div>
          <div class="collection-swaps-status" id="collection-swaps-status"></div>
          <div class="collection-controls">
            <div class="color-toggles" id="collection-colors" aria-label="Filter by color identity"></div>
            <input type="text" id="collection-filter" placeholder="Filter by name...">
            <select id="collection-binder" aria-label="Binder"></select>
            <select id="collection-sort" aria-label="Sort">
              <option value="name">Name</option>
              <option value="price">Price</option>
              <option value="cmc">Mana value</option>
            </select>
          </div>
          <div id="collection-empty" class="empty-state">
            <p>No collection yet</p>
            <small>In ManaBox, open the Collection tab, use the top-right menu to export your whole collection (or a single binder) as CSV, then upload it here.</small>
          </div>
          <div id="collection-grid" class="results-grid"></div>
          <div class="pagination" id="collection-more-wrap" style="display:none">
            <button id="collection-more-btn" type="button">Show more</button>
          </div>
        </div>
```

After the `#import-modal` block:

```html
  <div class="modal-overlay" id="collection-upload-modal">
    <div class="modal">
      <h2>Upload collection</h2>
      <div class="upload-mode" role="radiogroup" aria-label="Upload mode">
        <label><input type="radio" name="upload-mode" value="sync"> <strong>Full collection</strong> <small>Match the file exactly: adds, updates, and removes cards.</small></label>
        <label><input type="radio" name="upload-mode" value="add"> <strong>New cards</strong> <small>Add this file's cards on top; never removes anything.</small></label>
      </div>
      <div class="upload-summary" id="upload-summary"></div>
      <div class="upload-warning" id="upload-warning"></div>
      <div class="upload-details" id="upload-details"></div>
      <div class="import-status" id="upload-status"></div>
      <div class="modal-actions">
        <button class="btn-cancel" id="upload-cancel" type="button">Cancel</button>
        <button class="btn-save" id="upload-confirm" type="button">Confirm</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 4: Add the CSS**

Before `</style>`:

```css
    /* ── Collection tab ─────────────────────────────── */
    .collection-section { display: none; }
    .collection-section.visible { display: block; }
    .side-menu.collection-mode .workspace-section,
    .side-menu.collection-mode .folders-section,
    .side-menu.collection-mode .history-section,
    .side-menu.collection-mode .cache-section { display: none; }
    .collection-header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 8px; }
    .collection-stats { flex: 1 1 auto; font-size: 13px; color: #504B42; }
    .collection-stats .collection-notice { display: block; color: #9A5B13; margin-top: 2px; }
    .collection-swaps-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 12px; color: #7A766C; margin-bottom: 12px; min-height: 18px; }
    .collection-swaps-status .swaps-spend { margin-left: auto; }
    .collection-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 14px; }
    .collection-controls input[type="text"] { flex: 1 1 180px; min-width: 0; }
    .color-toggle.colorless-toggle { font-weight: 800; font-size: 13px; }
    .qty-chip { position: absolute; top: 8px; right: 8px; padding: 2px 7px; border-radius: 999px; background: rgba(31,29,25,0.78); color: #fff; font-size: 11px; font-weight: 700; }
    .upload-mode label { display: block; margin-bottom: 8px; font-size: 13px; }
    .upload-mode small { display: block; margin-left: 22px; color: #7A766C; }
    .upload-summary { font-weight: 700; margin: 10px 0 6px; }
    .upload-warning { color: #B3261E; font-size: 13px; margin-bottom: 6px; }
    .upload-details { max-height: 240px; overflow: auto; font-size: 12px; margin-bottom: 10px; }
    .upload-details ul { margin: 4px 0 8px 18px; padding: 0; }
```

- [ ] **Step 5: Declare collection state near the top of the script**

Directly after `let comboMoreBtn = null; // …` add (these must exist before `loadAppState()` renders anything):

```js
    let collectionData = null;   // /api/collection payload
    let collectionIndex = null;  // buildCollectionIndex(collectionData)
    const deckColorFilter = new Set(); // Decks tab color filter (session-only), used in Task 11
```

- [ ] **Step 6: Scope the Search color toggles**

The new pickers reuse the `.color-toggle` class, so the Search wiring must only touch its own buttons. Find every `querySelectorAll(".color-toggle")` in the script (`grep -n 'querySelectorAll(".color-toggle")' public/index.html` — expect two: in `updateIdentityDisplay` and in the wiring loop right after it) and replace each occurrence of:

```js
document.querySelectorAll(".color-toggle")
```

with:

```js
document.querySelectorAll(".search-section .color-toggle")
```

- [ ] **Step 7: Make `setActiveTab` handle three tabs**

Replace the body of `function setActiveTab(tab) { … }` with:

```js
    function setActiveTab(tab) {
      state.activeTab = tab;
      document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(`[data-tab="${tab}"]`).forEach((b) => b.classList.add("active"));
      sideMenu.classList.remove("search-mode", "saved-mode", "collection-mode");
      sideMenu.classList.add(tab === "saved" ? "saved-mode" : tab === "collection" ? "collection-mode" : "search-mode");
      updateRailIcon();
      if (typeof closeSwapsView === "function") closeSwapsView();
      $("#search-content").classList.toggle("hidden", tab !== "search");
      $("#saved-section").classList.toggle("visible", tab === "saved");
      $("#collection-section").classList.toggle("visible", tab === "collection");
      if (tab === "saved") renderSavedCards();
      if (tab === "collection") openCollectionTab();
    }
```

(`closeSwapsView` is added in Task 10; the `typeof` guard keeps this task working on its own.)

- [ ] **Step 8: Refresh bookmarks in every grid**

In `refreshResultsSaveState`, replace:

```js
      resultsEl.querySelectorAll(".save-btn").forEach((btn) => {
```

with:

```js
      document.querySelectorAll("#results .save-btn, #collection-grid .save-btn, #swaps-grid .save-btn").forEach((btn) => {
```

- [ ] **Step 9: Add the helper block and Collection tab code**

Append at the end of the script (just before `</script>`):

```js
    // ── Collection (ManaBox import) ─────────────────────────────────────
    // @testable collection-helpers begin
    function buildCollectionIndex(data) {
      const byOracle = new Map();
      for (const e of Object.values(data?.entries || {})) {
        const card = data.cards?.[e.scryfallId];
        const oid = card && (card.oracle_id || card.card_faces?.[0]?.oracle_id);
        if (!oid) continue;
        let item = byOracle.get(oid);
        if (!item) { item = { oracleId: oid, card, qty: 0, scryfallIds: [], binders: new Set() }; byOracle.set(oid, item); }
        item.qty += e.qty;
        if (!item.scryfallIds.includes(e.scryfallId)) item.scryfallIds.push(e.scryfallId);
        const binder = String(e.binder || "").trim();
        if (binder) item.binders.add(binder);
      }
      return { byOracle, list: [...byOracle.values()] };
    }
    function ownedQty(index, card) {
      if (!index || !card) return 0;
      const oid = card.oracle_id || card.card_faces?.[0]?.oracle_id;
      return (oid && index.byOracle.get(oid)?.qty) || 0;
    }
    function itemEur(card) { const p = card?.prices || {}; return Number(p.eur || p.eur_foil || 0); }
    function filterCollectionItems(items, { query = "", colors = [], binder = "" } = {}) {
      const q = query.trim().toLowerCase();
      const allowed = new Set([...colors].map((c) => c.toUpperCase()));
      return items.filter((it) =>
        (!q || it.card.name.toLowerCase().includes(q))
        && (!allowed.size || (it.card.color_identity || []).every((c) => allowed.has(c)))
        && (!binder || it.binders.has(binder)));
    }
    function sortCollectionItems(items, field) {
      const byName = (a, b) => a.card.name.localeCompare(b.card.name);
      const compare = field === "price" ? (a, b) => itemEur(b.card) - itemEur(a.card) || byName(a, b)
        : field === "cmc" ? (a, b) => (a.card.cmc || 0) - (b.card.cmc || 0) || byName(a, b)
        : byName;
      return items.slice().sort(compare);
    }
    function collectionTotals(data, index) {
      let copies = 0;
      let value = 0;
      for (const e of Object.values(data?.entries || {})) {
        const card = data.cards?.[e.scryfallId];
        if (!card) continue;
        const p = card.prices || {};
        copies += e.qty;
        value += e.qty * (Number(e.foil === "normal" ? (p.eur ?? p.eur_foil) : (p.eur_foil ?? p.eur)) || 0);
      }
      return { unique: index ? index.list.length : 0, copies, value };
    }
    // Decks tab filter: a card shows if its identity contains any selected color; "C" = colorless.
    function deckColorMatch(card, selected) {
      if (!selected.size) return true;
      const ci = card.color_identity || [];
      if (!ci.length) return selected.has("C");
      return ci.some((c) => selected.has(c));
    }
    function ownCount(index, cards) {
      const distinct = new Map();
      for (const c of cards) distinct.set(c.oracle_id || c.card_faces?.[0]?.oracle_id || c.name, c);
      let owned = 0;
      for (const c of distinct.values()) if (ownedQty(index, c) > 0) owned++;
      return { owned, total: distinct.size };
    }
    // @testable collection-helpers end

    const COLLECTION_PAGE = 60;
    const COLOR_NAMES = { w: "White", u: "Blue", b: "Black", r: "Red", g: "Green", c: "Colorless" };
    const collectionUi = { colors: new Set(), query: "", binder: "", sort: "name", shown: 0, notice: "" };
    let collectionLoading = null;
    let swapsStatusTimer = null;

    function loadCollection(force = false) {
      if (collectionLoading && !force) return collectionLoading;
      collectionLoading = fetch("/api/collection")
        .then((r) => { if (!r.ok) throw new Error("Couldn't load your collection"); return r.json(); })
        .then((data) => { collectionData = data; collectionIndex = buildCollectionIndex(data); return data; })
        .catch((err) => { collectionLoading = null; throw err; });
      return collectionLoading;
    }
    const hasCollection = () => Boolean(collectionIndex && collectionIndex.list.length);

    function buildColorPicker(container, selected, onChange, { colorless = false } = {}) {
      container.replaceChildren();
      (colorless ? ["w", "u", "b", "r", "g", "c"] : ["w", "u", "b", "r", "g"]).forEach((c) => {
        const key = c.toUpperCase();
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "color-toggle" + (c === "c" ? " colorless-toggle" : "");
        btn.dataset.color = c;
        btn.title = COLOR_NAMES[c];
        btn.setAttribute("aria-label", COLOR_NAMES[c]);
        btn.innerHTML = MANA_SVG[c] || "C";
        const sync = () => { const on = selected.has(key); btn.classList.toggle("active", on); btn.setAttribute("aria-pressed", String(on)); };
        btn.addEventListener("click", () => { if (selected.has(key)) selected.delete(key); else selected.add(key); sync(); onChange(); });
        sync();
        container.appendChild(btn);
      });
    }

    async function openCollectionTab() {
      try { await loadCollection(); } catch (err) { $("#collection-stats").textContent = err.message; return; }
      renderCollection(true);
      refreshSwapsStatus();
    }

    function renderCollectionHeader() {
      const stats = $("#collection-stats");
      if (!hasCollection()) { stats.textContent = "No collection uploaded yet"; return; }
      const t = collectionTotals(collectionData, collectionIndex);
      const synced = collectionData.syncedAt ? ` · Synced ${new Date(collectionData.syncedAt).toLocaleDateString()}` : "";
      stats.textContent = `${t.unique.toLocaleString()} unique · ${t.copies.toLocaleString()} copies · €${t.value.toFixed(2)}${synced}`;
      if (collectionUi.notice) {
        const note = document.createElement("span");
        note.className = "collection-notice";
        note.textContent = collectionUi.notice;
        stats.appendChild(note);
      }
    }

    function renderBinderOptions() {
      const sel = $("#collection-binder");
      const binders = [...new Set(collectionIndex ? collectionIndex.list.flatMap((it) => [...it.binders]) : [])].sort();
      const current = collectionUi.binder;
      sel.replaceChildren(new Option("All binders", ""), ...binders.map((b) => new Option(b, b)));
      sel.value = binders.includes(current) ? current : "";
      collectionUi.binder = sel.value;
      sel.style.display = binders.length ? "" : "none";
    }

    function collectionTile(it) {
      const card = it.card;
      const el = document.createElement("div");
      el.className = "card-item";
      const price = getPrice(card);
      const isSaved = isCardSaved(card.id);
      el.innerHTML = `
        <img src="${getCardImage(card)}" alt="${esc(card.name)}" loading="lazy">
        ${it.qty > 1 ? `<span class="qty-chip">×${it.qty}</span>` : ""}
        <div class="card-info">
          <div class="card-text">
            <div class="card-name" title="${esc(card.name)}">${esc(card.name)}</div>
            <div class="card-price ${price ? "" : "no-price"}">${price || "No price"}</div>
          </div>
          <div class="card-tools">
            ${flipBtnHtml(card)}
            <button class="icon-btn save-btn ${isSaved ? "saved" : ""}" data-id="${card.id}" title="${isSaved ? "Saved" : "Save"}" aria-label="Save to a deck">${bookmarkIcon(isSaved)}</button>
            <button class="icon-btn detail-btn" title="Details" aria-label="Details">${ICON_DOTS}</button>
          </div>
        </div>`;
      wireFlipBtn(el, card);
      el.querySelector(".save-btn").addEventListener("click", (e) => { e.stopPropagation(); openSavePopover(card, e.currentTarget); });
      el.querySelector(".detail-btn").addEventListener("click", (e) => { e.stopPropagation(); showDetail(card); });
      el.querySelector("img").addEventListener("click", () => showDetail(card));
      return el;
    }

    function renderCollection(reset) {
      const grid = $("#collection-grid");
      renderCollectionHeader();
      renderBinderOptions();
      $("#collection-empty").style.display = hasCollection() ? "none" : "block";
      const items = hasCollection()
        ? sortCollectionItems(filterCollectionItems(collectionIndex.list, { query: collectionUi.query, colors: [...collectionUi.colors], binder: collectionUi.binder }), collectionUi.sort)
        : [];
      if (reset) { grid.replaceChildren(); collectionUi.shown = 0; }
      const next = items.slice(collectionUi.shown, collectionUi.shown + COLLECTION_PAGE);
      next.forEach((it) => grid.appendChild(collectionTile(it)));
      collectionUi.shown += next.length;
      $("#collection-more-wrap").style.display = collectionUi.shown < items.length ? "flex" : "none";
      scheduleTiltInit(grid);
    }

    async function fetchSwapsStatus() {
      const r = await fetch("/api/swaps/status");
      if (!r.ok) throw new Error("Couldn't load swap status");
      return r.json();
    }

    function swapsStatusText(st) {
      switch (st.phase) {
        case "awaiting-confirmation":
          return `Profile ${st.pending.toLocaleString()} cards for swaps${st.estimate ? ` (≈ $${st.estimate.usd.toFixed(2)} on ${st.estimate.model})` : ""}`;
        case "profiling": return `Profiling cards for swaps… ${(st.total - st.pending).toLocaleString()} / ${st.total.toLocaleString()}`;
        case "embedding": return `Preparing matching… ${st.embedded.toLocaleString()} cards`;
        case "ready": return st.aiAvailable ? "Ready for swaps" : "Ready for swaps · add an API key in Settings for deck-aware matches";
        case "error": return `Preparing swaps failed: ${st.error}`;
        default: return "";
      }
    }

    async function refreshSwapsStatus() {
      clearTimeout(swapsStatusTimer);
      const el = $("#collection-swaps-status");
      let st;
      try { st = await fetchSwapsStatus(); } catch (err) { el.textContent = err.message; return; }
      el.replaceChildren();
      const text = document.createElement("span");
      text.textContent = swapsStatusText(st);
      el.appendChild(text);
      if (st.phase === "awaiting-confirmation" || st.phase === "error") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "export-btn";
        btn.textContent = st.phase === "error" ? "Retry" : "Start";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          await fetch("/api/swaps/prepare", { method: "POST" }).catch(() => {});
          refreshSwapsStatus();
        });
        el.appendChild(btn);
      }
      const spend = document.createElement("span");
      spend.className = "swaps-spend";
      spend.textContent = `AI spend this month: $${(st.spend?.monthUsd || 0).toFixed(2)}`;
      el.appendChild(spend);
      if ((st.phase === "profiling" || st.phase === "embedding") && state.activeTab === "collection") {
        swapsStatusTimer = setTimeout(refreshSwapsStatus, 2000);
      }
    }

    buildColorPicker($("#collection-colors"), collectionUi.colors, () => renderCollection(true));
    $("#collection-filter").addEventListener("input", (e) => { collectionUi.query = e.target.value; renderCollection(true); });
    $("#collection-binder").addEventListener("change", (e) => { collectionUi.binder = e.target.value; renderCollection(true); });
    $("#collection-sort").addEventListener("change", (e) => { collectionUi.sort = e.target.value; renderCollection(true); });
    $("#collection-more-btn").addEventListener("click", () => renderCollection(false));

    // Upload: pick file → server preview → choose mode → confirm.
    const uploadModal = $("#collection-upload-modal");
    let uploadPreview = null;
    const uploadMode = () => document.querySelector('input[name="upload-mode"]:checked')?.value || "sync";
    function closeUploadModal() { uploadModal.classList.remove("visible"); uploadPreview = null; }

    function renderUploadPreview() {
      if (!uploadPreview) return;
      const mode = uploadMode();
      const p = uploadPreview[mode];
      const s = p.summary;
      $("#upload-summary").textContent = mode === "sync"
        ? `+${s.added} new · ${s.changed} quantity changes · ${s.removed} removed → ${s.totalAfter.toLocaleString()} cards`
        : `+${s.added} new · ${s.increased} more copies${s.skipped ? ` · ${s.skipped} cards already imported, skipped` : ""} → ${s.totalAfter.toLocaleString()} cards`;
      $("#upload-warning").textContent = mode === "sync" ? p.warning || "" : "";
      const groups = mode === "sync"
        ? [["New", p.details.added], ["Quantity changes", p.details.changed], ["Removed", p.details.removed]]
        : [["New", p.details.added], ["More copies", p.details.increased], ["Already imported (skipped)", p.details.skipped]];
      const wrap = $("#upload-details");
      wrap.replaceChildren();
      groups.filter(([, list]) => list.length).forEach(([label, list]) => {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = `${label} (${list.length})`;
        details.appendChild(summary);
        const ul = document.createElement("ul");
        list.slice(0, 500).forEach((r) => {
          const li = document.createElement("li");
          const qty = r.qtyAfter != null ? `${r.qtyBefore} → ${r.qtyAfter}` : `${r.qty}×`;
          li.textContent = `${qty} ${r.name} (${r.set} #${r.number}${r.foil !== "normal" ? `, ${r.foil}` : ""})${r.binder ? ` · ${r.binder}` : ""}`;
          ul.appendChild(li);
        });
        if (list.length > 500) { const li = document.createElement("li"); li.textContent = `…and ${list.length - 500} more`; ul.appendChild(li); }
        details.appendChild(ul);
        wrap.appendChild(details);
      });
    }

    $("#collection-upload-btn").addEventListener("click", () => $("#collection-file").click());
    $("#collection-file").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      uploadPreview = null;
      ["#upload-summary", "#upload-warning", "#upload-details"].forEach((s) => { $(s).textContent = ""; });
      $("#upload-status").textContent = "Reading file…";
      $("#upload-confirm").disabled = true;
      uploadModal.classList.add("visible");
      try {
        const res = await fetch("/api/collection/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv: await file.text() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Couldn't read that file");
        uploadPreview = data;
        document.querySelector(`input[name="upload-mode"][value="${data.defaultMode}"]`).checked = true;
        $("#upload-status").textContent = "";
        renderUploadPreview();
        $("#upload-confirm").disabled = false;
      } catch (err) {
        $("#upload-status").textContent = err.message;
      }
    });
    document.querySelectorAll('input[name="upload-mode"]').forEach((r) => r.addEventListener("change", renderUploadPreview));
    $("#upload-cancel").addEventListener("click", closeUploadModal);
    uploadModal.addEventListener("click", (e) => { if (e.target === uploadModal) closeUploadModal(); });
    $("#upload-confirm").addEventListener("click", async () => {
      if (!uploadPreview) return;
      const btn = $("#upload-confirm");
      btn.disabled = true;
      $("#upload-status").textContent = "Looking up new cards on Scryfall…";
      try {
        const res = await fetch("/api/collection/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ previewId: uploadPreview.previewId, mode: uploadMode() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Sync failed");
        collectionData = data;
        collectionIndex = buildCollectionIndex(data);
        collectionLoading = Promise.resolve(data);
        collectionUi.notice = data.unmatched?.length ? `${data.unmatched.length} cards couldn't be matched on Scryfall` : "";
        closeUploadModal();
        renderCollection(true);
        refreshSwapsStatus();
      } catch (err) {
        $("#upload-status").textContent = err.message;
        btn.disabled = false;
      }
    });

    // Load the collection in the background so badges and View Swaps know about it.
    loadCollection()
      .then(() => {
        if (state.activeTab === "saved") renderSavedCards();
        if (state.detailCard) showDetail(state.detailCard);
      })
      .catch(() => {});
```

- [ ] **Step 10: Run the helper test and a syntax check**

Run: `node scripts/check-collection-ui.mjs`
Expected: `Collection UI helpers: 7 tests passed.`

Run: `node -e "const h=require('fs').readFileSync('public/index.html','utf8'); new Function(h.split('<script>')[1].split('</script>')[0]); console.log('script parses')"`
Expected: `script parses`

- [ ] **Step 11: Extend the npm script**

```json
    "test:collection": "node scripts/check-collection.mjs && node scripts/check-collection-store.mjs && node scripts/check-collection-ui.mjs",
```

- [ ] **Step 12: Ask the user to check the Collection tab**

Run `npm start` and ask the user to verify in their browser (do not automate): the Collection tab appears; uploading `C:\Users\Adrian\Downloads\TaliaManaBox_Collection.csv` shows a preview (first upload: Full collection, +N new), Confirm fills the grid; name/color/binder/sort filters work; Search's color picker still works on its own; the status line shows "Profile N cards for swaps (≈ $X on claude-sonnet-5)" with **Start** — **the user must not press Start yet** (the pilot in Task 12 comes first).

- [ ] **Step 13: Commit**

```bash
git add public/index.html scripts/check-collection-ui.mjs package.json
git commit -m "Add Collection tab with ManaBox upload, filters, and swap status

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Focus panel View Swaps and the Swaps view (frontend)

**Files:**
- Modify: `public/index.html` (CSS before `</style>`; detail panel rows/buttons ~2099-2112; new `#swaps-view` after `#collection-section`; `showDetail` ~4880; detail button wiring ~4925; new code at the end of the script)

**Interfaces:**
- Consumes: `POST /api/swaps`, `POST /api/swaps/prepare` (Task 8); `collectionIndex`, `hasCollection`, `ownedQty`, `swapsStatusText` (Task 9); existing `activeDeck`, `cardFolders`, `getFolderCards`, `isMaybe`, `deckSig`, `deckReviewCache`, `getOracleText`, `edhrecSlug`, `isBasicLand`, `isCardSaved`, `openSavePopover`, `showDetail`, `setActiveTab`.
- Produces: `openSwaps(card)`, `closeSwapsView()`, `exitSwaps()`; `state.deckNotes` is read here (added in Task 11 — use `(state.deckNotes || {})` so this task works first).

- [ ] **Step 1: Add the detail-panel markup**

After the P/T row (`<div class="detail-row" id="detail-pt-row">…</div>`):

```html
            <div class="detail-row" id="detail-owned-row" style="display:none"><span class="detail-label">Owned</span><span id="detail-owned"></span></div>
```

After `<button id="detail-edhrec-btn" style="display:none">EDHREC</button>`:

```html
              <button id="detail-swaps-btn" style="display:none">View Swaps</button>
```

- [ ] **Step 2: Add the Swaps view markup**

Directly after the `#collection-section` block:

```html
        <div class="swaps-view" id="swaps-view">
          <div class="swaps-header">
            <button class="combo-back-btn" id="swaps-back-btn" type="button">&larr; Back</button>
            <h2 id="swaps-title"></h2>
          </div>
          <div class="swaps-original" id="swaps-original"></div>
          <div class="swaps-summary" id="swaps-summary"></div>
          <div class="swaps-note" id="swaps-note"></div>
          <div id="swaps-grid" class="results-grid"></div>
        </div>
```

- [ ] **Step 3: Add the CSS**

Before `</style>`:

```css
    /* ── Swaps view ─────────────────────────────────── */
    .swaps-view { display: none; }
    .swaps-view.visible { display: block; }
    .swaps-header { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
    .swaps-header h2 { margin: 0; font-size: 22px; letter-spacing: -0.02em; }
    .swaps-original { display: flex; gap: 18px; align-items: flex-start; margin-bottom: 14px; }
    .swaps-original img { width: 190px; border-radius: 10px; flex: 0 0 auto; }
    .swaps-original-text { flex: 1 1 auto; min-width: 0; font-size: 13px; color: #504B42; }
    .swaps-original-type { font-weight: 700; margin-bottom: 6px; }
    .swaps-original-price, .swaps-deck { margin-top: 8px; }
    .swaps-summary { font-size: 14px; font-weight: 700; margin: 6px 0; }
    .swaps-note { display: flex; align-items: center; gap: 10px; font-size: 12px; color: #7A766C; margin-bottom: 12px; min-height: 16px; }
    .swap-meta { padding: 8px 10px 10px; font-size: 12px; color: #504B42; }
    .swap-bar { height: 6px; border-radius: 999px; background: rgba(31,29,25,0.1); overflow: hidden; margin-bottom: 6px; }
    .swap-bar span { display: block; height: 100%; background: #3F7D5C; }
    .swap-match { font-weight: 700; }
    .swap-reason { margin-top: 4px; line-height: 1.35; }
    .swap-links { margin-top: 6px; }
    @media (max-width: 640px) {
      .swaps-original { flex-direction: column; }
      .swaps-original img { width: 150px; }
    }
```

- [ ] **Step 4: Show Owned and View Swaps in `showDetail`**

In `showDetail`, directly after the P/T `if … else` block, add:

```js
      const owned = ownedQty(collectionIndex, card);
      $("#detail-owned").textContent = `×${owned}`;
      $("#detail-owned-row").style.display = owned ? "" : "none";
      $("#detail-swaps-btn").style.display = hasCollection() && !isBasicLand(card) ? "" : "none";
```

After the `detailEdhrecBtn.addEventListener("click", …)` block, add:

```js
    $("#detail-swaps-btn").addEventListener("click", () => {
      if (state.detailCard) openSwaps(state.detailCard);
    });
```

- [ ] **Step 5: Add the Swaps view code**

Append at the end of the script (after the Task 9 code):

```js
    // ── View Swaps ──────────────────────────────────────────────────────
    let swapsContext = null; // { card, payload, prev: { tab, activeFolder, scrollY } }
    let swapsRun = 0;        // cancels stale requests when the view changes

    // Deck context is sent only when the card belongs to the active deck.
    function swapsDeckPayload(card) {
      const deck = activeDeck();
      if (!deck || !cardFolders(card.id).includes(deck.id)) return { colorIdentity: card.color_identity || [], deck: null };
      const cards = getFolderCards(deck.id).filter((c) => !isMaybe(deck.id, c.id));
      const commander = deck.commanderId ? cards.find((c) => c.id === deck.commanderId) : null;
      const review = deckReviewCache[deck.id]?.data;
      return {
        colorIdentity: commander ? commander.color_identity || [] : card.color_identity || [],
        deck: {
          id: deck.id,
          name: deck.name,
          commander: commander ? { name: commander.name, typeLine: commander.type_line || "", text: getOracleText(commander) } : null,
          gamePlan: (state.deckNotes || {})[deck.id] || "",
          identityTags: Array.isArray(review?.identityTags) ? review.identityTags : [],
          cardNames: cards.map((c) => c.name),
          signature: deckSig(cards, deck.id, commander?.name),
        },
      };
    }

    function closeSwapsView() {
      if (!swapsContext) return;
      swapsContext = null;
      swapsRun++;
      $("#swaps-view").classList.remove("visible");
    }

    function exitSwaps() {
      const prev = swapsContext?.prev;
      closeSwapsView();
      if (!prev) return;
      state.activeFolder = prev.activeFolder;
      setActiveTab(prev.tab);
      requestAnimationFrame(() => window.scrollTo(0, prev.scrollY || 0));
    }

    async function openSwaps(card) {
      const prev = swapsContext?.prev || { tab: state.activeTab, activeFolder: state.activeFolder, scrollY: window.scrollY };
      swapsContext = { card, payload: swapsDeckPayload(card), prev };
      const run = ++swapsRun;
      $("#search-content").classList.add("hidden");
      $("#saved-section").classList.remove("visible");
      $("#collection-section").classList.remove("visible");
      $("#swaps-view").classList.add("visible");
      window.scrollTo(0, 0);
      renderSwapsOriginal(card, swapsContext.payload.deck);
      await requestSwaps(run);
    }

    function setSwapsState(text, { retry = false, start = false } = {}) {
      $("#swaps-grid").replaceChildren();
      const note = $("#swaps-note");
      note.replaceChildren();
      $("#swaps-summary").textContent = text;
      if (!retry && !start) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "export-btn";
      btn.textContent = start ? "Start" : "Retry";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        if (start) await fetch("/api/swaps/prepare", { method: "POST" }).catch(() => {});
        requestSwaps(swapsRun);
      });
      note.appendChild(btn);
    }

    async function requestSwaps(run) {
      if (!swapsContext) return;
      const { card, payload } = swapsContext;
      setSwapsState(payload.deck ? `Matching against ${payload.deck.name}'s game plan…` : "Finding swaps in your collection…");
      let res;
      let data;
      try {
        res = await fetch("/api/swaps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ card, colorIdentity: payload.colorIdentity, deck: payload.deck }),
        });
        data = await res.json();
      } catch {
        if (run === swapsRun) setSwapsState("Couldn't reach Spellbook.", { retry: true });
        return;
      }
      if (run !== swapsRun) return;
      if (res.status === 202) {
        setSwapsState(swapsStatusText(data.status) || "Preparing your collection for swaps…");
        setTimeout(() => { if (run === swapsRun) requestSwaps(run); }, 2000);
        return;
      }
      if (res.status === 409 && data.needsConfirmation) {
        setSwapsState(`${swapsStatusText(data.status)} first.`, { start: true });
        return;
      }
      if (!res.ok) { setSwapsState(data.error || "Swaps failed.", { retry: true }); return; }
      renderSwapsResults(data);
    }

    function renderSwapsOriginal(card, deck) {
      $("#swaps-title").textContent = `Swaps for ${card.name}`;
      const price = getPrice(card);
      $("#swaps-original").innerHTML = `
        <img src="${getCardImage(card)}" alt="${esc(card.name)}">
        <div class="swaps-original-text">
          <div class="swaps-original-type">${esc(card.type_line || "")}</div>
          <div class="oracle-text">${esc(getOracleText(card))}</div>
          <div class="swaps-original-price">${price ? esc(price) : "No price"}</div>
          ${deck ? `<div class="swaps-deck">In ${esc(deck.name)}${deck.gamePlan ? "" : " · add a Game plan to this deck for better matches"}</div>` : ""}
        </div>`;
    }

    const cardEur = (card) => { const p = card?.prices || {}; return Number(p.eur || p.eur_foil || 0); };

    function swapTile(r, originalPrice) {
      const card = r.card;
      const el = document.createElement("div");
      el.className = "card-item swap-item";
      const price = getPrice(card);
      const saves = originalPrice - cardEur(card);
      const owned = ownedQty(collectionIndex, card) || 1;
      const isSaved = isCardSaved(card.id);
      const scryfall = card.scryfall_uri || `https://scryfall.com/search?q=${encodeURIComponent(`!"${card.name}"`)}`;
      el.innerHTML = `
        <img src="${getCardImage(card)}" alt="${esc(card.name)}" loading="lazy">
        <div class="card-info">
          <div class="card-text">
            <div class="card-name" title="${esc(card.name)}">${esc(card.name)}</div>
            <div class="card-price ${price ? "" : "no-price"}">${price || "No price"}${saves > 0 ? ` · saves €${saves.toFixed(2)}` : ""}</div>
          </div>
          <div class="card-tools">
            <button class="icon-btn save-btn ${isSaved ? "saved" : ""}" data-id="${card.id}" title="Add to a deck" aria-label="Add to a deck">${bookmarkIcon(isSaved)}</button>
            <button class="icon-btn detail-btn" title="Details" aria-label="Details">${ICON_DOTS}</button>
          </div>
        </div>
        <div class="swap-meta">
          <div class="swap-bar" role="meter" aria-label="Match" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.match}"><span style="width:${r.match}%"></span></div>
          <div class="swap-match">${r.match}% match · Owned ×${owned}</div>
          ${r.reason ? `<div class="swap-reason">${esc(r.reason)}</div>` : ""}
          <div class="swap-links"><a href="${esc(scryfall)}" target="_blank" rel="noopener">Scryfall</a> · <a href="https://edhrec.com/cards/${edhrecSlug(card.name)}" target="_blank" rel="noopener">EDHREC</a></div>
        </div>`;
      el.querySelector(".save-btn").addEventListener("click", (e) => { e.stopPropagation(); openSavePopover(card, e.currentTarget); });
      el.querySelector(".detail-btn").addEventListener("click", (e) => { e.stopPropagation(); showDetail(card); });
      el.querySelector("img").addEventListener("click", () => showDetail(card));
      return el;
    }

    function renderSwapsResults(data) {
      const { card } = swapsContext;
      const grid = $("#swaps-grid");
      grid.replaceChildren();
      const note = $("#swaps-note");
      note.replaceChildren();
      $("#swaps-summary").textContent = data.results.length
        ? `${data.results.length} card${data.results.length === 1 ? "" : "s"} from your collection can replace ${card.name}.`
        : "No match found in your collection.";
      if (data.mode === "local") {
        const msg = document.createElement("span");
        msg.textContent = data.aiError
          ? `AI ranking failed (${data.aiError}) — showing text-based matches.`
          : "Deck-aware matching is off — add an API key in Settings.";
        note.appendChild(msg);
        if (data.aiError) {
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "export-btn";
          retry.textContent = "Retry";
          retry.addEventListener("click", () => requestSwaps(swapsRun));
          note.appendChild(retry);
        }
      }
      const originalPrice = cardEur(card);
      data.results.forEach((r) => grid.appendChild(swapTile(r, originalPrice)));
      scheduleTiltInit(grid);
    }

    $("#swaps-back-btn").addEventListener("click", exitSwaps);
```

- [ ] **Step 6: Syntax check and helper tests**

Run: `node -e "const h=require('fs').readFileSync('public/index.html','utf8'); new Function(h.split('<script>')[1].split('</script>')[0]); console.log('script parses')" && npm run test:collection`
Expected: `script parses`, then all collection suites pass.

- [ ] **Step 7: Ask the user to check the flow**

With `npm start` running, ask the user to verify: selecting an owned card shows "Owned ×N"; **View Swaps** appears for non-basic cards once a collection is uploaded; opening it shows the original card and, because profiling hasn't been started, the "Profile N cards … first" message with **Start** (they should not press it yet); **← Back** returns to the same tab, deck, and scroll position; switching tabs from the Swaps view closes it.

- [ ] **Step 8: Commit**

```bash
git add public/index.html
git commit -m "Add View Swaps to the focus panel and the Swaps view

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Decks tab — Game plan, Owned badges, color filter (frontend)

**Files:**
- Modify: `public/index.html` (CSS; `#deck-tools` markup after `#deck-analysis` ~2044; Game plan modal after the upload modal; state init ~2219; `currentAppStatePayload` ~2716; `hasUsefulAppState` ~2731; `applyAppState` ~2763; migration merge ~2861; both sync signatures ~2888 and ~2917; `renderSavedCards` ~3870-3915; `renderCardTile` ~3923; deck delete cleanup ~5170; new code at the end of the script)

**Interfaces:**
- Consumes: `deckColorFilter`, `buildColorPicker`, `deckColorMatch`, `ownCount`, `ownedQty`, `hasCollection`, `collectionIndex` (Task 9); `setDeckNotes` op on the server (Task 8).
- Produces: `state.deckNotes`, `setDeckNotes(folderId, text)`, `persistDeckNotes()`, `DECK_NOTES_MAX_UI = 20000`.

- [ ] **Step 1: Add the markup**

After `<div id="deck-analysis" class="deck-analysis" style="display:none"></div>`:

```html
          <div class="deck-tools" id="deck-tools" style="display:none">
            <div class="color-toggles" id="deck-colors" aria-label="Filter deck by color"></div>
            <span class="deck-showing" id="deck-showing"></span>
            <span class="deck-owned" id="deck-owned"></span>
            <button class="export-btn" id="deck-gameplan-btn" type="button">Game plan</button>
          </div>
```

After the `#collection-upload-modal` block:

```html
  <div class="modal-overlay" id="gameplan-modal">
    <div class="modal">
      <h2 id="gameplan-title">Game plan</h2>
      <label for="gameplan-input">Paste the deck's primer or describe how it wins</label>
      <textarea id="gameplan-input" rows="14"></textarea>
      <small class="settings-help"><span id="gameplan-count">0</span> / 20,000 characters · View Swaps uses this to judge replacements for this deck.</small>
      <div class="modal-actions">
        <button class="btn-cancel" id="gameplan-cancel" type="button">Cancel</button>
        <button class="btn-save" id="gameplan-save" type="button">Save</button>
      </div>
    </div>
  </div>
```

(No `maxlength` on the textarea: browsers silently truncate pasted text at `maxlength`; the counter disables Save instead.)

- [ ] **Step 2: Add the CSS**

Before `</style>`:

```css
    /* ── Deck tools ─────────────────────────────────── */
    .deck-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 10px 0; font-size: 12px; color: #7A766C; }
    .deck-tools .deck-owned { font-weight: 700; color: #3F7D5C; }
    .deck-tools #deck-gameplan-btn { margin-left: auto; }
    .owned-chip { position: absolute; top: 8px; left: 8px; padding: 2px 7px; border-radius: 999px; background: rgba(63,125,92,0.9); color: #fff; font-size: 11px; font-weight: 700; }
    #gameplan-input { width: 100%; min-height: 240px; }
    #gameplan-count.over { color: #B3261E; font-weight: 700; }
```

- [ ] **Step 3: Sync `deckNotes` like `maybeboard`**

State init, after the `maybeboard:` line:

```js
      deckNotes: JSON.parse(localStorage.getItem("deck_notes") || "{}"),
```

`currentAppStatePayload`, after `maybeboard: state.maybeboard,`:

```js
        deckNotes: state.deckNotes,
```

`hasUsefulAppState`, after the `maybeboard` line:

```js
        (data.deckNotes && typeof data.deckNotes === "object" && Object.keys(data.deckNotes).length) ||
```

`applyAppState`, after the `maybeboard` block:

```js
      if (data.deckNotes && typeof data.deckNotes === "object") {
        state.deckNotes = data.deckNotes;
        localStorage.setItem("deck_notes", JSON.stringify(state.deckNotes));
      }
```

Migration merge (the object that contains `maybeboard: mergeMaybeboard(serverState.maybeboard, localState.maybeboard),`), add:

```js
        deckNotes: { ...(serverState.deckNotes || {}), ...(localState.deckNotes || {}) },
```

In both sync-signature arrays, change `synced.maybeboard,` to `synced.maybeboard, synced.deckNotes,` and `serverState.maybeboard,` to `serverState.maybeboard, serverState.deckNotes,`.

In the deck-delete cleanup, after `if (state.maybeboard[id]) { … }`:

```js
      if (state.deckNotes[id]) { delete state.deckNotes[id]; persistDeckNotes(); }
```

- [ ] **Step 4: Owned badge on deck tiles**

In `renderCardTile`, in the `el.innerHTML` template after the `${isMaybeCard ? … : ""}` line:

```js
        ${ownedQty(collectionIndex, card) > 0 ? `<span class="owned-chip">Owned</span>` : ""}
```

- [ ] **Step 5: Color filter, "Showing X of Y", and "Own X of Y" in `renderSavedCards`**

Replace:

```js
      const visible = filterByTypes(cards, savedTypeFilter);
```

with:

```js
      const visible = filterByTypes(cards, savedTypeFilter).filter((c) => deckColorMatch(c, deckColorFilter));
```

Directly after the line that computes `maybeVisible`, add:

```js
      renderDeckTools(isRealDeck, mainVisible);
```

- [ ] **Step 6: Add the deck tools and Game plan code**

Append at the end of the script:

```js
    // ── Decks tab: Game plan, Owned count, color filter ────────────────
    const DECK_NOTES_MAX_UI = 20000;

    function persistDeckNotes() {
      localStorage.setItem("deck_notes", JSON.stringify(state.deckNotes));
      queueOp({ type: "setDeckNotes", deckNotes: state.deckNotes });
    }
    function setDeckNotes(folderId, text) {
      const value = String(text || "").trim();
      if (value) state.deckNotes[folderId] = value;
      else delete state.deckNotes[folderId];
      persistDeckNotes();
    }

    function renderDeckTools(isRealDeck, mainVisible) {
      $("#deck-tools").style.display = "flex";
      const qty = (list) => list.reduce((n, c) => n + cardQty(state.activeFolder, c.id), 0);
      const allMain = getFolderCards(state.activeFolder).filter((c) => !isMaybe(state.activeFolder, c.id));
      $("#deck-showing").textContent = deckColorFilter.size ? `Showing ${qty(mainVisible)} of ${qty(allMain)}` : "";
      const own = isRealDeck && hasCollection() ? ownCount(collectionIndex, allMain.filter((c) => !isBasicLand(c))) : null;
      $("#deck-owned").textContent = own ? `Own ${own.owned} of ${own.total}` : "";
      const planBtn = $("#deck-gameplan-btn");
      planBtn.style.display = isRealDeck ? "" : "none";
      planBtn.textContent = state.deckNotes[state.activeFolder] ? "Game plan ✓" : "Game plan";
    }

    buildColorPicker($("#deck-colors"), deckColorFilter, () => renderSavedCards(), { colorless: true });

    const gameplanModal = $("#gameplan-modal");
    function updateGameplanCount() {
      const n = $("#gameplan-input").value.length;
      const counter = $("#gameplan-count");
      counter.textContent = n.toLocaleString();
      counter.classList.toggle("over", n > DECK_NOTES_MAX_UI);
      $("#gameplan-save").disabled = n > DECK_NOTES_MAX_UI;
    }
    $("#deck-gameplan-btn").addEventListener("click", () => {
      const deck = activeDeck();
      if (!deck) return;
      $("#gameplan-title").textContent = `Game plan · ${deck.name}`;
      $("#gameplan-input").value = state.deckNotes[deck.id] || "";
      updateGameplanCount();
      gameplanModal.classList.add("visible");
      setTimeout(() => $("#gameplan-input").focus(), 0);
    });
    $("#gameplan-input").addEventListener("input", updateGameplanCount);
    $("#gameplan-cancel").addEventListener("click", () => gameplanModal.classList.remove("visible"));
    gameplanModal.addEventListener("click", (e) => { if (e.target === gameplanModal) gameplanModal.classList.remove("visible"); });
    $("#gameplan-save").addEventListener("click", () => {
      const deck = activeDeck();
      if (deck) setDeckNotes(deck.id, $("#gameplan-input").value);
      gameplanModal.classList.remove("visible");
      renderSavedCards();
    });
```

- [ ] **Step 7: Syntax check and all tests**

Run: `node -e "const h=require('fs').readFileSync('public/index.html','utf8'); new Function(h.split('<script>')[1].split('</script>')[0]); console.log('script parses')" && npm test`
Expected: `script parses`; every suite passes.

- [ ] **Step 8: Ask the user to check the Decks tab**

With `npm start` running, ask the user to verify: in a real deck, **Game plan** opens the modal; pasting the Hei Bai primer (~13k characters with page text) keeps all of it, the counter updates, Save stores it (button shows "Game plan ✓") and it survives a reload and appears on another device; owned cards show an **Owned** chip and the header shows "Own X of Y"; the color filter (including Colorless) narrows the grid and shows "Showing X of Y" while analysis and export still cover the whole deck.

- [ ] **Step 9: Commit**

```bash
git add public/index.html
git commit -m "Add deck Game plan, Owned badges, and deck color filter

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: README, pilot run, and measured estimates

**Files:**
- Create: `scripts/pilot-swaps.mjs`
- Modify: `lib/profiles.js` (`PROFILE_TOKENS_PER_CARD`), `README.md`, `package.json`

**Interfaces:**
- Consumes: `createCollectionStore`, `createProfileStore`, `runProfileJob`, `createEmbeddingStore`, `createLocalEmbedder`, `createRankingCache`, `createSwapsService`, `collectionOracleCards`, `createAiClient`, `createUsageLog`, `oracleIdOf`, `PROFILE_BATCH_SIZE`.
- Produces: `data/pilot/report.md` (git-ignored) and measured `PROFILE_TOKENS_PER_CARD`.

- [ ] **Step 1: Write the pilot script**

`scripts/pilot-swaps.mjs`:

```js
// Paid pilot (spec § Rollout). Without --yes it only prints the plan and estimate.
// Usage: node scripts/pilot-swaps.mjs --csv "C:\path\to\ManaBox_Collection.csv" [--yes]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCollectionStore } from "../lib/collection-store.js";
import { createProfileStore, oracleIdOf } from "../lib/profiles.js";
import { createEmbeddingStore, createLocalEmbedder } from "../lib/embeddings.js";
import { createRankingCache } from "../lib/swaps.js";
import { collectionOracleCards, createSwapsService } from "../lib/swaps-service.js";
import { createAiClient, priceUsd } from "../lib/ai-client.js";
import { createUsageLog } from "../lib/ai-usage.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const csvPath = args[args.indexOf("--csv") + 1];
const confirmed = args.includes("--yes");
if (!args.includes("--csv") || !csvPath) { console.error("Usage: node scripts/pilot-swaps.mjs --csv <ManaBox CSV> [--yes]"); process.exit(1); }

const pilotDir = join(root, "data", "pilot");
const workDir = join(pilotDir, "work");
await mkdir(workDir, { recursive: true });

// 1. Collection (Scryfall lookups are free).
const collectionStore = createCollectionStore({ dataDir: workDir });
const preview = await collectionStore.preview(await readFile(csvPath, "utf8"));
await collectionStore.apply(preview.previewId, "sync");
const byOid = collectionOracleCards(await collectionStore.loadCards());

// 2. ~60-card sample across archetypes (deterministic: sorted by name).
const text = (c) => `${c.type_line || ""}\n${c.oracle_text || (c.card_faces || []).map((f) => `${f.type_line}\n${f.oracle_text}`).join("\n")}`;
const buckets = [
  ["flicker", (c) => /exile [^.]*(you control|you own)[^.]*return/i.test(text(c))],
  ["exile removal", (c) => /exile target (creature|nonland permanent|permanent|artifact|enchantment)/i.test(text(c)) && !/return/i.test(text(c))],
  ["shrines & spirits", (c) => /\b(Shrine|Spirit)\b/.test(c.type_line || "")],
  ["landfall", (c) => /landfall|whenever a land (you control )?enters/i.test(text(c))],
  ["zombies & aristocrats", (c) => /\bZombie\b/.test(c.type_line || "") || /sacrifice (a|another) creature/i.test(text(c))],
  ["lifegain", (c) => /gains? (\d+|x) life|whenever you gain life/i.test(text(c))],
  ["goodstuff", () => true],
];
const all = [...byOid.values()].filter((e) => e.card.legalities?.commander === "legal" && !/Basic Land/.test(e.card.type_line || "")).sort((a, b) => a.card.name.localeCompare(b.card.name));
const chosen = new Map();
for (const [label, match] of buckets) {
  all.filter((e) => !chosen.has(e.oracleId) && match(e.card)).slice(0, label === "goodstuff" ? 60 - chosen.size : 9).forEach((e) => chosen.set(e.oracleId, { ...e, bucket: label }));
}
const sample = [...chosen.values()];

// 3. AI settings from the app's state (same key/model the app uses).
const appState = JSON.parse(await readFile(join(root, "data", "state.json"), "utf8").catch(() => "{}"));
const apiKey = process.env.ANTHROPIC_API_KEY || appState.apiKey;
const model = process.env.ANTHROPIC_MODEL || appState.anthropicModel || "claude-sonnet-5";
const ai = apiKey ? createAiClient({ provider: "anthropic", apiKey, model }) : null;

// 4. Decks: Hei Bai (with primer) + three fixture decks (without a game plan).
async function scryfallByName(names) {
  const out = [];
  for (let i = 0; i < names.length; i += 75) {
    const res = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Spellbook/0.1" },
      body: JSON.stringify({ identifiers: names.slice(i, i + 75).map((name) => ({ name })) }),
    });
    out.push(...((await res.json()).data || []));
    await new Promise((r) => setTimeout(r, 100));
  }
  return out;
}
const heiBai = JSON.parse(await readFile(join(pilotDir, "hei-bai-budget-deck.json"), "utf8"));
const primer = await readFile(join(pilotDir, "hei-bai-primer.md"), "utf8");
const deckSpecs = [{ name: heiBai.name, commander: heiBai.commanders[0], names: heiBai.cards.map((c) => c.name), gamePlan: primer, picks: 4 }];
for (const id of ["landfall", "zombies", "lifegain"]) {
  const f = JSON.parse(await readFile(join(root, "fixtures", "moxfield-snapshots", `${id}.json`), "utf8"));
  const commander = (f.pageTitle.match(/Commander \(([^)]+)\)/) || [])[1];
  deckSpecs.push({ name: f.pageTitle.split(" // ")[0], commander, names: f.cards.map((c) => c.name), gamePlan: "", picks: 2 });
}
const decks = [];
for (const spec of deckSpecs) {
  const cards = await scryfallByName([...new Set([spec.commander, ...spec.names])]);
  const commander = cards.find((c) => c.name === spec.commander || c.name.split(" // ")[0] === spec.commander);
  const eur = (c) => Number(c.prices?.eur || c.prices?.eur_foil || 0);
  const targets = cards.filter((c) => c !== commander && !/\bLand\b/.test(c.type_line || "")).sort((a, b) => eur(b) - eur(a)).slice(0, spec.picks);
  decks.push({
    targets,
    colorIdentity: commander?.color_identity || [],
    deck: {
      name: spec.name,
      commander: commander ? { name: commander.name, typeLine: commander.type_line, text: commander.oracle_text || (commander.card_faces || []).map((f) => f.oracle_text).join("\n") } : null,
      gamePlan: spec.gamePlan, identityTags: [], cardNames: spec.names, signature: `pilot-${spec.name}`,
    },
  });
}

const rankCount = decks.reduce((n, d) => n + d.targets.length, 0);
console.log(`Sample: ${sample.length} cards (${buckets.map(([b]) => `${b}: ${sample.filter((s) => s.bucket === b).length}`).join(", ")})`);
console.log(`Rankings: ${rankCount} (${decks.map((d) => `${d.deck.name}: ${d.targets.map((t) => t.name).join(", ")}`).join(" | ")})`);
const roughUsd = priceUsd(model, { inputTokens: sample.length * 150 + rankCount * 6000, outputTokens: sample.length * 110 + rankCount * 1500 });
console.log(`Model: ${model} · rough pilot cost ≈ $${(roughUsd ?? 0).toFixed(2)}`);
if (!ai) { console.error("No Anthropic API key found (Settings or ANTHROPIC_API_KEY)."); process.exit(1); }
if (!confirmed) { console.log("Dry run. Re-run with --yes to spend."); process.exit(0); }

// 5. Run the real service over the sample only.
const usageLog = createUsageLog({ dataDir: workDir });
const sampleCards = Object.fromEntries(sample.map((s) => [s.card.id, s.card]));
let embedderPromise = null; // load the model once
const service = createSwapsService({
  collectionStore: { load: collectionStore.load, loadCards: async () => sampleCards },
  profileStore: createProfileStore({ dataDir: workDir }),
  embeddingStore: createEmbeddingStore({ dataDir: workDir }),
  rankingCache: createRankingCache({ dataDir: workDir }),
  usageLog,
  getAi: async () => ai,
  getEmbedder: () => (embedderPromise ||= createLocalEmbedder({ cacheDir: join(root, "data", "models") })),
});
await service.prepare();
await service.idle();
const st = await service.status();
if (st.phase !== "ready") { console.error("Prepare did not finish:", st); process.exit(1); }

const lines = [`# Swaps pilot — ${new Date().toISOString()}`, "", `Model: ${model}`, "", "## Profiles", ""];
const profiles = JSON.parse(await readFile(join(workDir, "card-profiles.json"), "utf8")).profiles;
for (const s of sample) {
  const p = profiles[s.oracleId];
  lines.push(`- **${s.card.name}** (${s.bucket}): ${p ? `${p.summary} [${p.mechanics.join(", ")}] — ${p.synergies.join("; ")}` : "_not profiled_"}`);
}
lines.push("", "## Rankings", "");
for (const d of decks) {
  lines.push(`### ${d.deck.name}${d.deck.gamePlan ? " (with Game plan)" : " (no Game plan)"}`, "");
  for (const target of d.targets) {
    const r = await service.swaps({ card: target, colorIdentity: d.colorIdentity, deck: d.deck });
    lines.push(`**${target.name}** (€${target.prices?.eur ?? "?"}) — mode: ${r.body.mode}${r.body.aiError ? `, AI error: ${r.body.aiError}` : ""}`);
    if (!r.body.results?.length) lines.push("- No match found in the sample.");
    for (const x of r.body.results || []) lines.push(`- ${x.match}% ${x.card.name}: ${x.reason}`);
    lines.push("");
  }
}

// 6. Measured cost.
const usage = JSON.parse(await readFile(join(workDir, "ai-usage.json"), "utf8")).entries;
const sum = (feature, key) => usage.filter((e) => e.feature === feature).reduce((n, e) => n + (e[key] || 0), 0);
const profiledCount = sample.filter((s) => profiles[s.oracleId]).length;
const profileRequests = usage.filter((e) => e.feature === "profile").length;
lines.push("## Measured usage", "",
  `- Profiling: ${profileRequests} requests, ${sum("profile", "inputTokens")} input / ${sum("profile", "outputTokens")} output tokens, $${sum("profile", "usd").toFixed(4)}`,
  `- Per profiled card: ${Math.round(sum("profile", "inputTokens") / profiledCount)} input / ${Math.round(sum("profile", "outputTokens") / profiledCount)} output tokens`,
  `- Rankings: ${usage.filter((e) => e.feature === "rank").length} requests, $${sum("rank", "usd").toFixed(4)} (cache reads ${sum("rank", "cacheReadTokens")} tokens)`,
  `- Total: $${usage.reduce((n, e) => n + (e.usd || 0), 0).toFixed(4)}`);
await writeFile(join(pilotDir, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.slice(-6).join("\n"));
console.log(`Report: ${join(pilotDir, "report.md")}`);
```

Note on per-card tokens: profiling in the pilot runs in batches of up to 25, like production, so the per-card numbers match what full-collection estimates need.

- [ ] **Step 2: Dry run (free)**

Add to `package.json` scripts:

```json
    "pilot:swaps": "node scripts/pilot-swaps.mjs"
```

Run: `npm run pilot:swaps -- --csv "C:\Users\Adrian\Downloads\TaliaManaBox_Collection.csv"`
Expected: prints the sample breakdown, the target cards per deck, the model (`claude-sonnet-5`), a rough cost under $1, and `Dry run. Re-run with --yes to spend.`

- [ ] **Step 3: STOP — get the user's go-ahead**

Show the user the dry-run output (sample, targets, estimated cost) and ask for explicit approval to spend it. Do not continue without a yes.

- [ ] **Step 4: Run the pilot**

Run: `npm run pilot:swaps -- --csv "C:\Users\Adrian\Downloads\TaliaManaBox_Collection.csv" --yes`
Expected: completes; prints measured usage; writes `data/pilot/report.md`.

- [ ] **Step 5: Review the results with the user (go/no-go)**

Summarize `data/pilot/report.md` for the user: a few representative profiles per archetype, the Hei Bai rankings (with Game plan) vs. the fixture decks (without), anything that looks wrong, and the measured cost. The user decides:
- **Go** → continue with Step 6.
- **No-go** → adjust `PROFILE_SYSTEM_PROMPT` / `RANK_SYSTEM_PROMPT` (bump `PROMPT_VERSION` for profile changes), delete `data/pilot/work/card-profiles.json` and `swap-rankings.json`, and repeat Steps 2–5 on the same sample. Never profile the full collection first.

- [ ] **Step 6: Set the measured estimate constants**

In `lib/profiles.js`, replace `PROFILE_TOKENS_PER_CARD = { input: 150, output: 110 }` with the pilot's measured per-card numbers (rounded up to the next 10), and update its comment to cite the pilot date. For example, if the pilot measured 187 input / 96 output:

```js
// Average tokens per card in one batched profiling request, measured in the
// 2026-09-27 pilot (claude-sonnet-5). Used for the cost estimate before Start.
export const PROFILE_TOKENS_PER_CARD = { input: 190, output: 100 };
```

Run: `npm test` → all suites pass.

- [ ] **Step 7: Write the README section**

Add a `## Collection & Swaps` section to `README.md` (after the existing feature sections, before `## Docker / Unraid`) covering, with the measured values filled in:

```markdown
## Collection & Swaps

**Import your collection.** In ManaBox, open the Collection tab and use the
top-right menu to export the whole collection as CSV (or export a single
binder/list for new scans). In Spellbook's **Collection** tab, choose **Upload
CSV** and pick the file. The preview offers two modes:

- **Full collection** — Spellbook matches the file exactly (adds, updates,
  removes). Use this for whole-collection exports.
- **New cards** — adds the file's cards on top and never removes anything. Use
  this for a freshly scanned binder. Rows already imported are skipped, so
  uploading the same file twice doesn't double-count.

**View Swaps.** Select any card and press **View Swaps** in the focus panel to
see cards you own that could replace it, each with a match % and a reason.
Inside a deck, matches respect the commander's colors and the deck's **Game
plan** — paste the deck's primer (or describe how it wins) via the Game plan
button on the deck.

**AI cost.** Swaps use the AI provider and model from Settings (default
`claude-sonnet-5`). Every card in the collection is profiled once — Spellbook
asks before profiling more than 50 cards and shows the estimate (measured:
≈ $<PILOT_TOTAL_FOR_1900_CARDS> for ~1,900 cards on Sonnet 5). New pack scans
are profiled automatically. Each ranking costs ≈ $<PILOT_PER_RANKING> and is
cached per deck version. The Collection tab shows this month's AI spend.
Without an API key, swaps fall back to text-based matching.

**Local model.** Matching uses a small local embedding model
(`Xenova/all-MiniLM-L6-v2`, ~23 MB) that downloads into the data folder on
first use. The Docker image is based on `node:22-slim` (≈ <IMAGE_SIZE>).
```

Replace the three `<…>` markers with the pilot's measured values (per-card cost × 1,900; average ranking cost) and the measured image size (or "built on Unraid" if Docker isn't available locally). These markers must not remain in the committed README.

Also update the `## Docker / Unraid` section: the base image is now `node:22-slim`, and the embedding model is cached under the data volume in `models/`.

- [ ] **Step 8: Commit**

```bash
git add scripts/pilot-swaps.mjs lib/profiles.js README.md package.json
git commit -m "Add swaps pilot script, measured cost estimates, and README section

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Hand over the full-collection run**

Tell the user the pilot is done and the estimate constants are real. They can now upload their whole-collection CSV in the Collection tab and press **Start** when they're happy with the shown estimate. On Unraid: rebuild the image (`docker compose up -d --build`) and choose **Sonnet 5** in Settings there.
