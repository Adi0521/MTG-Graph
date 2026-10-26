import { readFileSync } from 'node:fs';
import { toCard } from '../src/core/card.ts';
import type { Card, ScryfallCard } from '../src/core/types.ts';

export const FIXTURES = JSON.parse(
  readFileSync(new URL('./fixtures/cards.json', import.meta.url), 'utf8'),
) as Record<string, ScryfallCard>;

/** Frozen benchmark card data (keyed by lowercase name), a second source of real cards for tests. */
const BENCH_CARDS = JSON.parse(readFileSync(new URL('../bench/data/cards.json', import.meta.url), 'utf8')) as Record<string, ScryfallCard>;

export function card(name: string, quantity = 1): Card {
  const raw = FIXTURES[name] ?? Object.values(FIXTURES).find((c) => c.name.split(' // ')[0] === name) ?? BENCH_CARDS[name.toLowerCase()];
  if (!raw) throw new Error(`No fixture for ${name}; add it to scripts/fetch-fixtures.ts`);
  return toCard(raw, quantity);
}
