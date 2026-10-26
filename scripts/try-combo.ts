/**
 * Run the combo engine on any cards from the discovery pool:
 *   npm run try -- "Card A" "Card B" ...
 * (Needs the pool cached by `npm run discover`.)
 */
import { toCard } from '../src/core/card.ts';
import { findEngineCombos } from '../src/core/combo-engine.ts';
import { loadPool } from '../src/discovery/pool.ts';

const pool = new Map((await loadPool()).map((c) => [c.name.toLowerCase(), c]));
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
