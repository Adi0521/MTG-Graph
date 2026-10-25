/** Run the combo engine on fixture cards: npm run combos [-- "Card A" "Card B" ...] (default: both sample decks) */
import { readFileSync } from 'node:fs';
import { toCard } from '../src/core/card.ts';
import { findEngineCombos } from '../src/core/combo-engine.ts';
import { parseDecklist } from '../src/core/decklist.ts';
import { SAMPLE_COMMANDER_DECK } from '../src/core/sample-commander.ts';
import { SAMPLE_DECK } from '../src/core/sample-deck.ts';
import type { ScryfallCard } from '../src/core/types.ts';

const fixtures = JSON.parse(readFileSync(new URL('../test/fixtures/cards.json', import.meta.url), 'utf8')) as Record<string, ScryfallCard>;
const card = (name: string) => toCard(fixtures[name] ?? Object.values(fixtures).find((c) => c.name.startsWith(name))!);
const decks: [string, string[]][] = process.argv.length > 2
  ? [['args', process.argv.slice(2)]]
  : [['60-card', parseDecklist(SAMPLE_DECK).filter((e) => e.section !== 'sideboard').map((e) => e.name)], ['commander', parseDecklist(SAMPLE_COMMANDER_DECK).map((e) => e.name)]];
for (const [label, names] of decks) {
  const t0 = performance.now();
  const { combos, exhaustive } = findEngineCombos(names.map(card));
  console.log(`\n=== ${label}: ${combos.length} combos (${Math.round(performance.now() - t0)}ms, exhaustive=${exhaustive})`);
  for (const c of combos) {
    console.log(`- ${c.loop.join(' + ')}${c.helpers.length ? ' [+ ' + c.helpers.join(', ') + ']' : ''}  => ${c.produces.join(', ')} | net ${c.netMana}`);
    if (c.prerequisites.length) console.log(`    prereq: ${c.prerequisites.join('; ')}`);
    if (c.warnings.length) console.log(`    warn: ${c.warnings.length}`);
  }
}
