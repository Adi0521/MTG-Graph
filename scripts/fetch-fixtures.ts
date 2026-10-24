/**
 * Download real Scryfall data for the sample decks plus a few rule-coverage
 * cards into test/fixtures/cards.json, so tests run offline against real oracle text.
 *   npm run fixtures
 */
import { writeFileSync } from 'node:fs';
import { parseDecklist } from '../src/core/decklist.ts';
import { SAMPLE_COMMANDER_DECK } from '../src/core/sample-commander.ts';
import { SAMPLE_DECK } from '../src/core/sample-deck.ts';
import { fetchCards } from '../src/core/scryfall.ts';
import type { ScryfallCard } from '../src/core/types.ts';

const EXTRA = [
  'Hardened Scales',
  'Walking Ballista',
  'Heliod, Sun-Crowned',
  'Monastery Swiftspear',
  'Guttersnipe',
  'Lotus Cobra',
  'Satyr Wayfinder',
  'Gurmag Angler',
  'Sythis, Harvest\'s Hand',
  'Thought Monitor',
  'Delver of Secrets',
  'Lord of Atlantis',
  'Silvergill Adept',
  'Wrath of God',
  'Brainstorm',
  'Faerie Mastermind',
  'Ephemerate',
  'Mulldrifter',
  'Cranial Plating',
  'Pestermite',
  'Sanguine Bond',
  'Exquisite Blood',
  'Splinter Twin',
  'Animate Dead',
];

const names = [...new Set([...parseDecklist(SAMPLE_DECK + '\n' + SAMPLE_COMMANDER_DECK).map((e) => e.name), ...EXTRA])];
const memory = new Map<string, ScryfallCard>();
const { cards, notFound } = await fetchCards(names, {
  cache: { get: (n) => memory.get(n), set: (n, c) => void memory.set(n, c) },
  fetchImpl: (url, init) =>
    fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), 'User-Agent': 'mtg-graph-fixtures/0.1' } }),
});
if (notFound.length) console.warn('Not found:', notFound);
const out = Object.fromEntries([...cards.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => [c.name, c]));
writeFileSync(new URL('../test/fixtures/cards.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${Object.keys(out).length} cards`);
