# Spellbook

Natural language card search for Magic: The Gathering Commander/EDH. Describe the card you're looking for in plain English and Spellbook translates it into a [Scryfall](https://scryfall.com) search query.

## Features

- **Natural language search** — type "creatures that give all my creatures trample" instead of memorizing Scryfall syntax
- **Commander color identity** — set your commander's colors (WUBRG) and results are automatically filtered to legal cards
- **Cardmarket prices** — see EUR prices from Cardmarket for every result
- **Save cards** — bookmark interesting cards for later (stored in your browser)
- **Card details** — click any card to see oracle text, set, rarity, and direct links to Cardmarket and Scryfall

## How it works

1. Your natural language query is sent to Claude (Sonnet 4.6) with a comprehensive Scryfall syntax reference
2. Claude translates it into a valid Scryfall search query (with `f:commander`, `id<=` for your color identity, and `game:paper`)
3. The query is sent to the [Scryfall API](https://scryfall.com/docs/api) and results are displayed

## Setup

You need a [Claude API key](https://console.anthropic.com/) from Anthropic.

```bash
npm install
npm start
```

Open `http://localhost:3000`, click Settings, and paste your API key.

For development with auto-reload:

```bash
npm run dev
```

## Tech stack

- **Frontend**: Single HTML file, vanilla JS, no build step
- **Backend**: Node.js + Express (proxies Claude API to avoid CORS)
- **APIs**: Anthropic Claude API (query translation), Scryfall API (card search)

## Cost

Each search costs roughly $0.008 (~0.8 cents) using Claude Sonnet 4.6. Prompt caching reduces this to ~$0.001 after the first query. The Scryfall API is free.
