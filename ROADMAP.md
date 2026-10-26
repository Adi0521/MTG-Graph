# Roadmap

Ideas agreed on but not built yet.

## User-set combo length cap for the deck-wide combo search

Run a depth-first search through the entire deck to find combos, with a parameter that caps how long a
combo the search may look for.

Where it would plug in:

- The rules engine already does a DFS over the deck's ability graph (`findEngineCombos` in
  `src/core/combo-engine.ts`). Its depth is capped internally by `EngineOptions.maxLoopAbilities`
  (default 6 ability steps), and the search is bounded by `searchBudget`, split across start abilities.
- Making it user-facing means: expose the cap in the API (`POST /api/analyze` options, next to
  `maxLoopLength` for synergy loops), show it in the UI's search options, and decide whether the cap counts
  ability steps or distinct cards (a combo's step count can exceed its card count, e.g. Krark-Clan
  Ironworks is used twice in the Scrap Trawler loop).
- Cost: the search grows quickly with depth; measured on the benchmark decks, raising the cap from 6 to 8–10
  made 2–3 decks non-exhaustive at the default budget and found no new real combos. A UI cap should warn
  when the search stops being exhaustive (`exhaustive: false` is already returned).
