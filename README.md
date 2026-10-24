# MTG Synergy Graph

Paste a Magic: The Gathering decklist and see how its cards work together as an interactive graph.
The analysis uses no ML: every link comes from an explicit rule over Scryfall's oracle text, type line
and keywords, so the same deck always gives the same graph and every link can be explained.

```sh
npm install
npm run dev      # open the printed URL
npm test         # rule + graph tests against real Scryfall fixtures
```

## How it works

1. **Parse** the decklist (`src/decklist.ts`): plain text, MTGA/MTGO and Moxfield exports, with sections.
2. **Fetch** card data from Scryfall's `/cards/collection` endpoint (`src/scryfall.ts`), cached in localStorage.
3. **Normalize** oracle text (`src/card.ts`): lowercase it and replace self-references ("Krenko", "this creature") with `~`.
4. **Tag** each card (`src/rules.ts`): each *theme* has matchers for cards that **provide** a resource and cards that **want** it.
   For example, Viscera Seer *provides* `creature_dies` (sacrifice outlet) and Blood Artist *wants* it.
5. **Link** cards (`src/graph.ts`):
   - theme edges: provider → wanter
   - tribal edges: a creature of type T → a card whose text cares about T (`src/tribal.ts`)
   - curated two-card combos (`src/combos.ts`)
6. **Analyze**: weighted degree (key cards), isolated cards, payoffs with no enablers, connected components.

## Extending the rules

Add a matcher to a theme in `src/rules.ts`, or a new theme with its own `provides`/`wants`. To check rules against real cards:

```sh
# add card names to EXTRA in scripts/fetch-fixtures.ts, then:
npm run fixtures   # refresh test/fixtures/cards.json from Scryfall
npm run tags       # print every fixture card's tags
```

Then add the expected tags to `test/rules.test.ts`.
