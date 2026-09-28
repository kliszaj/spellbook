# Deck Analysis v3 — Design

Date: 2026-09-28
Status: Approved in chat by the user

## Goal
Make deck analysis accurate and easy to parse, and connect it to the collection:
1. Simpler analysis layout without redundancy (summary sentence + "Needs attention" / "On target" chips; in-progress mode for unfinished decks).
2. Role counts from the AI card profiles (fixes flicker counted as removal, missed draw wording, narrow win-condition detection), with the rule-based detection as a fallback.
3. Opening-hand odds and a sample hand with London mulligan.
4. EDHREC recommendations for the commander that the user owns and that aren't in the deck.
Plus: Collection tab puts the color filter and name search above the stats/upload/status header.

## Evidence
On the Hei Bai deck, the rule-based classifier counts 13 removal spells, 9 of which are blink spells (Cloudshift, Ephemerate, Essence Flux, Flicker, Flicker of Fate, Daydream, Skybind, Parting Gust, Touch the Spirit Realm); "draw cards equal to …" (Shrines) is missed by the draw pattern; win conditions only match "win the game" text.

## Layout (Decks tab analysis panel)
- Header strip: name, color pips, "N/100 · L lands · avg MV · €price", bracket, Analyze, collapse.
- Summary: grade badge — or an "In progress" badge showing cards to go when the deck has fewer than 90 cards — and one sentence naming the top 2–3 gaps (the AI verdict replaces it after Analyze).
- "Needs attention" chips (failing checks, worst first) and "On target" chips (passing checks); role chips open that role's cards once (the setup-dependent legend appears once there; card-flow detail lives in the Draw chip).
- Colors as one compact line; win conditions as one line.
- Deck themes appear only after Analyze; pre-Analyze placeholders are removed.
- Right column: mana curve, colors line, Opening hand section; below: "From your collection" (EDHREC) section.
- Existing deck-analysis test contracts stay intact (`deckIdentityHtml`, `IDENTITY_TAG_LENSES`, `DECK_REVIEW_CACHE_VERSION = 3`, the `massRemoval`/`friendlyMassEffect` pattern constants).

## Profile-based roles
- Profiles come from the existing profile store (`data/card-profiles.json`). Deck cards without profiles are profiled under the same spend rule: automatically when ≤ 50 are missing, otherwise a "Profile N cards (≈ $X)" button.
- Mapping (pure, tested): ramp ← ramp | fast-mana; draw ← card-draw; removal ← spot-removal | bounce; wipes ← board-wipe; tutors ← tutor; interaction ← counterspell, or removal at instant speed; graveyardHate ← graveyard-hate; protection ← protection; win conditions ← wincon (plus the existing text detection).
- Profile-based counts are canonical when available; unprofiled cards fall back to the rule-based classifier per card. The AI review (Analyze) keeps verdict, identity tags, and add/trim suggestions.

## Opening hand
Hypergeometric odds on the main deck without the commander: 3+ lands in the opening 7, at least one ramp piece by turn 2 (on the play), and enough lands+ramp seen to cast the commander on curve (approximation, explained in a tooltip). Sample hand (7 random cards) with London mulligan (draw 7, put N on the bottom).

## EDHREC × collection
Server fetches `https://json.edhrec.com/pages/commanders/<slug>.json` (unofficial), caches 24 h, returns cards with category, synergy, inclusion (num_decks / potential_decks). The deck shows EDHREC cards the user owns and that aren't in the deck, sorted by synergy, top 12 with "Show all", each with a bookmark to add it. Failures show a quiet message; nothing else depends on it.
