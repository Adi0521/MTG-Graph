/** Show loops the simulator rejected, per benchmark deck: npm run rejected [-- deck-slug] */
import { readFileSync, readdirSync } from 'node:fs';
import { toCard } from '../src/core/card.ts';
import { findEngineCombos } from '../src/core/combo-engine.ts';
import { parseDecklist } from '../src/core/decklist.ts';
import type { ScryfallCard } from '../src/core/types.ts';

const data = JSON.parse(readFileSync(new URL('../bench/data/cards.json', import.meta.url), 'utf8')) as Record<string, ScryfallCard>;
const only = process.argv[2];
for (const file of readdirSync(new URL('../bench/decks/', import.meta.url)).sort()) {
  if (only && !file.startsWith(only)) continue;
  const entries = parseDecklist(readFileSync(new URL(`../bench/decks/${file}`, import.meta.url), 'utf8')).filter((e) => e.section !== 'sideboard');
  const { combos, rejected } = findEngineCombos(entries.map((e) => toCard(data[e.name.toLowerCase()]!)));
  const seen = new Map<string, string>();
  for (const r of rejected) seen.set(r.cards.slice().sort().join(' + '), r.reason);
  console.log(`\n== ${file}: ${combos.length} verified, ${seen.size} rejected`);
  for (const [cards, reason] of [...seen].slice(0, 12)) console.log(`  ✗ ${cards}: ${reason}`);
}
