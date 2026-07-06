# Handoff

Notes for the next agent picking up work on Spellbook (Scryfall natural-language
search + saved-card manager, Node/Express in `server.js`, single-page UI in
`public/index.html`, deployed as a Docker container on Unraid).

## Commander combos — IMPLEMENTED (2026-07-06)

Shipped. Focus a **legendary creature** → a **Combos** button appears in the Focus
panel; tapping it loads the top 5 combos (by popularity) into the main view as
"combo panels" (Option 1): the piece cards in a row (each clickable → Focus panel,
enriched to full Scryfall cards for real art + detail), a "Produces" chip summary
with "+N more", deck count, and a "View on Spellbook" link. A context header with
"Back to search" restores the prior results. Loading / empty / error states handled.

- Spec: `docs/superpowers/specs/2026-07-06-commander-combos-panel-design.md`
- Server: `GET /api/combos?commander=<name>` in `server.js` (trims to
  `{id,url,popularity,cards,produces}`, 24h in-memory cache).
- Client: `loadCombos` / `enrichComboCards` / `buildComboPanel` in `public/index.html`.
- **Gotcha:** Scryfall's `cards/collection` endpoint returns **400 without a
  `User-Agent`**. Browsers send one automatically (so the client is fine); if you
  ever move enrichment server-side, set a `User-Agent` header.

Possible follow-ups (out of scope for v1): save a whole combo as a unit; a `card:`
mode for combos where it isn't the commander; partner/background commanders.

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

- **Recent work (committed `a4e7b8d` on `main`):**
  1. Cross-device state sync — server (`state.json`) is now authoritative; clients
     send precise ops (`/api/app-state/ops`) instead of overwriting; re-sync on
     focus/visibility/online + 15s poll. See `applyOps` in `server.js` and the
     "Authoritative sync engine" block in `public/index.html`.
  2. Export button on the saved tab — copies the on-screen cards as a `1 Card Name`
     list (front-face name for DFCs) for Cardmarket / Moxfield import.
- **Deploying to Unraid requires a Docker image rebuild** (`docker compose up -d --build`);
  `server.js` and `public/` are `COPY`'d into the image. The `data/` volume
  (`/mnt/user/appdata/spellbook/data`) holds the real `state.json` and is never
  committed.
- **Verification note:** the user checks the UI themselves — do not use browser
  automation to verify. Verify logic via HTTP/curl and JS parse checks instead.
- Local dev: `node server.js` → http://localhost:3000 (static `public/` served
  fresh per request, so UI edits don't need a restart).
