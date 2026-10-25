# MTG Synergy Graph

Upload or paste a Magic: The Gathering decklist. The API maps how every card feeds every other
card, finds the structures those links form (loops of any length, loop systems, trees, chains and
load-bearing cards), and detects infinite combos. The UI draws it all as an interactive graph.

No ML is used. Every link comes from an explicit rule over Scryfall's oracle text, type line and
keywords, and every structure comes from standard graph algorithms with step budgets (not timers).
The same deck and options always give the same result, and every link can be explained.

```sh
npm install
npm run dev        # API on :8787 + UI on :5173 (proxied)
npm test           # rules, structures, parsers and API against offline Scryfall fixtures

npm run build && npm start   # production: one server on :8787 serving the UI and the API
```

## API

### `POST /api/analyze`

Typed decklist:

```sh
curl localhost:8787/api/analyze -H 'Content-Type: application/json' \
  -d '{"decklist": "4 Gravecrawler\n2 Phyrexian Altar", "options": {"maxLoopLength": 20}}'
```

Uploaded file (`.txt`, `.dec`, `.dck`, MTGA exports, MTGO `.dek` XML, Moxfield/Archidekt `.csv`):

```sh
curl localhost:8787/api/analyze -F deck=@mydeck.dek -F 'options={"minLoopLength":10,"maxLoopLength":15}'
```

| Option | Default | Meaning |
| --- | --- | --- |
| `minLoopLength` / `maxLoopLength` | 2 / 20 | Loop length window (max 30) |
| `maxLoops` | 100 | How many loops to return, best first |
| `minEdgeWeight` | 0 | Ignore weaker links when finding structures |
| `searchBudget` | 2,000,000 | DFS step cap for the loop search |

`enabledKinds` (array) restricts which link types are used, and `"spellbook": false` skips the
Commander Spellbook lookup. The response contains `cards` (with tags and degrees), directed `edges`
(each with explained `reasons`), `themes`, `insights`, `structures` and `combos`.

### `GET /api/rules`

Every theme and the human-readable rules behind it.

## How it works

1. **Parse** the deck (`src/core/decklist.ts`, `deckfile.ts`).
2. **Fetch** cards from Scryfall's `/cards/collection` on the server, cached in `.cache/`.
3. **Normalize** oracle text (`card.ts`): lowercase it, drop reminder text, and replace self-references with `~`.
4. **Tag** cards (`rules.ts`): each theme is a resource, with rules for cards that **provide** it and cards that **want** it.
   Resources include sacrifice fodder, deaths, creatures entering, ETB re-use, mana, untap, lifegain, life drain,
   counters, spells, graveyard, artifacts, enchantments, landfall and draw.
5. **Link** (`graph.ts`): a directed edge A → B when A provides something B wants, plus tribal links and curated combos.
6. **Find structures** (`structures.ts`):
   - **Loop systems:** strongly connected components (Tarjan). Every loop lives inside one, so these are the complete map of looping structure.
   - **Loops:** elementary cycles within a length window, each found exactly once, pruned by reverse-BFS distance, best `maxLoops` kept.
   - **Trees:** downstream (what a card powers) and upstream (what powers it) shortest-path trees for every card.
   - **Chains:** longest paths through the DAG of loop systems (enablers → engines → payoffs).
   - **Load-bearing cards and critical links:** cards and links whose removal splits a synergy cluster.

Generic rules find many real combos on their own, without the curated list. Examples: Gravecrawler + Phyrexian Altar
(fodder ↔ mana), Kiki-Jiki + Zealous Conscripts / Restoration Angel (copy ↔ untap), Splinter Twin + Pestermite, and
Sanguine Bond + Exquisite Blood (lifegain ↔ drain).

## Combos

Combos come from two sources, and each combo says which found it:

- **Commander Spellbook** (`src/core/spellbook.ts`): the community-curated combo database, queried on the
  server and cached per deck in `.cache/spellbook.json` (7 days by default). Provides step-by-step
  instructions, prerequisites, and **near misses**: combos one card away from the deck.
- **Rules engine** (`src/core/abilities.ts`, `combo-engine.ts`): parses abilities into costs and effects,
  searches for loops of abilities, and simulates one pass of each loop. It only reports a loop as infinite
  when every `{T}` is untapped again, mana (with colors) and life break even, nothing is once-per-turn,
  recursion only returns cards that died in the loop, and token-only triggers ignore tokens. If mana or
  life is short, it adds cards from the deck that trigger on the loop (e.g. a Treasure per death) as
  extra pieces, and lists the other cards that trigger on it as payoffs.

On the sample Korvold deck, the engine independently finds all 10 combos Spellbook lists, plus 7 larger variants.
Any cost the parser does not understand (e.g. "Sacrifice a Food") marks the ability as unusable in loops,
so unknown wording makes the engine miss combos rather than invent them.

Combos are added to the graph as loops (`combo` links).

| Env var | Default | Meaning |
| --- | --- | --- |
| `SPELLBOOK` | on | `off` disables the Spellbook lookup (the engine still runs) |
| `SPELLBOOK_CACHE_HOURS` | 168 | How long a deck's Spellbook result is reused |

## Limits

- **Loops grow combinatorially.** The sample Korvold deck has a 25-card loop system and more than 35,000 distinct loops
  of 2–20 cards. The API reports the loop *systems* completely, returns the best-ranked loops, and says whether the
  search was exhaustive. Narrow the length window or raise `minEdgeWeight` to search more of the space.
- **A synergy loop is not an infinite combo.** The Loops tab shows cards that help each other in a cycle; the
  Combos tab shows loops that are actually infinite.
- **The combo engine models a subset of the rules.** It covers sacrifice, mana, untap, copy, blink, graveyard
  recursion, lifegain/drain and +1/+1 counters. It does not model undying/persist, -1/-1 counters, cost
  reducers, spells cast from hand, or combat. Spellbook covers many of those.
- **Coverage is only as good as the rules.** Unusual wording needs a new rule. See below.

## Extending the rules

Add a matcher to a theme in `src/core/rules.ts`, or add a new theme. To check rules against real cards:

```sh
# add card names to EXTRA in scripts/fetch-fixtures.ts, then:
npm run fixtures   # refresh test/fixtures/cards.json from Scryfall
npm run tags       # print every fixture card's tags
```

Then add the expected tags to `test/rules.test.ts`. For combos, `npm run abilities -- "Card Name"` shows how a
card's abilities were parsed, and `npm run combos -- "Card A" "Card B"` runs the engine on any fixture cards. Bump `ENGINE_VERSION` in `src/core/analyze.ts` when results change.
