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
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
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
  const rows = parseManaBoxCsv("﻿" + whole.replace(/\r?\n/g, "\r\n"));
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
