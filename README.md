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

## AI providers

Both providers are supported; pick a preferred one in Settings.

| Provider  | Default model        | Key            |
|-----------|----------------------|----------------|
| Anthropic | `claude-sonnet-4-6`  | `ANTHROPIC_API_KEY` |
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

Mount a volume for the data dir so state survives restarts:

```yaml
volumes:
  - /mnt/user/appdata/spellbook/data:/app/data
```

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
