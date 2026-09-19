import { readFile } from "node:fs/promises";

const [server, client] = await Promise.all([
  readFile(new URL("../server.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
]);

const errors = [];
const requireText = (source, text, description) => {
  if (!source.includes(text)) errors.push(`Missing ${description}.`);
};

requireText(server, "DECK_IDENTITY_TAGS", "the allowed deck-identity catalog");
requireText(server, '"identityTags"', "identityTags in the AI response contract");
requireText(server, "Do not use Aristocrats merely because", "the sacrifice versus Aristocrats guardrail");
requireText(server, "Commander: ${commander", "commander context in the AI request");
requireText(client, "IDENTITY_TAG_LENSES", "the hidden identity-to-lens map");
requireText(client, "deckIdentityHtml", "the read-only deck identity renderer");
requireText(client, "const DECK_REVIEW_CACHE_VERSION = 3", "the identity-aware cache version");
requireText(client, "commanderName", "commander-aware review cache signatures");

for (const obsoleteManualControl of ["deckTagKeys", "deckTagsHtml", "da2-tag-add", "da2-tag-reset"]) {
  if (client.includes(obsoleteManualControl)) errors.push(`Manual tag control still present: ${obsoleteManualControl}.`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("Deck-identity contract is valid: AI-derived, read-only, and commander-aware.");
