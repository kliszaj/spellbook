# Collection Tab & View Swaps — Design

Date: 2026-09-27
Status: Approved

## Goal

Let the user upload their ManaBox collection, browse it in a new **Collection** tab,
and — for any card they think is too expensive — tap **View Swaps** in the Focus
panel to see cards they already own that could replace it. Replacements are judged on
what the card actually does and how it serves *this* deck's game plan (e.g. a Hei Bai
flicker deck), each with a match % and a one-line reason (layout modelled on
mtgreplace.com). Decks also gain **Owned** badges, a color filter, and a **Game plan**
note that feeds the swap ranking.

**Deck-agnostic.** Everything works for any Commander deck: the ranking is driven by
that deck's commander, Game plan, and decklist. No prompt, constant, or code path may
mention a specific deck or commander. The first deck the user will use it on is a Hei
Bai, Forest Guardian five-color flicker deck (moxfield.com/decks/iOjVZsUJDE-obopPqMbrPA,
primer at moxfield.com/decks/If9oCujb9kGFIoPNrLnZpA/primer); the pilot deliberately
also covers unrelated archetypes (see *Rollout*).

## Scope

In scope:
1. Collection import from ManaBox CSVs: **full sync** or **add new cards**, with a diff
   preview.
2. Collection tab: browse, search, color filter, binder filter, sort.
3. AI **card profiles** for every collection card (what it does, mechanics, synergies),
   generated once and cached.
4. **View Swaps**: shortlist by profile similarity (local embedding model), then
   **deck-aware AI ranking** with match % and reason.
5. Deck **Game plan** field (paste a primer or describe how the deck wins).
6. Owned badges and an "Own X of Y" count on decks.
7. Color filter on the cards of the open deck (Decks tab).

Out of scope (explicitly deferred):
- A dedicated "Swap into deck" button — result tiles use the existing bookmark /
  deck picker; the original can be moved out with the existing **Mark as Maybe**.
- Fetching Moxfield primers automatically (Moxfield's API does not return the primer
  body; the user pastes it).
- A watched drop folder on the Unraid share.
- A whole-deck swap report (Swaps is per card, on demand).
- Filtering the *list of decks* by color.
- Merging multiple ManaBox accounts (done in ManaBox before exporting).

## Input format

ManaBox CSV export. Header (verified against real exports):

```
Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,
ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Signed,Condition,Language,Proxy,
Purchase price currency,Added
```

- Required columns: `Scryfall ID`, `Quantity`, `Name`. Missing any → reject with
  "This doesn't look like a ManaBox export (missing: …)". Nothing changes.
- `Binder Name` / `Binder Type` are optional (per-binder exports may lack them);
  absent → binder is `""`.
- Values may be quoted (e.g. `"all cards "`, `"Grond, the Gatebreaker"`); files may
  have a BOM and CRLF line endings. Use a real RFC 4180 parser.
- Binder names are kept verbatim as keys, trimmed for display.

## Data model (server)

New files in `DATA_DIR`, separate from `state.json` so device sync stays small. All
JSON files are written atomically (write `*.tmp`, then rename).

**`data/collection.json`**
```json
{
  "syncedAt": "2026-09-27T12:00:00.000Z",
  "entries": {
    "<scryfallId>|<foil>|<binder>": {
      "scryfallId": "…", "foil": "normal|foil|etched", "binder": "New Releases",
      "qty": 2, "added": "2026-01-18T15:41:37.551Z"
    }
  },
  "importedRows": ["<scryfallId>|<foil>|<binder>|<Added>", "…"]
}
```
- Entry key = Scryfall ID + foil + binder; rows sharing a key are summed.
- `added` = earliest ManaBox `Added` for the key; preserved across syncs.
- `importedRows` = fingerprints of every CSV row ever applied (dedupes add-only
  uploads; see *Upload modes*). A full sync replaces it with the file's fingerprints.

**`data/collection-cards.json`** — `{ [scryfallId]: slimCard }`. `slimCard` keeps only
`id, oracle_id, name, layout, mana_cost, cmc, type_line, oracle_text, power, toughness,
loyalty, colors, color_identity, keywords, produced_mana, legalities.commander, set,
set_name, collector_number, rarity, prices{eur,eur_foil,usd},
image_uris{small,normal,large,png}, card_faces[]` (faces slimmed to `name, mana_cost,
type_line, oracle_text, power, toughness, colors, image_uris`), `scryfall_uri,
edhrec_rank`. One constant, `SLIM_CARD_FIELDS`, in `lib/collection.js`.

**`data/card-profiles.json`** — AI card profiles keyed by `oracle_id`:
```json
{
  "promptVersion": 1,
  "profiles": {
    "<oracle_id>": {
      "summary": "Blinks one of your creatures to re-use its enters-the-battlefield ability or dodge removal.",
      "mechanics": ["flicker", "etb-value", "protection"],
      "synergies": ["creatures with enters-the-battlefield abilities", "tokens"],
      "model": "claude-sonnet-4-6"
    }
  }
}
```
If `promptVersion` changes, all profiles are regenerated. Profiles are not
regenerated when the user switches model (each records the model that wrote it).

**`data/collection-embeddings.json`** — `{ model, dims, vectors: { [oracle_id]: base64(Float32Array) } }`,
embedding each card's *profile text* (see below). Rebuilt if `model` changes;
a card's vector is recomputed when its profile changes.

**`data/models/`** — local embedding model cache.

**`state.json`** gains `deckNotes: { [folderId]: string }` — the per-deck Game plan
(synced across devices like `maybeboard`; see *Game plan*).

## "Owned"

A card is owned if its `oracle_id` appears in the collection (any printing, binder, or
foil). Owned quantity = sum of `qty` over entries whose card has that `oracle_id`.

## Upload modes

The preview offers two modes; the user can switch before confirming.

- **Full collection (sync)** — Spellbook's collection becomes exactly the file: new
  keys added, quantities updated, keys missing from the file removed.
- **New cards (add only)** — for exports of a freshly scanned binder/list. Each row
  whose fingerprint is not in `importedRows` adds its quantity (a new key, or +qty on
  an existing key). Nothing is removed. Rows already imported are skipped and counted
  ("12 cards already imported — skipped").

Row fingerprint = `Scryfall ID|Foil|Binder Name|Added`.

Default mode in the preview: **New cards** if a full sync would remove more than half
of the current collection (by quantity), otherwise **Full collection**. First-ever
upload: Full collection.

## Server modules

`server.js` only wires routes; logic lives in:
- `lib/collection.js` — CSV parsing, aggregation, fingerprints, diffs for both modes,
  slimming, Scryfall batch lookup, file IO.
- `lib/profiles.js` — AI card profiling: prompt, mechanic vocabulary, batching,
  background job, cache.
- `lib/swaps.js` — embedding model lifecycle, embedding cache, candidate filters,
  shortlist scoring, AI ranking, ranking cache.

AI calls reuse the existing provider plumbing (`activeAiConfig`, the Anthropic SDK
client with a JSON-returning tool, and `callOpenAIJson`), following the
`reviewDeckWithAnthropic` / `reviewDeckWithOpenAI` pattern, so the provider and model
chosen in Settings apply. No new settings.

## Server API

### `GET /api/collection`
`{ syncedAt, entries, cards }` (`cards` = slim cards for all entries). Empty →
`{ syncedAt: null, entries: {}, cards: {} }`.

### `POST /api/collection/preview` — body `{ csv }`
Parses the file, computes **both** diffs, stores the parsed result in memory under a
random `previewId` (15-minute expiry), and returns:
```json
{
  "previewId": "…",
  "defaultMode": "sync",
  "sync": {
    "summary": { "added": 14, "changed": 3, "removed": 2, "totalAfter": 2827 },
    "details": { "added": [], "changed": [], "removed": [] },
    "warning": null
  },
  "add": {
    "summary": { "added": 14, "increased": 2, "skipped": 12, "totalAfter": 2843 },
    "details": { "added": [], "increased": [], "skipped": [] }
  }
}
```
- Detail rows: `{ name, set, number, foil, binder, qty }` (+ `qtyBefore`/`qtyAfter`
  where relevant), taken from the CSV, so preview needs no Scryfall calls.
- `sync.warning` is set when the sync would remove more than half of the current
  cards by quantity: "This would remove 2,700 of 2,786 cards — is this a whole-collection export?"

### `POST /api/collection/apply` — body `{ previewId, mode }`
1. Unknown/expired `previewId` → 410 "Preview expired — upload the file again."
2. Look up Scryfall IDs not already cached via
   `POST https://api.scryfall.com/cards/collection` (75 identifiers per request,
   ~100 ms apart).
3. Any Scryfall request fails → 502 "Couldn't reach Scryfall. Try again." **Nothing is
   written.**
4. IDs Scryfall reports `not_found` stay in `entries` but are returned as `unmatched`
   ("N cards couldn't be matched on Scryfall") and don't appear in the grid.
5. Write `collection.json` and `collection-cards.json`; drop cards no longer referenced.
6. Start the background **prepare job** (profiles, then embeddings) for new
   `oracle_id`s. Does not block the response.
7. Return the `GET /api/collection` payload plus `unmatched`.

### `GET /api/swaps/status`
```json
{ "phase": "idle|awaiting-confirmation|profiling|embedding|ready|error",
  "profiled": 640, "embedded": 0, "total": 1925,
  "pending": 1925, "estimate": { "usd": 2.10, "model": "claude-sonnet-5" },
  "aiAvailable": true, "spend": { "monthUsd": 0.42 }, "error": null }
```
`aiAvailable` is false when the active provider has no API key. `pending` and
`estimate` describe the cards still needing profiles (`estimate` is `null` when the
model has no known price).

### `POST /api/swaps/prepare`
Starts (or resumes) the prepare job. This is the **Start** button's action when
`awaiting-confirmation`, and the **Retry** action after an error. Embedding-only work
(no AI) never needs confirmation.

### `POST /api/swaps` — body `{ card, deck }`
- `card`: the original card (slim fields; may not be in the collection).
- `deck` (optional; absent when opened outside a deck):
  `{ id, name, commander, colorIdentity, gamePlan, identityTags, cardNames, signature }`
  — `cardNames` are the main-deck card names (used for context and exclusion),
  `identityTags` the deck-identity tags from the deck's cached AI review when one
  exists (`[]` otherwise), `signature` the existing deck-version string from `deckSig`
  (hashed server-side for cache keys).
- If the prepare job hasn't finished → `202 { status }`; the client polls
  `/api/swaps/status`.
- Otherwise → `200 { results, mode, cached }`:
  ```json
  { "results": [{ "oracle_id": "…", "scryfallIds": ["…"], "match": 82,
                  "reason": "Also flickers, and re-triggers Hei Bai and your Shrines' ETBs." }],
    "mode": "ai" | "local", "cached": true }
  ```
  Empty `results` → the client shows "No match found in your collection."

## Card profiles (`lib/profiles.js`)

- One AI request per batch of 25 cards. Input per card: name, mana cost, type line,
  oracle text (all faces), power/toughness. The prompt asks, per card:
  - `summary` — 1–2 sentences: what the card does and why a Commander deck plays it.
  - `mechanics` — 1–5 tags from the fixed vocabulary `MECHANICS` (e.g. `flicker`,
    `etb-value`, `ramp`, `mana-fixing`, `card-draw`, `card-selection`, `tutor`,
    `spot-removal`, `board-wipe`, `counterspell`, `protection`, `recursion`,
    `reanimation`, `self-mill`, `tokens`, `plus-one-counters`, `sacrifice-outlet`,
    `death-trigger`, `lifegain`, `drain`, `evasion`, `combat-trick`, `anthem`,
    `copy`, `theft`, `stax`, `graveyard-hate`, `extra-turn`, `wincon`,
    `enchantment-matters`, `artifact-matters`, `legends-matter`, `tribal`,
    `spellslinger`, `landfall`, `untap`, `cost-reduction`, `fast-mana`,
    `trigger-doubling`, `bounce`, `pillowfort`, `land`, `vanilla`). The full list
    lives in one constant; tags outside it are dropped. The vocabulary is generic —
    no set-, deck-, or commander-specific tags.
  - `synergies` — up to 4 short phrases naming what the card rewards or enables.
- Output via a JSON-returning tool (Anthropic) / JSON mode (OpenAI), validated; a card
  missing from a response is retried once in the next batch, then left unprofiled.
- The job only covers `oracle_id`s without a profile at the current `promptVersion`.
  It **never starts a bulk run on its own**: when more than `PROFILE_AUTO_LIMIT = 50`
  cards need profiles, status becomes `awaiting-confirmation` with a cost estimate,
  and nothing is spent until the user presses **Start** (see *Spend controls*). At or
  below 50 cards (e.g. a pack scan) it runs automatically after apply. Progress is
  written to disk after every batch, so a restart resumes where it stopped.
- No API key → profiling is skipped (`aiAvailable: false`); swaps fall back to local
  mode (below).
- The original card in a View Swaps request is profiled on demand if it has no profile
  (single-card request, then cached).

## Embeddings (`lib/swaps.js`)

- `@huggingface/transformers` with the native `onnxruntime-node` backend; model
  `Xenova/all-MiniLM-L6-v2` quantized (~23 MB), `env.cacheDir = DATA_DIR/models`; mean
  pooling + L2 normalization → 384-dim vectors; similarity = dot product.
- **Profile text** embedded per card: `summary + " Mechanics: " + mechanics + ". Synergies: " + synergies`.
- Cards without a profile (no API key) embed their **cleaned rules text** instead:
  oracle text (faces joined), parenthesized reminder text removed, the card's name /
  face names / legendary short name ("Mica") replaced with `CARDNAME`, whitespace
  collapsed, type line if empty.
- Measured in a throwaway spike (23 cards, query Cloudshift): raw rules text put 8
  flicker cards on top but ranked Brago and Charming Prince below exile removal —
  the motivation for embedding profiles instead.

## Candidate filters

A collection card is a candidate only if all hold:
- `color_identity` ⊆ allowed identity (deck commander's identity; outside a deck, the
  original card's own identity).
- `oracle_id` ≠ original's `oracle_id`.
- Name not in `deck.cardNames`.
- `legalities.commander === "legal"`.
- Land-ness matches (lands for lands, nonlands for nonlands).
- Not a basic land.

## Ranking

**Shortlist (local, instant):** score each candidate
```
shortlist = 0.60·text + 0.25·mechanics + 0.10·type + 0.05·mv
```
- `text` — embedding similarity.
- `mechanics` — Jaccard overlap of profile `mechanics` (0 if either side has no
  profile; weight then moves onto `text`).
- `type` — primary types (Creature, Instant, Sorcery, Artifact, Enchantment,
  Planeswalker, Battle, Land): 1 identical, 0.5 overlapping or Instant↔Sorcery, else 0.
- `mv` — `max(0, 1 − |Δcmc| / 4)`.
Take the top `SWAP_SHORTLIST = 15`.

**AI ranking (`mode: "ai"`):** one request with:
- the original card (full text + profile),
- the deck: name, commander (+ its text), Game plan (if set), identity tags, and the
  main-deck card names,
- the 15 shortlisted cards (full text + profile).

Prompt layout for cost: the stable part (instructions, then the deck context — Game
plan, commander, decklist) comes first and is marked for prompt caching
(`cache_control`, Anthropic); the per-request part (original card + shortlist)
comes last. Checking several cards from the same deck in one sitting then re-reads
the deck context from cache instead of paying for it again. The Game plan is sent as
pasted; the prompt notes it may contain website boilerplate to ignore.

The prompt asks the model to judge each candidate as a replacement *in this deck*:
does it do the same job, and does it work with the commander and game plan? It
returns, per candidate: `match` (0–100), `reason` (one sentence, ≤ 140 chars), and
`fits` (boolean — would a thoughtful player make this swap?). Results with
`fits && match ≥ SWAP_MIN_MATCH (40)` are shown, best first, at most
`SWAP_MAX_RESULTS = 8`.

**Local fallback (`mode: "local"`):** when no API key is set or the AI request fails,
show the shortlist with `match = round(shortlist·100)`, the same threshold and cap,
no reasons, and a note: "Deck-aware matching is off — add an API key in Settings."
(on failure: "AI ranking failed — showing text-based matches. Retry").

**Cache:** AI results are cached in memory and in `data/swap-rankings.json`, keyed by
`original oracle_id + deck.signature + hash(gamePlan) + collection syncedAt + model`.
Reopening the same card in the same deck version is free; editing the deck, its Game
plan, or syncing the collection produces a fresh ranking.

## UI

### Collection tab
- New tab `data-tab="collection"` beside Search and Decks (top tabs and side rail);
  `setActiveTab` gains a third branch showing `#collection-section`.
- Header: unique cards · total copies · total value (€, `prices.eur`, falling back to
  `eur_foil` for foils) · "Synced <date>" · swap-readiness line from
  `/api/swaps/status` ("Profile 1,925 cards for swaps (≈ $2.10 on claude-sonnet-5)"
  with a **Start** button, "Profiling cards for swaps… 640 / 1,925", "Ready for
  swaps", or "Add an API key in Settings for deck-aware swaps") · "AI spend this
  month: $0.42".
- Controls: name search, mana-symbol color picker (same component as Search, **fits
  within**: `color_identity ⊆ selected`), binder dropdown ("All binders" + trimmed
  names), sort by name / price / mana value, **Upload** button.
- Grid: the Decks grid's card tiles (including the bookmark), rendered 60 at a time
  with "Show more"; images `loading="lazy"`; "×N" when N > 1. Selecting a tile opens
  the Focus panel, which shows "Owned ×N".
- Empty state: how to export from ManaBox (Collection tab → top-right menu → export
  as CSV; or a single binder/list for new scans) and an Upload button.
- Upload flow: file picker (`.csv`) → `preview` → modal with a mode toggle
  (**Full collection** / **New cards**, preselected per *Upload modes*), that mode's
  summary line and expandable lists, and the warning if present → **Confirm**
  (`apply`; spinner "Looking up N new cards on Scryfall…") or **Cancel**. Errors show
  in the modal; nothing is saved on error.
- Filter state is session-only.

### Focus panel
- New button `#detail-swaps-btn` **"View Swaps"** beside Combos/EDHREC. Visible when
  the collection has at least one entry and the card is not a basic land.
- "Owned ×N" detail row when the card is owned.

### Swaps view
- Own container `#swaps-view`, opened from any tab. On open it snapshots
  `{ tab, activeFolder, scrollY }`; **← Back** restores exactly that.
- Header "Swaps for <card>"; original card image + rules-text panel + price; if a deck
  is active, "In <deck name>" with a hint to add a Game plan when none is set.
- Summary line: "N cards from your collection can replace <card>."
- Result tiles: image, name, similarity bar with %, the AI reason (ai mode),
  "Owned ×N", price, "saves €X" (only when the original costs more), Scryfall and
  EDHREC links, and the standard **bookmark** (opens the existing deck picker).
  Selecting a tile opens it in the Focus panel.
- States:
  - Preparing → "Preparing your collection for swaps… 640 / 1,925", polling
    `/api/swaps/status` every 2 s, then re-requesting.
  - Ranking → "Matching against <deck name>'s game plan…" while the AI request runs.
  - No results → **"No match found in your collection."**
  - Local-mode note / AI-failure note as above; hard error → message + **Retry**.

### Decks tab
- **Game plan**: a "Game plan" button in the deck header (real decks only) opens a
  modal with a textarea — "Paste the deck's primer or describe how it wins" —
  20,000-character limit with a live counter (no silent truncation; a full Moxfield
  primer pasted with page text is ~13,000 characters). Stored in
  `state.deckNotes[folderId]`, synced like `maybeboard`: localStorage key
  `deck_notes`, op `{ type: "setDeckNotes", deckNotes }`, `DEFAULT_APP_STATE`,
  `normalizeAppState`, a `mergeDeckNotes` in `mergeStates` (per-folder; newer local
  value wins), and the `applyOps` case.
- **Owned badges**: an "Owned" chip on each tile whose `oracle_id` is owned (main
  deck and Maybeboard). **"Own X of Y"** in the deck header, counting distinct
  non-basic-land main-deck cards. Both hidden without a collection.
- **Color filter**: the mana-symbol picker plus a **Colorless** toggle beside the
  type chips. **Contains**: a card shows if its `color_identity` includes any
  selected color; Colorless matches empty identity. Behaves like the existing
  type-chip filter — deck analysis and the "Own X of Y" count still use the whole
  deck, but Export copies the visible cards, as it already does for the text and
  type filters; header shows "Showing 23 of 94" while active. Session-only.

## Cost (uses the Settings provider/model)

Rough estimates (Anthropic list prices, $ per MTok input / output):

| Model | Price | Profile ~1,900 cards (once) | One ranking (then cached) |
|---|---|---|---|
| Sonnet 4.6 (previous setting) | 3 / 15 | ≈ $3 | ≈ $0.02–0.03 |
| **Sonnet 5 (chosen)** | 2 / 10 | ≈ $2 | ≈ $0.01–0.02 |
| Opus 5 | 5 / 25 | ≈ $5 | ≈ $0.04–0.05 |
| Haiku 4.5 | 1 / 5 | ≈ $1 | ≈ $0.01 |

Model: **Claude Sonnet 5** (`claude-sonnet-5`), chosen by the user on 2026-09-27 and
set as the Anthropic default (`DEFAULT_ANTHROPIC_MODEL`) and in Settings. Real token
usage is measured in the pilot and recorded in the README.

## Spend controls

The user must not pay for AI work they didn't ask for or that isn't good enough.

- **No surprise bulk runs.** Profiling more than 50 cards waits for an explicit
  **Start**, shown in the Collection tab as "Profile 1,925 cards for swaps
  (≈ $2.10 on claude-sonnet-5)". The estimate = cards pending × measured average
  tokens per card (constants set from the pilot) × the model's price.
- **Rankings only on demand.** An AI ranking happens only when the user opens View
  Swaps, and is cached (see *Ranking*); nothing ranks in the background.
- **Every AI result is cached** — profiles by `oracle_id` (kept across syncs and model
  switches), rankings by deck version / game plan / collection / model.
- **Bounded retries.** A failed batch is retried once, then its cards are left
  unprofiled and reported; no retry loops.
- **Spend tracking.** `lib/ai-usage.js` records each profiling/ranking call's
  `{ at, feature, provider, model, inputTokens, outputTokens, usd }` to
  `data/ai-usage.json`, pricing tokens with an `AI_PRICES` table (Claude Sonnet 5,
  Sonnet 4.6, Opus 5, Haiku 4.5; unknown models record tokens only). The Collection
  tab shows "AI spend this month: $0.42".
- **Tests never call a real AI** — the provider is injected and faked.
- Not used: the Message Batches API (50% cheaper, but it would save ~$1 once while
  adding a second code path and hours-long delays).

## Rollout: pilot before the full run

Before any bulk profiling of the real collection:
1. Profile a sample of ~60 collection cards with **Sonnet 5**, chosen to cover
   several archetypes: flicker, exile removal, Shrines/Spirits, landfall, zombies /
   aristocrats, lifegain, and plain goodstuff.
2. Rank swaps (shortlists drawn from those ~60 profiled cards) for:
   - 3–4 cards of the Hei Bai deck **with** its Game plan (primer saved locally at
     `data/pilot/hei-bai-primer.md`, git-ignored — third-party text is not committed);
   - 1–2 cards each from three unrelated test decks in `fixtures/moxfield-snapshots/`
     **without** a Game plan: Kynaios and Tiro (landfall), Mikaeus (mono-black
     zombies), Giada (angel lifegain).
   This checks the ranking generalizes beyond one deck and works with no Game plan.
3. Show the user the profiles, rankings, reasons, and measured cost.
4. Go/no-go: only if the user is satisfied is the full collection profiled. If not,
   the prompt is adjusted (bumping `promptVersion`) or another model is tried on the
   same ~30 cards — never on the full collection first. Measured tokens per card
   become the estimate constants.
Expected pilot cost: under $1.

## Docker

- Base image `node:22-alpine` → **`node:22-slim`** (glibc for `onnxruntime-node`).
  Same `DATA_DIR`, port, volume, and `compose.yaml`.
- `mkdir -p /app/data/models` owned by `node`.
- Measure image size before/after and first-run profiling + embedding time on the real
  collection; record in the README.

## Testing

Plain Node scripts matching `scripts/check-*.mjs`; AI and the embedding model are
injected so tests run offline and free.

- `npm run test:collection` (`scripts/check-collection.mjs`, fixtures in
  `fixtures/collection/`):
  - CSV parsing: quoted fields, commas in names, BOM, CRLF, missing required columns,
    exports without binder columns.
  - Aggregation of rows sharing a key; fingerprints.
  - Sync diff: added / changed / removed, first upload, >50% warning, `added` kept.
  - Add-only diff: new keys, +qty on existing keys, already-imported rows skipped,
    re-applying the same file is a no-op.
  - Default-mode choice; slimming keeps exactly `SLIM_CARD_FIELDS`.
- `npm run test:swaps` (`scripts/check-swaps.mjs`):
  - Profile validation: vocabulary filtering, missing-card retry, `promptVersion`
    invalidation (fake AI).
  - Profile-text and cleaned-rules-text builders.
  - Candidate filters.
  - Shortlist scoring, weight redistribution, top-15 cut (fake vectors).
  - AI ranking: prompt contains deck plan / tags / names; response validation;
    `fits` + threshold + cap; local fallback on missing key and on AI error; cache
    key changes with deck signature, game plan, sync, and model (fake AI).
- `npm run test:swaps:model` (slow, real local model, no AI): profile-text sanity,
  e.g. a flicker profile ranks flicker profiles above exile-removal profiles.
- `npm run test:deck-analysis` still passes.
- One manual end-to-end run on the Hei Bai deck with the real collection and API key;
  the user checks the UI (no browser automation).

## README

Add a "Collection & Swaps" section: exporting from ManaBox (whole collection and
single binder), the two upload modes, profiling and its cost, the Game plan field,
first-run model download, and the measured image size / timings / token usage.
