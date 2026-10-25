/** Print the parsed loop abilities of every fixture card: npm run abilities */
import { readFileSync } from 'node:fs';
import { parseAbilities } from '../src/core/abilities.ts';
import { toCard } from '../src/core/card.ts';
import type { ScryfallCard } from '../src/core/types.ts';

const cards = JSON.parse(readFileSync(new URL('../test/fixtures/cards.json', import.meta.url), 'utf8')) as Record<string, ScryfallCard>;
const only = process.argv.slice(2);
for (const raw of Object.values(cards)) {
  if (only.length && !only.some((o) => raw.name.toLowerCase().includes(o.toLowerCase()))) continue;
  for (const a of parseAbilities(toCard(raw))) {
    const cost = Object.entries(a.cost.mana).filter(([, v]) => v).map(([k, v]) => `${v}${k}`).join('');
    const costs = [cost && `mana:${cost}`, a.cost.tap && 'T', a.cost.sacrifice && `sac${a.cost.sacrifice.another ? '(another)' : ''}`, a.cost.life && `life:${a.cost.life}`, a.cost.removeCounter && 'rmCounter'].filter(Boolean).join(' ');
    const outs = a.outputs.map((o) => o.type + (o.type === 'mana' ? JSON.stringify(Object.fromEntries(Object.entries(o.mana).filter(([, v]) => v))) : '')).join(',');
    console.log(`${a.id.padEnd(34)} ${a.kind.padEnd(9)} ${a.trigger ? 'on:' + a.trigger.type + (a.trigger.type === 'death' && a.trigger.nontoken ? '(nontoken)' : '') : ''} [${costs}] -> ${outs}${a.host ? ' (host)' : ''}${a.oncePerTurn ? ' ONCE' : ''}${a.unmodeledCost ? ' UNMODELED-COST' : ''}${a.conditions.length ? ' | ' + a.conditions.join('; ') : ''}`);
  }
}
