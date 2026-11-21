# Handoff

Spellbook is a Node/Express single-page Magic: The Gathering search and deck
manager. The backend lives in `server.js` (plus `lib/`); the web client is
`public/index.html` (markup), `public/styles.css` and the numbered scripts in
`public/js/` (see Code Layout). Normal local URL is `http://localhost:3000`.

## Current Status

Branch: `main`

The user prefers keeping Spellbook work directly on `main` rather than using
feature branches unless they explicitly ask for one.

Most recent work (newest first):

- AI search: the server checks the AI's Scryfall query before answering and has the AI
  repair it once on a syntax error, ignored terms or zero results
  (`lib/search-repair.js`); the query shows as plain-English chips you can switch off
  or add presets to, without another AI call.
- Sync: one-time upload per device, per-item ops, unsent changes kept and sent on
  page close, a "Not synced" badge (see Sync).
- Security and robustness: `esc()` escapes quotes, Settings saves take the state
  lock, an unreadable `state.json` falls back to the newest backup, input caps,
  EDHREC cache hardening, keyboard-reachable deck actions and proper dialogs.
- `index.html` split into `styles.css` and `public/js/*.js`, joined by the server
  into `/app.js`.
- Play in Playmat: a Play button on a deck opens it in a Playmat server's import
  screen (Settings → Playmat address).
- A GitHub Action tests every push and publishes `kliszaj/spellbook:latest`.

Earlier work:

- Basic-land quantities for decks.
- Deck Analysis 2.0 with deck profiles/tags, health lens, grade drawer, radar,
  mana curve, color-source checks, bracket collapse, and AI-assisted trim/verdict.
- Search UI refinements, provider-aware AI settings, and safer search cache behavior.

Verification: `npm test` runs every check (see Tests). It needs `npm ci` first.

## AI Settings

Settings now supports both providers:

- Anthropic API key and model.
- OpenAI API key and model.
- Preferred provider selector.

The model fields are **dropdowns** (`<select>`), not free text — Anthropic:
`claude-sonnet-5-5` / `claude-opus-5-5` / `claude-fable-5-1` / `claude-haiku-4-5` /
`claude-sonnet-5`; OpenAI: `gpt-6.1-sol` / `gpt-6-astra` / `gpt-6-luna`.
`setModelSelect()` injects a saved value that isn't a listed option as a `· custom`
entry so older/custom models still show and persist. Prices for cost tracking are in
`AI_PRICES` in `lib/ai-client.js`.

Stored keys are kept in the appdata-backed `state.json` and are never returned by
public state endpoints. Key inputs in the modal are write-only and blank on open.

Environment variables override stored values:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_MODEL`
- `OPENAI_MODEL`

Defaults (`DEFAULT_ANTHROPIC_MODEL` / `DEFAULT_OPENAI_MODEL` in `server.js`):

- Anthropic: `claude-sonnet-5-5`
- OpenAI: `gpt-6.1-sol`

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
- `maybeboard`, `pins`: per-deck flags, `{ [folderId]: { [cardId]: true } }`.
- `deckNotes`: per-deck game plans, `{ [folderId]: text }`.
- `playmatUrl`: the Playmat server's address (an origin), for "Play in Playmat".
- `translateCache` and `searchHistory`: shared across browsers/devices.
- `apiKey`: legacy Anthropic key field.
- `openaiApiKey`: OpenAI key field.
- `preferredAiProvider`, `anthropicModel`, `openaiModel`.

Only basic lands are allowed to show and store count values greater than 1.
Deck size, land count, export, and price calculations are quantity-weighted.

## Code Layout

- `public/index.html`: markup only. `public/styles.css`: all styles (colour tokens at
  the top, light and dark).
- `public/js/01-core.js` … `12-app.js`: the client script, split at its section
  headers. It was written as one script — top-level code calls functions defined
  further down — so the server joins the files in name order and serves them as
  **`/app.js`** (re-joined whenever a file changes; no build step). Don't load the files
  one by one. Keep the two-digit prefixes when adding a file.
- Pure helpers the checks test sit between `// @testable <name> begin/end` markers;
  `scripts/lib/app-source.mjs` gives the checks the whole client source.

## Sync

The server owns `state.json`; each device's localStorage is a cache.

- On a device's first visit since sync existed, its local copy is merged with the
  server's and uploaded once (`sync_migrated_v1` in localStorage). After that the
  server copy is adopted as-is. (Uploading on every load used to bring deleted decks
  back.)
- Changes go up as per-item ops (`upsertFolder`, `deleteFolder`, `setCardInFolder`,
  `setQuantity`, `setFlag`, `setDeckNote`, plus `setSettings`/`setCaches`), so two
  devices editing different things don't overwrite each other. The older whole-list
  ops still work for tabs running an older page. The server checks the shape of every
  op and of `state.json`.
- Unsent ops are kept in localStorage (`pending_ops`), sent with `keepalive` when the
  page is hidden or closed, and retried with back-off. A "Not synced" badge shows while
  the server can't be reached. Every op is safe to apply twice.
- An unreadable `state.json` is copied to `state.corrupt-<date>.json` and the newest
  `backups/state-*.json` is served instead.

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

Before answering, `/api/translate` runs the AI's query on Scryfall
(`lib/search-repair.js`). On a syntax error, terms Scryfall ignored (its `warnings`)
or zero results, the AI gets Scryfall's answer and one chance to fix or widen the
query; the response then carries `repaired: { from, note, reason }` and the client
shows the note with "Use my exact wording". Searches that work cost nothing extra.

Under the search bar the query is shown as chips (`queryChips` / `describeQueryTerm`
in `04-search.js`). Switching a chip off or adding a preset re-runs Scryfall only; the
colour identity and Commander legality are locked chips kept from the original query.
Searches are capped at 1,000 characters.

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
- The client script is split across `public/js/`; use `rg -n` to find a function
  before editing, and remember it all runs as one joined script (see Code Layout).
- The appdata `state.json` is runtime data and should not be committed.
- Do not include `.claude/settings.local.json` unless the user explicitly wants
  local Claude permission changes committed.

## Tests

`npm test` runs every check: collection, swaps, deck analysis, Play in Playmat, the
joined client script, the server over HTTP (`scripts/check-server.mjs` starts it on a
free port with a throwaway `DATA_DIR`, no AI keys) and AI search (repair logic with a
fake Scryfall and AI, and the query chips). None of them spend AI money.

## Automatic Image Builds

`.github/workflows/docker.yml` runs `npm test` on every push and pull request. On
`main` it then builds the image and pushes `kliszaj/spellbook:latest` and
`kliszaj/spellbook:sha-<commit>` to Docker Hub, which needs the repository secrets
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (without them the push is skipped with a
notice). Unraid's Compose Manager can then show the update.

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
