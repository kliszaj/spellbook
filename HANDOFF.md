# Handoff

Notes for the next agent picking up work on Spellbook (Scryfall natural-language
search + saved-card manager, Node/Express in `server.js`, single-page UI in
`public/index.html`, deployed as a Docker container on Unraid).

## Commander combos — IMPLEMENTED (2026-07-06, refined 2026-07-07)

Shipped. A **Combos** button in the Focus panel (shown for almost any card — see
`cardShowsCombos`, excludes basic lands/tokens) loads the top 5 combos into the
main view as horizontal "combo panels": a **fanned stack** of the piece cards on
the left (300px, click any to slide it front + open in Focus), and to the right
the card names, a "Produces" chip summary, deck count, per-combo **Steps** + Notes,
and a "View on Spellbook" link. A "Load more combos" button paginates. A context
header with "Back to search" restores the prior results (and scroll position).

- Spec: `docs/superpowers/specs/2026-07-06-commander-combos-panel-design.md` (design-time; a few details below have since changed).
- Server: `GET /api/combos?commander=<name>&offset=<n>` in `server.js` — trims to
  `{id,url,popularity,cards,produces,steps,notes,hasMore}`, 24h in-memory cache,
  doesn't cache empty answers.
- Client: `loadCombos` / `fetchCombosPage` / `enrichComboCards` / `buildComboPanel` /
  `loadMoreCombos` in `public/index.html`.
- **Query gotcha:** use `card:"<name>"`, NOT `commander:"<name>"`. The latter only
  matches combos that *require* the card in the command zone — empty for most
  commanders. `card:` returns every combo the card appears in.
- **Scryfall gotcha:** `cards/collection` returns **400 without a `User-Agent`**.
  Browsers send one automatically (client is fine); if enrichment ever moves
  server-side, set a `User-Agent` header.

## Decks, commanders & deck analysis — IMPLEMENTED (2026-07-07)

Committed `655cb7e`. The old "Folders" are now **Decks** (UI rename only; internal
identifiers `state.folders` / `membership` / `card_folders` / `setFolders` op are
unchanged — no migration). The "Saved" tab is now "Decks" with no count.

- **Commander per deck:** a crown button (only on **legendary creatures**, see
  `isLegendaryCreature`) sets a deck's commander → `commanderId` on the deck object,
  pinned first with a badge. Persists via the existing `setFolders` op — no server
  change. Set via `setDeckCommander`.
- **Deck analysis** (`renderDeckAnalysis`, shown only for real decks — hidden for
  `all` and `DEFAULT_FOLDER`): summary tiles with target/status (cards vs 100,
  lands vs 36-38, avg MV vs 3-3.5, price), mana-curve chart + light midrange
  "read" (`curveReadHtml`), card-type breakdown, and a color-identity check vs the
  commander's `color_identity`. Reliable metrics only — computed from Scryfall data.
- **AI Review:** `POST /api/deck-review` (reuses the Anthropic client + api-key
  resolution from `/api/translate`, model `claude-sonnet-4-6`). Sends the deck's
  cards, returns `{counts, notes}` classifying ramp/draw/removal/wipes/tutors/
  interaction/graveyardHate/protection vs Commander targets (from `tome`'s
  `heuristics.py`). Rendered as a **deck-shape radar** (`roleRadarHtml`) — deck
  polygon vs a dashed target ring — plus notes.
- **EDHREC button** in the Focus panel → `edhrec.com/cards/<slug>` (`edhrecSlug`,
  front-face name). Plain external link — deliberately avoids EDHREC's unofficial API.
- **Import button** (next to Export in a deck) → modal; `parseImportList` handles
  quantities / set codes / comments / DFCs, resolves via Scryfall, adds to the deck.

Possible follow-ups: partner/background commanders; save a whole combo as a unit;
a per-card EDHREC/synergy data layer (would need the unofficial `json.edhrec.com`).

### Data source: Commander Spellbook API

Public, open-source REST API. **No auth / no API key required.** This is the same
data behind https://commanderspellbook.com/.

- **Endpoint:** `GET https://backend.commanderspellbook.com/variants/?q=<search>`
- **Query syntax** (`q`) is identical to the website's search box:
  - `commander:"Krenko, Mob Boss"` — combos where that card must be the commander (command zone)
  - `card:"Name"` — combos that merely include a card anywhere
  - Filters compose: `identity:R`, `format:commander`, `results:"infinite mana"`
  - Sorting: the query supports `order:popularity` / `sort:popularity` to rank most-played first
- **Verified live** (2026-07): `?q=commander:"Krenko, Mob Boss"` returns JSON.

### Response shape (fields we care about)

```jsonc
{
  "count": <n>, "next": <url>, "previous": <url>,
  "results": [
    {
      "uses":     [ { "card": { "name", "oracleId", "typeLine", "imageUris" }, ... } ], // cards in the combo
      "produces": [ { "feature": { "name": "Infinite red mana" } }, ... ],              // what the combo does
      "identity": "R",                                                                   // color identity
      "popularity": <deckCount>,                                                         // how "common" it is — sort key
      "legalities": { "commander": true, ... }
    }
  ]
}
```

### Docs
- Swagger / OpenAPI: https://backend.commanderspellbook.com/schema/swagger/
- API root (lists all endpoints — `variants`, `cards`, `features`, …): https://backend.commanderspellbook.com/
- Source: https://github.com/SpaceCowMedia/commander-spellbook-backend

## Project context / continuity

- **Recent work on `main` (newest first):**
  - `655cb7e` Decks + commanders + deck analysis + EDHREC + import (see section above).
  - `375ac04` direct card-name search fast path (bare name → exact Scryfall lookup,
    no AI/commander filters, AI fallback); combos `card:` fix; fanned stack.
  - `a4e7b8d` cross-device state sync — `state.json` is authoritative; clients send
    precise ops (`/api/app-state/ops`), re-sync on focus/visibility/online + 15s
    poll (`applyOps` in `server.js`, "Authoritative sync engine" in the client).
    Same commit: export button (Cardmarket/Moxfield `1 Card Name` list).
  - `e811661` raised `express.json` body limit to 25mb (100kb default rejected the
    104kb state snapshot — was spamming `PayloadTooLargeError`).
  - Colour identity is **session-only** (always deselected on load; not persisted).
- **Deploying to Unraid requires a Docker image rebuild** (`docker compose up -d --build`);
  `server.js` and `public/` are `COPY`'d into the image. The `data/` volume
  (`/mnt/user/appdata/spellbook/data`) holds the real `state.json` and is never
  committed.
- **Verification note:** the user checks the UI themselves — do not use browser
  automation to verify. Verify logic via HTTP/curl and JS parse checks instead.
- Local dev: `node server.js` → http://localhost:3000 (static `public/` served
  fresh per request, so UI edits don't need a restart).
