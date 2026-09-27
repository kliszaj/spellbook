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
