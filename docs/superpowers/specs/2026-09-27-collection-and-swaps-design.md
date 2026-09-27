# Collection Tab & View Swaps — Design

Date: 2026-09-27
Status: Approved (pending spec review)

## Goal

Let the user upload their ManaBox collection, browse it in a new **Collection** tab,
and — for any card they think is too expensive — tap **View Swaps** in the Focus
panel to see cards they already own that could replace it, each with a similarity %
(modelled on mtgreplace.com). Decks also gain **Owned** badges and a color filter.

## Scope

In scope:
1. Collection import (ManaBox whole-collection CSV) with a diff preview and sync.
2. Collection tab: browse, search, color filter, binder filter, sort.
3. View Swaps: per-card replacements from the collection, scored by text similarity
   (local embedding model) adjusted by role, card type, and mana value.
4. Owned badges and an "Own X of Y" count on decks.
5. Color filter on the cards of the open deck (Decks tab).

Out of scope (explicitly deferred):
- A "Swap into deck" button (view is read-only).
- "Refine with AI" re-ranking.
- A watched drop folder on the Unraid share.
- A whole-deck swap report (Swaps is per card, on demand).
- Filtering the *list of decks* by color.
- Merging multiple ManaBox accounts (the user merges in ManaBox before exporting).

## Input format

ManaBox "export whole collection" CSV. Header (verified against real exports):

```
Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,
ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Signed,Condition,Language,Proxy,
Purchase price currency,Added
```

- Required columns: `Scryfall ID`, `Quantity`, `Name`. Missing any → reject the file
  with "This doesn't look like a ManaBox export (missing: …)". Nothing changes.
- `Binder Name` / `Binder Type` are optional (per-binder exports lack them); absent →
  binder is `""`.
- Values may be quoted (e.g. `"all cards "`, names with commas like
  `"Grond, the Gatebreaker"`), files may have a BOM and CRLF line endings. The parser
  must be a real RFC 4180 parser, not a line/`split(",")` parser.
- Binder names are kept verbatim (including trailing spaces) as keys, trimmed for display.

## Data model (server)

Two new files in `DATA_DIR`, separate from `state.json` so device sync stays small:

**`data/collection.json`**
```json
{
  "syncedAt": "2026-09-27T12:00:00.000Z",
  "entries": {
    "<scryfallId>|<foil>|<binder>": {
      "scryfallId": "…", "foil": "normal|foil|etched", "binder": "New Releases",
      "qty": 2, "added": "2026-01-18T15:41:37.551Z"
    }
  }
}
```
- Entry key = Scryfall ID + foil + binder. Rows with the same key (e.g. different
  conditions) are summed.
- `added` is the earliest ManaBox `Added` value for the key; preserved across syncs.

**`data/collection-cards.json`** — `{ [scryfallId]: slimCard }`, where `slimCard`
keeps only the fields the app reads: `id, oracle_id, name, layout, mana_cost, cmc,
type_line, oracle_text, power, toughness, loyalty, colors, color_identity, keywords,
produced_mana, legalities.commander, set, set_name, collector_number, rarity,
prices{eur,eur_foil,usd}, image_uris{small,normal,large,png}, card_faces[]` (each face
slimmed to `name, mana_cost, type_line, oracle_text, power, toughness, colors,
image_uris`), `scryfall_uri, edhrec_rank`. The list lives in one constant,
`SLIM_CARD_FIELDS`, in `lib/collection.js`.

**`data/collection-embeddings.json`** — `{ model, dims, vectors: { [oracle_id]: base64(Float32Array) } }`.
If `model` differs from the configured model, the file is discarded and rebuilt.

**`data/models/`** — the embedding model cache (downloaded on first use).

All three JSON files are written atomically (write `*.tmp`, then rename).

## "Owned"

A card is owned if its `oracle_id` appears in the collection (any printing, any
binder, any foil). Owned quantity for a card = sum of `qty` over entries whose card
has that `oracle_id`.

## Server API

New modules keep `server.js` from growing:
- `lib/collection.js` — CSV parsing, entry aggregation, diffing, slimming, Scryfall
  batch lookup, file IO.
- `lib/swaps.js` — text normalization, embedding model lifecycle, embedding cache,
  candidate filtering and text-similarity ranking.

`server.js` only wires routes to these modules.

### `GET /api/collection`
Returns `{ syncedAt, entries, cards }` (`cards` = slim cards for all entries). Empty
collection → `{ syncedAt: null, entries: {}, cards: {} }`.

### `POST /api/collection/preview` — body `{ csv }`
Parses and diffs against the stored collection; stores the parsed result in memory
under a random `previewId` (expires after 15 minutes). Returns:
```json
{
  "previewId": "…",
  "summary": { "added": 14, "changed": 3, "removed": 2, "totalAfter": 2827 },
  "details": {
    "added":   [{ "name": "…", "set": "FDN", "number": "103", "foil": "normal", "binder": "…", "qty": 1 }],
    "changed": [{ "…": "…", "qtyBefore": 1, "qtyAfter": 2 }],
    "removed": [{ "…": "…", "qty": 1 }]
  },
  "warning": "This would remove 2,700 of 2,786 cards — is this the whole-collection export?"
}
```
- `warning` is set when the sync would remove more than half of the current cards
  (by quantity); otherwise `null`.
- First-ever upload: everything is `added`, no warning.
- Uses `Name`, `Set code`, `Collector number` from the CSV for display, so preview needs
  no Scryfall calls and is instant.

### `POST /api/collection/apply` — body `{ previewId }`
1. Unknown/expired `previewId` → 410 "Preview expired — upload the file again."
2. Look up Scryfall IDs not already in `collection-cards.json` via
   `POST https://api.scryfall.com/cards/collection` (75 identifiers per request,
   ~100 ms between requests, per Scryfall guidelines).
3. Any Scryfall request fails → 502 "Couldn't reach Scryfall. Try again." and **nothing
   is written**.
4. IDs Scryfall reports as `not_found` are kept in `entries` but listed in the response
   as `unmatched` (shown to the user as "N cards couldn't be matched on Scryfall");
   they don't appear in the grid.
5. Write `collection.json` and `collection-cards.json`; drop cards no longer referenced.
6. Start background embedding for any new `oracle_id`s (does not block the response).
7. Return the new `GET /api/collection` payload plus `unmatched`.

### `GET /api/swaps/status`
`{ state: "idle" | "downloading" | "embedding" | "ready" | "error", done, total, error }`.

### `POST /api/swaps` — body `{ card, colorIdentity, excludeOracleIds }`
- `card` is the original card (slim fields; may not be in the collection).
- `colorIdentity` is the allowed identity (see *Candidate filters*).
- `excludeOracleIds` are the cards already in the open deck.
- If embeddings aren't ready → `202 { status }` and the client polls `/api/swaps/status`.
- Otherwise → `200 { candidates: [{ oracle_id, scryfallIds: [...], textScore }] }`,
  top 50 by `textScore`, after candidate filters.

## Text similarity (`lib/swaps.js`)

- Library: `@huggingface/transformers` (native `onnxruntime-node` backend).
- Model: `Xenova/all-MiniLM-L6-v2`, quantized (~23 MB), `env.cacheDir = DATA_DIR/models`.
  Mean pooling + L2 normalization → 384-dim vectors; similarity = dot product (cosine).
- Loaded lazily on the first `/api/swaps` or after a sync; model load failure sets
  status `error` with the message.
- Embedding text per card (`normalizeCardText`):
  1. Oracle text; for multi-face cards, faces' oracle text joined with `\n`.
  2. Remove parenthesized reminder text.
  3. Replace the card's name, each face name, and the short name of a legendary
     (text before the first comma, e.g. "Mica") with `CARDNAME`.
  4. Collapse whitespace. If the result is empty (vanilla creature), use the type line.
- Embeddings are cached by `oracle_id`; only unseen `oracle_id`s are embedded after a
  sync. The original card is embedded on the fly if it isn't cached (in-memory cache).

## Candidate filters (server)

A collection card is a candidate only if all hold:
- `color_identity` ⊆ allowed identity. Allowed identity = the open deck's commander's
  color identity; if no deck/commander is active, the original card's own identity.
- `oracle_id` ≠ original's `oracle_id` (no other printings of the same card).
- `oracle_id` ∉ `excludeOracleIds`.
- `legalities.commander === "legal"`.
- Land-ness matches: lands only for lands, nonlands only for nonlands.
- Not a basic land.

## Final score (client, `public/index.html`)

Client blends so it can reuse the existing role detection:

```
score = 0.60·text + 0.25·role + 0.10·type + 0.05·mv
```
- `text` — `textScore` from the server.
- `role` — Jaccard overlap of role sets (ramp, draw, removal, wipes, tutors,
  interaction, graveyardHate, protection). If the original has no detected roles, the
  role weight is moved onto `text` (0.85·text + 0.10·type + 0.05·mv).
- `type` — over primary types (Creature, Instant, Sorcery, Artifact, Enchantment,
  Planeswalker, Battle, Land): 1 if identical sets; 0.5 if they overlap or it is an
  Instant↔Sorcery pair; else 0.
- `mv` — `max(0, 1 − |Δcmc| / 4)`.
- Show up to `SWAP_MAX_RESULTS = 8` with `score ≥ SWAP_MIN_SCORE = 0.40`, sorted by
  score. Weights live in one `SWAP_WEIGHTS` constant. Weights and threshold are
  starting values, tuned against the real collection during implementation.

**Refactor needed:** role detection currently lives inline in the deck-analysis code.
Extract a `cardRoleSet(card)` helper used by both analysis and swaps, with no change to
analysis results (guarded by the existing `npm run test:deck-analysis`).

## UI

### Collection tab
- New tab button `data-tab="collection"` beside Search and Decks (top tabs and side
  rail); `setActiveTab` gains a third branch showing `#collection-section`.
- Header: unique cards · total copies · total value (€, `prices.eur`, falling back to
  `eur_foil` for foils) · "Synced <date>".
- Controls: name search, mana-symbol color picker (same component as Search, **fits
  within** semantics: `color_identity ⊆ selected`), binder dropdown ("All binders" +
  trimmed binder names), sort by name / price / mana value, **Upload** button.
- Grid: the same card tiles as the Decks grid, rendered 60 at a time with a
  "Show more" button; images `loading="lazy"`. Each tile shows "×N" when N > 1.
  Selecting a tile opens the Focus panel, which shows "Owned ×N".
- Empty state: how to export from ManaBox (Collection tab → top-right menu → export
  the whole collection as CSV) and an Upload button.
- Upload flow: file picker (`.csv`) → `preview` → modal with the summary line
  ("+14 new · 3 quantity changes · 2 removed"), expandable lists, and the warning if
  present → **Confirm** (`apply`, spinner "Looking up N new cards on Scryfall…") or
  **Cancel**. Errors are shown in the modal; nothing is saved on error.
- Filter state (search, colors, binder, sort) is session-only.

### Focus panel
- New button `#detail-swaps-btn` **"View Swaps"**, next to Combos/EDHREC. Visible when
  the collection has at least one entry and the card is not a basic land.
- "Owned ×N" line in the detail rows when the card is owned.

### Swaps view
- A full-page view in its own container `#swaps-view`, opened from any tab. On open it
  snapshots `{ tab, activeFolder, scrollY }`; **← Back** restores exactly that (unlike
  Combos, which always returns to Search).
- Header: "Swaps for <card>". Original card image + rules-text panel + price.
- Summary line: "N cards from your collection can replace <card>."
- Grid of results; each: image, name, similarity bar with %, "Owned ×N", price,
  "saves €X" (only when the original's price is higher), Scryfall and EDHREC links.
  Selecting one opens it in the Focus panel.
- States:
  - Preparing → "Preparing your collection for matching… 640 / 1,925", polling
    `/api/swaps/status` every 2 s, then re-requesting.
  - No candidates above threshold → **"No match found in your collection."**
  - Error → message + **Retry**.

### Decks tab
- **Owned badges**: an "Owned" chip on each deck tile whose `oracle_id` is owned
  (main deck and Maybeboard).
- **"Own X of Y"** in the deck header: distinct non-basic-land cards in the main deck
  (Maybeboard excluded, matching deck size rules).
- Both hidden when no collection is uploaded.
- **Color filter**: the mana-symbol picker plus a **Colorless** toggle beside the type
  chips. **Contains** semantics: a card shows if its `color_identity` includes any
  selected color; Colorless matches empty identity. Display-only — analysis, counts,
  and export still use the whole deck. Header shows "Showing 23 of 94" while active.
  Session-only.

## Docker

- Base image `node:22-alpine` → **`node:22-slim`** (glibc required by
  `onnxruntime-node`). Same `DATA_DIR`, port, volume, and `compose.yaml`.
- `mkdir -p /app/data/models` owned by `node`.
- Measure image size before/after and first-run embedding time on the real collection;
  record both in the README.

## Testing

Plain Node scripts, matching the existing `scripts/check-*.mjs` pattern:

- `npm run test:collection` (`scripts/check-collection.mjs`, fixtures in
  `fixtures/collection/`):
  - CSV parsing: quoted fields, commas in names, BOM, CRLF, missing required columns,
    per-binder export without binder columns.
  - Aggregation of rows sharing a key.
  - Diff: added / changed / removed, first upload, >50% removal warning, `added`
    date preserved.
  - Slimming keeps exactly `SLIM_CARD_FIELDS`.
- `npm run test:swaps` (`scripts/check-swaps.mjs`):
  - `normalizeCardText`: reminder text removal, name/face/short-name replacement,
    vanilla fallback.
  - Candidate filters: identity subset, same `oracle_id`, deck exclusion, legality,
    land/nonland, basics.
  - Client blend: weights, role-weight redistribution, type and mv components,
    threshold and max results (functions extracted from `public/index.html` as the
    existing tests do).
- `npm run test:swaps:model` (slow, downloads the model): sanity rankings, e.g.
  *Murder* → *Doom Blade* ranks above *Llanowar Elves* and *Divination*.
- `npm run test:deck-analysis` must still pass after the `cardRoleSet` extraction.
- UI is verified manually by the user (no browser automation).

## README

Add a "Collection & Swaps" section: exporting from ManaBox, sync behaviour, first-run
model download, and the measured image size / timing.
