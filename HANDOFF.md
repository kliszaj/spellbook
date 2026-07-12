# Handoff

Notes for the next agent picking up work on Spellbook (Scryfall natural-language
search + saved-card manager, Node/Express in `server.js`, single-page UI in
`public/index.html`, deployed as a Docker container on Unraid).

---

## ⚠ WORK IN PROGRESS (2026-07-12) — read this first

Two chunks of work happened this session. **Neither is committed yet.** Nothing on
`main` has moved; all changes are in the working tree.

### 1. Basic-land quantities — CODE COMPLETE, uncommitted, not yet UI-verified

Lets a basic land in a deck carry a per-deck count (e.g. `Forest ×14`) instead of
storing 14 separate cards. Chosen behaviour (user-approved): **quantity counts
everywhere** (deck size, land count, price, export) and **import reads the leading
number** for basics.

- **Data model:** new `state.quantities` = `{ [folderId]: { [cardId]: count } }`.
  Only basic lands ever hold count > 1; `cardQty()` returns 1 for everything else,
  so qty-weighted math is a no-op elsewhere. Per-deck (not global) so the same
  Forest can be 14 in one deck, 6 in another.
- **Client (`public/index.html`):** `cardQty` / `setCardQty` / `persistQuantities` /
  `isBasicLand` (helpers near the folder helpers ~L3620); an editable **`×N` badge**
  (`.count-badge`, top-right of basic-land cards in a real deck) → `startQtyEdit`
  swaps in an inline `<input>` (Enter/blur commit, Esc cancel). `computeDeckStats`
  and `folderCount` are qty-weighted; `parseImportList` now returns `[{name,qty}]`
  and `runImport` applies qty to basics; export `cardmarketLine` emits real counts.
  Sync plumbing added everywhere `membership` appears (payload, applyAppState,
  mergeQuantities, both sync-signature arrays, hasUsefulAppState).
- **Server (`server.js`):** `quantities` in `DEFAULT_APP_STATE` + `normalizeAppState`,
  `mergeQuantities`, and a new **`setQuantities` op** in `applyOps` (replace-whole-map,
  like `replaceMembership`).
- **Verified:** `node --check` on both files; a `setQuantities` op round-trip on a
  temp `DATA_DIR` persisted correctly. **NOT yet checked in the real UI by the user.**
- **Gotcha:** the user's existing decks were imported *before* this, so their basics
  are stored as singletons — they must re-import (or click the badge) to get counts.

### 2. Deck Analysis 2.0 — CODE COMPLETE, uncommitted, not yet UI-verified

Redesign of the deck-analysis panel ("Command Table" direction), in the site's
**existing light palette** (NOT dark mode). Replaces the old `renderDeckAnalysis`
body entirely; old helpers (`statTile`, `typeBarHtml`, `curveReadHtml`,
`colorCheckHtml`) are left defined but unused.

**What shipped (all in `public/index.html` + `server.js`):**
- **Heuristic, free, instant (default):** identity strip (deck name + `MANA_SVG`
  pips + `colorComboName` guild/shard/wedge label + card/land/avg-MV), rule-based
  **grade** (`computeGrade`, letter from % of `AI_TARGETS`/land/MV/source checks),
  **Add** chips (`deckGaps`), heuristic **role radar** (`detectRoles` keyword match →
  reuses `roleRadarHtml`), **color sources vs. need** (`colorSourceStats` — lands'
  `produced_mana` vs. pip demand; target tick + Reliable/Tight/Short), compact curve,
  heuristic **win-cons** (`detectWinCons`), heuristic **verdict** (`heuristicVerdict`).
- **Bracket dial** — `enhanceBracket` (async): `GET /api/game-changers` (Scryfall
  `is:gamechanger`, 53 cards, server-cached 24h; client memoized in `gameChangersPromise`).
  Bracket = ceiling model per official rules: `hits>=4 || MLD → 4`, `hits>=1 → 3`,
  else `2` (brackets 1 & 5 are intent-based; we show the content-derived minimum).
- **Combo count** — `enhanceCombos` (async, memoized in `comboCountCache`): reuses
  `GET /api/combos`, shows "N+ combo lines with <commander>".
- **AI opt-in** — the **AI Review** button (and the "Run AI Review for cut ideas"
  trim CTA) call `reviewDeckWithAI(cards, folderId)` → extended `POST /api/deck-review`
  (now also returns `verdict` + `trim` alongside `counts`/`notes`). `renderAiExtras`
  fills verdict, refines the radar (`counts`), fills **Trim** chips + notes. Result is
  **cached per deck** in `deckReviewCache[folderId]` keyed by `deckSig` (card ids+qty)
  — re-opening a reviewed deck shows it instantly, no re-spend; button becomes "Re-run AI".
- New CSS: the `.da2-*` block (search "Deck Analysis 2.0 (Command Table)").

**Resolved this session (were open questions):** Game Changers via Scryfall
`is:gamechanger` (confirmed 53 cards); bracket via the official ceiling rules
(https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta);
role detection heuristic-by-default, AI refines (user picked "the former").

**Verified:** `node --check` both files; `/api/game-changers` returns 53 names live;
`/api/deck-review` error path graceful. First real-UI render looked good (AI review
produced a strong verdict + real card-name trim suggestions). Reload to view (static served fresh).

**Post-first-render refinements (2026-07-12):**
- DONE — fixed a consistency bug: after AI review the Add chips + grade were stale
  (heuristic) while the radar showed AI counts. `renderAiExtras` now recomputes grade
  (`#da2-grade`) and Add chips (`#da2-add-row`) from AI counts via the stored `daCtx`
  ({folderId, sources, stats}); win-con count shows `0` not `—`.
- DONE (this batch, per user) — all in `roleRadarHtml` / `.da2-*` CSS / `colorSourceStats`:
  1. **Radar caps over-target spikes.** Target is now a uniform ring (`RT = 0.62`); deck
     radius via `valR()` — meeting the minimum lands on the ring, over-target is compressed
     so a role clearing a low bar (graveyard hate 3 vs 1) no longer dominates. Under-target
     dots are terracotta so gaps read at a glance.
  2. **Values moved onto the chart.** Removed the bottom role-list; each axis label prints
     `v / target` under it (`.rad-lbl-v`). Legend kept. (`.rad-list`/`.radar-side` CSS now unused.)
  3. **Radar widened / sources narrowed.** `.da2-cols` is now `1fr 290px` (radar wide left,
     color-sources narrow right); `.da2-radar-card .radar-fig` capped at 440px, centered.
  4. **Floored color-source "need" to 4** for any played color (`colorSourceStats`) so a light
     splash no longer shows "need 1".
- OPEN QUESTION for the user: whether to also drop the bottom **AI-notes bullet list**
  (`#da2-notes`, filled by `renderAiExtras`). Kept for now — it overlaps with the verdict +
  Add/Trim chips, but is useful; user may want it gone to match the prototype's cleaner tail.
- POSSIBLE follow-up: `detectRoles` regexes are approximate — tune against AI counts on real
  decks (interaction/removal are the fuzziest).

**Superseded prototype (for reference):** `…/scratchpad/deck-analysis-command.html`.
Original 3-prototype exploration: `deck-analysis-2.html`, `deck-analysis-directions.html`.

Original approved prototype layout, top → bottom:

1. **Identity strip** (top row, above everything): deck name + **mana-symbol pips**
   for the color identity + color-combo name (Jund/Azorius/etc.) + `N cards · N lands
   · avg MV` + a **bracket dial** (1–5, gold) on the right. Hairline divider under it.
2. **Scorecard**: a letter **grade** badge + one-line verdict + two chip rows —
   **Add** (sage chips, gap fills) and **Trim** (terracotta chips, what to cut).
3. **Two cards:** left = **role-coverage radar** (deck polygon in gold vs. dashed
   sage target ring — reuse existing `roleRadarHtml` idea); right = **color sources
   vs. need** (pip + bar + target tick + Reliable/Tight/Short) and a compact curve.
4. **Win-conditions block**: count + named finishers as tags + "+N combo lines".

**Architecture (user-approved "former" option) — heuristics by default, AI opt-in:**

- **Free / heuristic / instant / no tokens (default view):**
  - deck size, lands, avg MV, curve — pure computation (already in `computeDeckStats`).
  - **color sources vs. need** — count sources per color from Scryfall **`produced_mana`**
    on each card; pips-needed from mana costs. Exact, free.
  - **bracket / Game Changers** — Game Changers is a *fixed published list*; matching
    is a lookup (will need the list embedded — TODO, see below).
  - **combos** — already available from Commander Spellbook data (see combos section).
  - **role counts** (ramp/draw/removal/wipes/interaction/tutors/grave-hate/protection)
    via **oracle-text keyword heuristics** — rough but decent, good enough for default.
  - **grade** — a **rule-based composite** (transparent, deterministic, free). Weighted
    checklist: lands 36–38, ramp ≥10, draw ≥10, removal ≥8, wipes ≥3, interaction ≥8,
    each color sources ≥ need, avg MV in band → % passed → letter (A/B+/B/C…). Make it
    hoverable ("−½ grade: 3 short on card draw, red under-sourced"). The AI does NOT
    set the letter.
  - **Add** chips — fall straight out of the quota/source shortfalls. Free.
- **AI, behind an "AI Review" button (with a loading/spinner state), cached per deck:**
  - prose verdict, **Trim** suggestions (what to cut is a judgment call), and a
    *refined* pass over the fuzzy role counts.
  - **Cache the result keyed to the deck's contents** (hash of card ids + qty) so it
    only spends tokens the first time; re-opening shows cached; offer re-run only when
    the deck changed. The app already has an AI endpoint to extend: `POST /api/deck-review`
    (returns `{counts, notes}`) — reuse/extend it rather than adding a new one.

**Still-open details to resolve while building (ASK the user if unsure):**
- **Game Changers list** — need the current official card list embedded somewhere
  (client const or server). Confirm source with user; the prototype's "2" is fake.
- **Color-combo names** — need the guild/shard/wedge/4-5c name map (WU=Azorius,
  BRG=Jund, …). Straightforward table.
- **Bracket estimation heuristic** — how to turn Game-Changers count (+ tutors, fast
  mana, combos) into a 1–5 bracket. Confirm the rubric with the user.
- **Trim** — least data-certain part; it's AI-assisted. User accepted that.
- Mana pips: use the app's existing **`MANA_SVG`** symbols (used in `colorCheckHtml`),
  not the lettered circles from the prototype.

**Code to touch:** `renderDeckAnalysis` + `computeDeckStats` + the `.da-*` CSS block
(`public/index.html`); reuse `roleRadarHtml`, `MANA_SVG`, `isLandCard`. Extend
`POST /api/deck-review` in `server.js` for verdict/trim. The user is fine with being
asked questions mid-build.

---

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
