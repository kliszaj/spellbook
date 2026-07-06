# Commander Combos Panel — Design

Date: 2026-07-06
Status: Approved (pending spec review)

## Goal

When a user focuses a **legendary creature** (a valid commander), let them pull up
the most popular combos for that commander and browse them in the main view, with
each combo shown as a panel of its cards plus the effect it produces. Every card in
a combo is clickable to open it in the existing Focus panel to learn more.

Data comes from the public [Commander Spellbook API](https://backend.commanderspellbook.com/)
(no auth). See `HANDOFF.md` for the raw API notes.

## User flow

1. User focuses a card. If it is a Legendary Creature, a **"Combos"** button appears
   in the Focus panel's action row (alongside Save / Cardmarket / Scryfall).
2. User taps **Combos**. The main view switches to the search area and shows a
   context header (*"Combos for <name> · most played"*) plus up to **5 combo panels**.
3. User can click any card in any combo panel to open that card in the Focus panel
   (full detail: image, price, oracle, mana, set, P/T) — exactly like any other card.
4. User taps **Back to search** in the context header to restore their previous
   search results.

## Trigger: the Combos button

- Shown only when `state.detailCard.type_line` matches **both** `Legendary` and
  `Creature` (case-insensitive). Helper: `isLegendaryCreature(card)`.
- Uses the **front-face name** for double-faced commanders (split on `" // "`,
  take `[0]`) — same rule as the export feature.
- Hidden for all other cards (re-evaluated on every `showDetail`).

## Server: combos proxy

New route in `server.js`:

```
GET /api/combos?commander=<name>
```

- Proxies `GET https://backend.commanderspellbook.com/variants/?q=commander:"<name>" order:popularity&limit=5`
  (URL-encoded). `order:popularity` returns most-played first.
- **Server-side in-memory cache**, keyed by the normalized (lowercased, trimmed)
  commander name, TTL ~24h. Combo data changes slowly and this keeps us polite to
  their backend. (In-memory is sufficient; no need to persist to `state.json`.)
- Returns a **trimmed** payload — only the fields the client needs — to keep the
  response small:
  ```jsonc
  {
    "commander": "Krenko, Mob Boss",
    "combos": [
      {
        "id": "<variant id>",
        "url": "https://commanderspellbook.com/combo/<id>/",
        "popularity": 33422,
        "cards": [ { "name": "Skirk Prospector", "oracleId": "<uuid>" }, ... ],
        "produces": [ "Infinite red mana", "Infinite creature tokens with haste", ... ]
      }
    ]
  }
  ```
- Error handling: on upstream failure or non-200, respond `502` with
  `{ error: "Couldn't reach Commander Spellbook" }`. On zero results, respond `200`
  with `{ combos: [] }`.

## Client: rendering combos

### Card enrichment (makes pieces clickable + gives real art)

The Spellbook payload only carries names/oracle ids, not the full card data the
Focus panel needs. So on load:

1. Collect the unique cards across all returned combos (by `oracleId`, with `name`
   fallback).
2. Batch-fetch full card objects from Scryfall's collection endpoint — the app
   already uses `https://api.scryfall.com/cards/collection` (POST
   `{ identifiers: [{ oracle_id }, ...] }`, ≤75 per request; a handful of combos is
   well under that, so one request).
3. Build a `Map` from oracle id → full Scryfall card. Combo pieces render from and
   click through to these real card objects via the existing `showDetail(card)`.
4. **Fallback:** if Scryfall can't resolve a piece, render it name-only; clicking it
   runs a normal name search for that card. Never block the whole panel on one
   missing piece.

### Layout (Option 1 — combo panel)

Each combo is one wide panel:
- A row of the piece cards (real Scryfall images), each an interactive button →
  `showDetail(card)`.
- A **Produces** summary: ~3 effect chips + a "+N more" that expands the full list
  inline.
- Deck-count (`popularity`) and a **View on Spellbook** link (`combo.url`, opens in
  a new tab).

Rendered into the existing results container (`#results`), replacing search results.
A context header (reusing the `#ai-summary` banner pattern) shows
*"Combos for <name> · most played"* with a **Back to search** control that re-renders
the prior search results (`renderResults(state.results)` / recommend order).

### State

- `state.mode` gains a `"combos"` value (currently `"search"` / recommendations).
- `state.comboContext = { commander, combos }` holds the active combo view so the
  back action and re-renders work.
- Switching tabs or running a new search clears combo mode.

### States shown to the user

- **Loading:** a placeholder in the results area while the proxy + Scryfall calls run.
- **Empty:** *"No combos found for <name>."*
- **Error:** *"Couldn't load combos — <reason>."*

## Ordering & count

- **Top 5** combos, sorted by popularity (server enforces `limit=5` +
  `order:popularity`). No pagination / "Load more" in v1.

## Out of scope (v1)

- Saving a whole combo as a unit (user can still save individual pieces via Focus).
- `card:"<name>"` mode (combos where the card is not the commander).
- Partner / Background / companion commander nuances.
- Showing combos for non-legendary or non-creature cards.

## Edge cases

- **DFC commanders:** front-face name for the query.
- **Unresolved pieces:** name-only render + search-on-click fallback.
- **Upstream down / rate limited:** cached results serve if present; otherwise the
  error state. Cache never stores error responses.
- **Long produces lists** (Krenko's combos each list ~8 effects): summarized to 3 +
  expandable, so panels stay compact.

## Verification approach

- Server: `curl` the `/api/combos` route for a known commander (Krenko) and assert
  the trimmed shape, the 5-combo cap, empty-result handling, and the error path.
- Client: JS parse check; the user verifies the UI themselves (no browser
  automation, per project convention).

## Deployment note

Ships in `server.js` + `public/index.html`, so it reaches Unraid only after a Docker
image rebuild (`docker compose up -d --build`).
