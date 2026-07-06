# Handoff

Notes for the next agent picking up work on Spellbook (Scryfall natural-language
search + saved-card manager, Node/Express in `server.js`, single-page UI in
`public/index.html`, deployed as a Docker container on Unraid).

## Next task under consideration: Commander combos

The user wants to surface **common combos for a specific commander** and is still
thinking about how to present it in the app. Nothing has been built yet — this is
research only.

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

### Recommended integration approach (not yet decided by user)
- Call it **server-side** in `server.js` (avoids browser CORS issues), add a route
  like `GET /api/combos?commander=...` that proxies `variants/?q=commander:"..."`.
- **Cache** responses on the server (mirror the existing translate-cache pattern) to
  be polite to their backend; combo data changes slowly.
- Natural UI trigger: the app already tracks a Commander **color identity**; a
  "Combos for this commander" panel could fetch when a commander is set. Exact
  placement/UX is the open question the user is mulling.

### Open questions for the user
- Where does this live in the UI (saved tab? a new tab? the detail/focus panel)?
- Keyed off what — a chosen commander card, or the color-identity filter?
- How many combos to show, and sorted by popularity by default?

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
