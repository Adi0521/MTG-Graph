/**
 * Run the combo engine on any cards from the discovery pool:
 *   npm run try -- "Card A" "Card B" ...
 * (Needs the pool cached by `npm run discover`; falls back to the benchmark's card data.)
 */
import { toCard } from '../src/core/card.ts';
import { findEngineCombos } from '../src/core/combo-engine.ts';
import { loadPool } from '../src/discovery/pool.ts';

import { readFileSync } from 'node:fs';
const pool = new Map((await loadPool()).map((c) => [c.name.toLowerCase(), c]));
// Cards outside the discovery pool (banned or not on paper) are often in the benchmark's frozen card data.
const bench = JSON.parse(readFileSync(new URL('../bench/data/cards.json', import.meta.url), 'utf8')) as Record<string, (typeof pool extends Map<string, infer V> ? V : never)>;
for (const [name, card] of Object.entries(bench)) if (!pool.has(name)) pool.set(name, card);
const names = process.argv.slice(2);
const cards = names.map((n) => {
  const raw = pool.get(n.toLowerCase()) ?? [...pool.values()].find((c) => c.name.toLowerCase().startsWith(n.toLowerCase()));
  if (!raw) throw new Error(`Unknown card: ${n}`);
  return toCard(raw);
});
const { combos, rejected } = findEngineCombos(cards);
if (!combos.length) console.log(`${names.join(' + ')}: no combo${rejected.length ? ` (rejected: ${[...new Set(rejected.map((r) => r.reason))].join('; ')})` : ''}`);
for (const c of combos) {
  console.log(`${c.cards.join(' + ')}: ${c.produces.join(', ')} | net ${c.netMana}`);
  if (c.helpers.length) console.log(`  helpers: ${c.helpers.join(', ')}`);
  if (c.prerequisites.length) console.log(`  needs: ${c.prerequisites.join(' · ')}`);
  if (c.verification.startup.length) console.log(`  start: ${c.verification.startup.join(' · ')}`);
}
