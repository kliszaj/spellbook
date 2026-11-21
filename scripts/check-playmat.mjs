// Evaluates the "Play in Playmat" helpers from public/index.html (between the markers) and reads their links back
// the way Playmat does (decodePayload in Mage.Web.Client/src/core/deckImport/payload.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, run } from "./lib/tiny-test.mjs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const BEGIN = "// @testable playmat-helpers begin";
const END = "// @testable playmat-helpers end";
if (!html.includes(BEGIN) || !html.includes(END)) throw new Error("playmat-helpers markers not found in public/index.html");
const block = html.split(BEGIN)[1].split(END)[0];
const h = Function(`${block}; return { playmatDeckList, encodePlaymatPayload, playmatImportUrl };`)();

// Playmat's decodePayload, ported line for line
function playmatDecode(fragment) {
  const match = /(?:^#?|&)deck=([A-Za-z0-9_-]+)/.exec(fragment);
  const encoded = match ? match[1] : null;
  if (!encoded) return null;
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const binary = atob(base64);
  const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0))));
  if (typeof value.text !== "string" || !value.text.trim() || typeof value.site !== "string" || typeof value.url !== "string") return null;
  return value;
}

const deck = {
  commanders: [{ name: "Atraxa, Praetors' Voice", qty: 1 }],
  main: [
    { name: "Sol Ring", qty: 1 },
    { name: "Forest", qty: 14 },
    { name: "Delver of Secrets // Insectile Aberration", qty: 1 },
  ],
};

test("deck list: commander section, then the deck with counts", () => {
  assert.equal(
    h.playmatDeckList(deck),
    ["Commander", "1 Atraxa, Praetors' Voice", "", "Deck", "1 Sol Ring", "14 Forest", "1 Delver of Secrets // Insectile Aberration"].join("\n"),
  );
});

test("deck list: no commander, no Commander header", () => {
  assert.equal(h.playmatDeckList({ main: [{ name: "Island", qty: 20 }] }), "Deck\n20 Island");
});

test("deck list: bad counts become 1, nameless cards are dropped", () => {
  assert.equal(h.playmatDeckList({ main: [{ name: "Opt", qty: 0 }, { name: "", qty: 3 }, { name: "Ponder" }] }), "Deck\n1 Opt\n1 Ponder");
});

test("link: Playmat reads back the same deck, including non-ASCII names", () => {
  const payload = { site: "spellbook", url: "http://10.0.0.240:3666/", text: h.playmatDeckList(deck) + "\n1 Lim-Dûl's Vault", name: "Atraxa ✦ Superfriends" };
  const link = h.playmatImportUrl("https://10.0.0.240:8443/", payload);
  assert.ok(link.startsWith("https://10.0.0.240:8443/import#deck="), link);
  assert.deepEqual(playmatDecode(new URL(link).hash), payload);
});

test("link: base64url only (no +, / or = that would break the fragment)", () => {
  const encoded = h.encodePlaymatPayload({ site: "spellbook", url: "x", text: "1 ???>>>~~~" });
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
});

test("link: refuses a payload over Playmat's 200 KB limit", () => {
  const huge = { site: "spellbook", url: "x", text: "1 Plains\n".repeat(30000) };
  assert.equal(h.playmatImportUrl("https://p.example", huge), null);
});

await run("playmat");
