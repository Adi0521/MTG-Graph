/** Print the tags every fixture card receives: node --experimental-strip-types scripts/inspect-tags.ts */
import { readFileSync } from 'node:fs';
import { toCard } from '../src/core/card.ts';
import { tagCard } from '../src/core/rules.ts';
import type { ScryfallCard } from '../src/core/types.ts';

const cards = JSON.parse(readFileSync(new URL('../test/fixtures/cards.json', import.meta.url), 'utf8')) as Record<string, ScryfallCard>;
for (const raw of Object.values(cards)) {
  const c = toCard(raw);
  const t = tagCard(c);
  console.log(c.name.padEnd(28), 'P:', [...t.provides.keys()].join(','), '| W:', [...t.wants.keys()].join(','));
}
