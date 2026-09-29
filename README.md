# Spellbook

A natural-language card search **and deck workshop** for Magic: The Gathering
Commander/EDH. Describe a card in plain English and Spellbook turns it into a
[Scryfall](https://scryfall.com) query — then save the results into decks and get an
honest, deckbuilding-focused analysis of what each deck is missing.

Single-page app: Node/Express backend (`server.js`), all UI + client state in
`public/index.html`, no build step.

## Features

### Search
- **Natural-language search** — type "creatures that give all my creatures trample"
  instead of memorizing Scryfall syntax. Translated by an LLM (Anthropic or OpenAI).
- **Direct card-name fast path** — a bare card name resolves straight through Scryfall
  (exact, then fuzzy) with no LLM call, falling back to AI only if nothing matches.
- **Commander color identity** — pick your commander's colors (WUBRG) and results are
  constrained to legal cards. The server enforces `f:commander` / `id<=` / `game:paper`
  even if the model omits them. (Identity selection is session-only.)
- **Prices** — Cardmarket (EUR) shown on results and card details.

### Decks
- **Decks** — organize saved cards into decks; a card can live in several. Cross-device
  sync keeps them in step (see Persistence).
- **Commander** — crown any legendary creature as a deck's commander.
- **Basic-land quantities** — a basic land carries a per-deck count (e.g. `Forest ×14`)
  via an editable badge, instead of storing duplicates. Counts feed deck size, land
  count, price, and export.
- **Import / export** — paste a decklist (quantities, set codes, comments, DFCs all
  handled) to build a deck; export the visible cards as a Cardmarket/Moxfield list.
- **EDHREC** — jump to a card's EDHREC page.
- **Download** — save a card's print-resolution image (Scryfall PNG, 745×1040 —
  roughly 300 DPI at real card size) for printing proxies. Double-faced cards
  download whichever face the detail panel is showing.

### Deck analysis
Heuristic-first and instant (no tokens), with an optional AI pass:
- **Health grade** — a transparent, rule-based letter from weighted checks (lands,
  curve, color sources, role quotas), with a details drawer.
- **Archetype-aware targets** — the deck's tags (auto-detected or edited) blend into a
  composite lens, so a graveyard-aristocrats deck is judged against *both* archetypes.
- **Role coverage radar** — ramp / draw / removal / wipes / interaction / tutors /
  graveyard hate / protection vs. targets.
- **Mana curve** and **color distribution** — sources you have vs. pip demand per color.
- **Power bracket** — the official Commander bracket (1–5), derived from the Game
  Changers list (Scryfall `is:gamechanger`) and mass-land-denial signals.
- **Win conditions & combo lines** — game-enders detected, plus combos your commander
  appears in (Commander Spellbook).
- **AI Review** (opt-in button) — refines role counts, writes a verdict, and suggests
  cards to trim. Cached per deck so re-opening never re-spends tokens.

### Commander combos
- A **Combos** panel (Focus view) loads the top combos a card appears in from the
  [Commander Spellbook](https://commanderspellbook.com/) API — pieces, steps, and a
  link to the full combo.

### Collection & Swaps
- **Import your collection** — In ManaBox, open the Collection tab and use the
  top-right menu to export the whole collection as CSV (or export a single binder/list
  for new scans). In Spellbook's **Collection** tab, choose **Upload CSV** and pick the
  file. The preview offers two modes:
  - **Full collection** — Spellbook matches the file exactly (adds, updates, removes).
    Use this for whole-collection exports.
  - **New cards** — adds the file's cards on top and never removes anything. Use this
    for a freshly scanned binder. Rows already imported are skipped, so uploading the
    same file twice doesn't double-count.
  Card details are looked up on Scryfall (only new cards on later syncs); if Scryfall
  rate-limits, Spellbook waits and retries.
- **View Swaps** — Select any card and press **View Swaps** in the focus panel to see
  cards you own that could replace it, each with a match % and a one-line reason.
  Matches are budget stand-ins: a weaker card that does the same job still counts, and
  the % says how close it is. Inside a deck, matches respect the commander's colors and
  the deck's **Game plan** — paste the deck's primer (or describe how it wins) via the
  **Game plan** button on the deck (up to 20,000 characters).
- **Decks tab extras** — Cards you own show an **Owned** chip, the deck shows "Own X of
  Y", and a color filter (including Colorless) narrows the grid. Like the type chips,
  Export copies the visible cards; deck analysis always uses the whole deck.
- **AI cost** — Swaps use the AI provider and model from Settings (default
  `claude-sonnet-5-5`). Every card in the collection is profiled once (what it does, its
  mechanics, what it works with); Spellbook asks before profiling more than 50 cards
  and shows an estimate. Measured on Sonnet 5 (2026-09-27 pilot): about **$0.0012 per
  card**, so **≈ $2.40 for ~1,900 unique cards**, once. New pack scans (≤ 50 cards)
  are profiled automatically for a few cents. Each View Swaps ranking costs
  **≈ $0.015–0.03** and is cached per deck version and game plan. The Collection tab
  shows this month's AI spend. Without an API key, swaps fall back to text-based
  matching.
- **Local model** — Matching uses a small local embedding model
  (`Xenova/all-MiniLM-L6-v2`, ~23 MB) that downloads into the data folder (`models/`)
  on first use.

## AI providers

Both providers are supported; pick a preferred one in Settings.

| Provider  | Default model        | Key            |
|-----------|----------------------|----------------|
| Anthropic | `claude-sonnet-5-5`  | `ANTHROPIC_API_KEY` |
| OpenAI    | `gpt-4.1`            | `OPENAI_API_KEY`    |

Environment variables override stored settings: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_MODEL`, `OPENAI_MODEL`. Keys stored via Settings are kept server-side in
`state.json` and are never returned by public state endpoints.

## Setup

```bash
npm install
npm start
```

Open `http://localhost:3000`, click **Settings**, choose a provider, and paste an API
key (or set the env var above). Run on another port with `PORT=3107 npm start`.

For development with auto-reload:

```bash
npm run dev
```

## Persistence & sync

Shared state lives in `DATA_DIR/state.json` (default `./data`): saved cards, decks,
membership, basic-land quantities, search history, cached translations, and
API/provider settings. The server is authoritative — clients send precise ops and
re-sync on focus/visibility/online plus a light poll — so multiple browsers/devices
stay consistent.

## Docker / Unraid

```bash
docker build -t kliszaj/spellbook:latest .
```

The image is based on `node:22-slim` (glibc, required by the local model runtime) and
is about **407 MB**; unused GPU and non-Linux model-runtime files are removed at build
time.

Mount a volume for the data dir so state survives restarts:

```yaml
volumes:
  - /mnt/user/appdata/spellbook/data:/app/data
```

The embedding model is cached under the data volume in `models/`, so it downloads only
once.

The container listens on `3000` unless `PORT` is set. Deploying changes to a running
container requires an image rebuild (`docker compose up -d --build`).

## Tech stack

- **Frontend** — one HTML file, vanilla JS, no build step
- **Backend** — Node.js + Express (proxies the LLM/Scryfall/Spellbook APIs, owns state)
- **Data** — [Scryfall](https://scryfall.com/docs/api) (cards, `is:gamechanger`),
  [Commander Spellbook](https://commanderspellbook.com/) (combos), EDHREC (links only),
  Anthropic / OpenAI (query translation + deck review)

## Cost

A natural-language search is roughly a fraction of a cent; prompt caching drops repeat
queries further. Deck analysis is free by default — only the optional **AI Review**
button spends tokens, and its result is cached per deck. Scryfall and Commander
Spellbook are free.
