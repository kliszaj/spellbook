# Handoff

Spellbook is a Node/Express single-page Magic: The Gathering search and deck
manager. The backend lives in `server.js`; most UI and client state logic lives in
`public/index.html`. Normal local URL is `http://localhost:3000`.

## Current Status

Branch: `main`

The user prefers keeping Spellbook work directly on `main` rather than using
feature branches unless they explicitly ask for one.

This branch contains the current Spellbook work:

- Basic-land quantities for decks.
- Deck Analysis 2.0 with deck profiles/tags, health lens, grade drawer, radar,
  mana curve, color-source checks, bracket collapse, and AI-assisted trim/verdict.
- Search UI refinements, provider-aware AI settings, and safer search cache behavior.

Recent verification:

- `node --check server.js`
- Settings endpoint smoke test on a temp `DATA_DIR`.
- Settings save/read smoke test on a temp `DATA_DIR`.

There is a local `.claude/settings.local.json` edit in the working tree that only
adds a Claude permission for `git fetch`; it is not part of the app feature work.

## AI Settings

Settings now supports both providers:

- Anthropic API key and model.
- OpenAI API key and model.
- Preferred provider selector.

The model fields are **dropdowns** (`<select>`), not free text — Anthropic:
`claude-opus-4-8` / `claude-sonnet-5` / `claude-sonnet-4-6` / `claude-haiku-4-5` /
`claude-fable-5`; OpenAI: `gpt-4.1` / `gpt-4.1-mini` / `gpt-4o` / `gpt-4o-mini`.
`setModelSelect()` injects a saved value that isn't a listed option as a `· custom`
entry so older/custom models still show and persist. (Model IDs verified against the
claude-api skill — the `claude-sonnet-4-6` default is a valid, active ID.)

Stored keys are kept in the appdata-backed `state.json` and are never returned by
public state endpoints. Key inputs in the modal are write-only and blank on open.

Environment variables override stored values:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_MODEL`
- `OPENAI_MODEL`

Defaults:

- Anthropic: `claude-sonnet-4-6`
- OpenAI: `gpt-4.1`

Both `/api/translate` and `/api/deck-review` use the preferred provider. OpenAI is
called through Chat Completions JSON mode without adding an SDK dependency.

Translate cache keys now include provider and model, so switching between
Anthropic and OpenAI produces a fresh comparison for the same prompt. Old cache
entries still display as backward-compatible entries.

## Persistence And Unraid

The app persists shared state to `DATA_DIR/state.json`.

For Docker/Unraid, use a volume like:

```yaml
volumes:
  - /mnt/user/appdata/spellbook/data:/app/data
```

That appdata folder stores saved cards, decks, search history, cached
translations, API keys, and model/provider settings.

The normal container port is `3000` unless `PORT` is set.

## Deck State

Important data structures in `state.json`:

- `savedCards`: full Scryfall card snapshots.
- `folders`: decks, still internally named folders.
- `membership`: card-to-deck membership.
- `quantities`: per-deck basic-land counts:
  `{ [folderId]: { [cardId]: count } }`.
- `translateCache` and `searchHistory`: shared across browsers/devices.
- `apiKey`: legacy Anthropic key field.
- `openaiApiKey`: OpenAI key field.
- `preferredAiProvider`, `anthropicModel`, `openaiModel`.

Only basic lands are allowed to show and store count values greater than 1.
Deck size, land count, export, and price calculations are quantity-weighted.

## Search And Color Identity

Color identity selection is session-only in the UI. Empty selection means no
identity restriction; selecting colors means results should be constrained to
cards whose color identity is within the selected colors.

The server defensively enforces Commander filters for AI-generated Scryfall
queries:

- strips any model-produced `f:commander`, `game:paper`, and identity filters,
- repairs simple leading `A or B` expressions by grouping them,
- appends `f:commander`, `id<=...` when selected, and `game:paper`.

The client also filters AI-recommended card-name results against the selected
identity after resolving cards through Scryfall.

## Deck Analysis

Deck Analysis is heuristic-first and AI-assisted:

- Heuristics compute deck health, role coverage, mana curve, color sources, tags,
  and profile/lens adjustments instantly.
- The **Analyze** button (formerly "AI Review" — now labelled "Analyze"/"Re-analyze"
  with a sparkle icon, `ICON_SPARKLE`) refines role counts and writes the verdict.
- AI review output is cached per deck signature in `localStorage` (`deck_reviews`), so
  it survives reloads and only re-spends tokens when the deck actually changes.

The **Add/Trim ("fix") section is hidden until Analyze is run** — it's an empty
`#da2-fix-wrap` (`.da2-fix-wrap:empty{display:none}`) that `renderAiExtras` fills via
`fixRowsHtml`. Both Add and Trim are **specific card names** now (the server prompt
returns an `add: [...]` array alongside `trim`), not category chips like "+2 wipes".
Each chip is a `.da2-card-chip` with `data-card`; clicking (or Enter/Space) calls
`openCardByName` → looks the card up (saved cards first, then Scryfall `cards/named`
exact→fuzzy) → `showDetail` opens it in the focus panel. `deckGaps`/`heuristicVerdict`
still exist but the heuristic Add chips are gone (fix section is AI-only).

The **Win conditions** block is now the **3rd column** inside `.da2-cols`
(`grid-template-columns: … 3 tracks`; wraps full-width at ≤1040px, stacks at ≤900px),
not a full-width row below.

Deck identity is **AI-derived and read-only**. Analyze sends the commander, the
card list, and heuristic win-condition signals to the chosen provider; the provider
returns 2-8 labels from Moxfield's 94-theme catalog plus a small Spellbook extension
(for example, `Graveyard`, `Sacrifice`, `Landfall`, `Treasure`, or `Power Matters`).
There is no manual tag picker. A small, internal map sends only tags that materially
change healthy Commander targets into a blended profile (`blendProfiles`: targets
averaged, role weights taken at their max); all other labels are descriptive only.
The review cache includes the commander name as well as deck contents, and cache
version 3 invalidates prior manual/heuristic tag reviews.

Deck analysis and the bracket are **hidden until a deck has `ANALYSIS_MIN_CARDS` (60)**
cards; below that only the identity strip + a "keep building" prompt show, since
100-card targets would flag an incomplete deck as short on everything.

The bottom AI-notes bullet list was removed; verdict and Add/Trim chips carry the
primary guidance. The grade badge shows just the letter (no "Health" label) with a
small circular info toggle that opens the weighted-check breakdown drawer. The whole
analysis block sits at the top of the deck view, above the card filter.

## Commander Spellbook Combos

`GET /api/combos?commander=<name>&offset=<n>` proxies Commander Spellbook variants.
Use `card:"<name>"`, not `commander:"<name>"`, because `commander:` only finds
combos that require the card in the command zone.

Commander Spellbook has no app API key requirement.

## Useful Commands

Run locally:

```powershell
cd C:\Users\Adrian\Documents\Coding\spellbook
npm start
```

Run on another port:

```powershell
cd C:\Users\Adrian\Documents\Coding\spellbook
$env:PORT="3107"; npm start
```

Docker rebuild locally:

```powershell
cd C:\Users\Adrian\Documents\Coding\spellbook
docker build -t kliszaj/spellbook:latest .
```

Unraid update from the app folder:

```bash
cd /mnt/user/appdata/spellbook
docker compose pull
docker compose up -d
```

If using a locally built compose instead of Docker Hub:

```bash
cd /mnt/user/appdata/spellbook
docker compose up -d --build
```

## Notes For The Next Agent

- Use terminal checks by default; the user often verifies UI visually themselves.
- Do not print or inspect plaintext API keys.
- Be careful with `public/index.html`; it is a large single-file UI, so use `rg -n`
  anchors before editing.
- The appdata `state.json` is runtime data and should not be committed.
- Do not include `.claude/settings.local.json` unless the user explicitly wants
  local Claude permission changes committed.

## Deck-Analysis Calibration Corpus

`fixtures/deck-analysis-calibration.json` records the intended archetypes and
human-reviewed expectations for the sample decks shared by the user. It is
validated with:

```powershell
npm run test:calibration
```

`npm run test:board-wipes` executes source-linked regression cases against the
same wipe and friendly-mass-effect patterns used by the client. It covers real
wipes (including bounce wipes) and false positives such as token makers,
self-protection, and damage-only spells. Run both with `npm run test:deck-analysis`.

`npm run test:deck-identity` checks the AI-derived, read-only identity contract:
the permitted catalog, the commander-aware cache signature, the internal lens map,
and the absence of the old manual tag controls.

Public Moxfield decklists can be captured as versioned local snapshots without
depending on an undocumented API:

```powershell
$env:VIRTUAL_ENV = "$env:TEMP\spellbook-calibration-venv"
& "$env:VIRTUAL_ENV\Scripts\python.exe" -m pip install -r scripts\requirements-calibration.txt
& "$env:VIRTUAL_ENV\Scripts\python.exe" scripts\snapshot_moxfield_fixtures.py --id pako-haldan-voltron
```

The script uses an installed Edge/Chrome instance through Playwright, waits for
the public Moxfield page to hydrate, and writes card-name/quantity snapshots to
`fixtures/moxfield-snapshots/`. Run it against all Moxfield fixtures once the
single-deck capture has been validated.
