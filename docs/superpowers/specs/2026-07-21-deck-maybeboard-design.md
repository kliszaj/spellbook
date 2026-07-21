# Deck Maybeboard — Design

Date: 2026-07-21
Status: Approved (pending spec review)

## Goal

Let the user mark a card as **Maybe** within a specific deck — it stays a member of
that deck (still shows on the deck's page) but is set aside in its own section at the
end of the grid, and is excluded from everything that measures the deck (size,
analysis, curve, color sources, export). Triggered from the card's right-click
context menu (new) or a toggle button in the Focus panel.

## Data model

New per-deck flag, mirroring the existing `quantities` shape
(`{ [folderId]: { [cardId]: count } }`, used for basic-land counts):

```
state.maybeboard = { [folderId]: { [cardId]: true } }
```

**Client** (`public/index.html`):
- `isMaybe(folderId, cardId)` — reads the flag.
- `setMaybe(folderId, cardId, on)` — sets/deletes it, mirrors `setCardQty`: writes
  `localStorage["card_maybeboard"]` and calls
  `queueOp({ type: "setMaybeboard", maybeboard: state.maybeboard })`.
- Loaded/migrated alongside `state.quantities` on boot.

**Server** (`server.js`), parallel to how `quantities` is already handled:
- Add `maybeboard: {}` to `DEFAULT_APP_STATE`.
- `normalizeAppState`: `maybeboard: plainObject(input.maybeboard) || {}`.
- New `mergeMaybeboard(a, b)` (same union-per-folder logic as `mergeQuantities`) used
  in `mergeStates`.
- New op case in `applyOps`: `setMaybeboard` sets `state.maybeboard = op.maybeboard`
  (mirrors `setQuantities`).

**Scope rules:**
- Maybe only exists within a real deck — gated by the same condition the app already
  uses for analysis/commander: `activeFolder !== "all" && activeFolder !== DEFAULT_FOLDER`.
  The "All" and "Unsorted" library views never show Maybe state or actions.
- The deck's designated commander can never be marked Maybe. The Maybe action is
  hidden for the commander card in both the context menu and the Focus panel.
- Removing a card from a deck's membership (unchecking it in the save popover, or
  fully unsaving the card) also clears any `maybeboard[folderId][cardId]` flag for
  that folder, so flags never orphan onto a membership that no longer exists.

## Right-click context menu (new component)

A new floating menu, visually modeled on the existing `.save-popover` (fixed
position, `.visible` toggle, closes on outside click or Escape — added to the
existing document-level handlers that already close the save popover/import modal).

Right-clicking (`contextmenu`) a `.card-item` in the saved/deck grid prevents the
native browser menu and opens this one at the cursor position, with:

- **Details** — always shown; calls `showDetail(card)`.
- **Set as commander** / **Unset commander** — only for legendary creatures
  (`isLegendaryCreature`) in a real deck; same condition as today's crown button.
- **Mark as Maybe** / **Move to main deck** — only in a real deck, hidden for the
  commander; calls `setMaybe(activeFolder, card.id, !isMaybe(...))`, then
  re-renders.
- **Remove from deck** — only in a real deck; calls
  `setCardFolder(card, activeFolder, false)` (removes just this deck's membership,
  matching what unchecking the deck in the save popover already does).

In the "All"/"Unsorted" views, only **Details** is shown — the rest are deck-scoped
and don't apply there.

## Focus panel

A new toggle button in `.card-actions`, next to Save: **Mark as Maybe** /
**Move to main deck**. Shown only when:
- a real deck is active (`activeFolder` is a real deck), and
- `state.detailCard` is a member of that deck, and
- it isn't the deck's commander.

Hidden otherwise (mirrors how `detailCombosBtn`/`detailEdhrecBtn` are conditionally
shown/hidden in `showDetail`).

## Deck grid rendering

In `renderSavedCards()`:

1. Compute the filtered/sorted card list as today (text filter, type chips).
2. If a real deck is active, split that list into `mainVisible` (not maybe) and
   `maybeVisible` (maybe) using `isMaybe(activeFolder, cardId)`. Otherwise everything
   is `mainVisible` and `maybeVisible` is empty.
3. Render `mainVisible` first, exactly as today (unchanged card-item template).
4. If `maybeVisible.length`, render a full-width divider row ("Maybeboard · N")
   followed by those cards using the same card-item template, plus a `maybe` CSS
   modifier class:
   - Art rendered at reduced opacity + desaturation.
   - A small "Maybe" badge in the top-left corner (same visual pattern as the
     existing `.commander-badge`).
   - Same click / hover / right-click / focus-panel behavior as any other card —
     only the styling and section differ.
5. `state.savedVisible` (used by export) is set to `mainVisible` only.

Type chips (`renderTypeChips`/`pruneToPresent`) continue to reflect the whole deck
(both sections), so filtering by type narrows both the main and Maybeboard sections
consistently.

## Excluded from deck measurement (per decision: excluded from everything)

- `renderDeckAnalysis` — called with only non-maybe cards
  (`getFolderCards(activeFolder).filter(c => !isMaybe(activeFolder, c.id))`), so the
  60-card analysis threshold, mana curve, color-source checks, and role counts never
  see Maybeboard cards.
- `folderCount(folderId)` (sidebar deck-size badge) — skips cards where
  `isMaybe(folderId, cardId)` is true.
- `exportSavedList` — already exports `state.savedVisible`, which now excludes maybe
  cards (see above), so no separate change needed there.
- Commander auto-sort-to-front — applied to `mainVisible` only (moot in practice
  since the commander can never be Maybe, but keeps the intent explicit).

## Out of scope (v1)

- A dedicated "Maybeboard" tab/filter separate from the deck page.
- Bulk mark/unmark actions.
- Including Maybeboard cards in export, price totals, or analysis under any toggle.
- Any change to the "All"/"Unsorted" library views.

## Edge cases

- **Card is a member of multiple decks:** Maybe status is per `(folderId, cardId)`
  pair, so a card can be Maybe in one deck and main in another.
- **Deck drops below the analysis threshold because Maybe cards are excluded:** this
  is the intended effect — Maybeboard cards were never counted as "in" the deck for
  analysis purposes.
- **Marking the commander Maybe:** prevented at the UI level (action hidden); no
  server-side enforcement needed since the client is the only writer of `maybeboard`.
- **Card removed from a deck while marked Maybe:** its maybe flag for that folder is
  cleared at the same mutation site that removes membership.

## Verification approach

- Server: `node --check server.js`; a quick op-sequence smoke test against a temp
  `DATA_DIR` (`setMaybeboard` op persists and reloads correctly, `mergeMaybeboard`
  unions two devices' flags per folder).
- Client: JS parse/lint check; the user verifies the UI themselves (no browser
  automation, per project convention).

## Deployment note

Ships in `server.js` + `public/index.html`, so it reaches Unraid only after a Docker
image rebuild (`docker compose up -d --build`).
