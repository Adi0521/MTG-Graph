import { describe, expect, it } from 'vitest';
import { findEngineCombos } from '../src/core/combo-engine.ts';
import { comboReasons, mergeCombos } from '../src/core/combos.ts';
import { fetchSpellbook, mapSpellbookResults } from '../src/core/spellbook.ts';
import { card } from './helpers.ts';

/** Trimmed from a real find-my-combos response. */
const variant = (id: string, cards: string[], produces: string[], extra: Record<string, unknown> = {}) => ({
  id,
  uses: cards.map((name) => ({ card: { name } })),
  produces: produces.map((name) => ({ feature: { name } })),
  requires: [],
  description: 'Step one.\nStep two.\nRepeat.',
  easyPrerequisites: '',
  notablePrerequisites: 'You control an additional Zombie.',
  manaNeeded: '',
  popularity: 100,
  ...extra,
});

const RAW = {
  included: [variant('2577-4050', ['Gravecrawler', 'Phyrexian Altar'], ['Infinite death triggers', 'Infinite creature ETB'])],
  almostIncluded: [
    variant('1', ['Gravecrawler', 'Phyrexian Altar', 'Warren Soultrader'], ['Infinite colorless mana'], { popularity: 5 }),
    variant('2', ['Blood Artist', 'Carrion Feeder', 'Nim Deathmantle'], ['Infinite life loss'], { popularity: 50 }),
  ],
};

describe('mapSpellbookResults', () => {
  it('maps combos, prerequisites, steps and near misses', () => {
    const result = mapSpellbookResults(RAW, ['Gravecrawler', 'Phyrexian Altar', 'Blood Artist', 'Carrion Feeder']);
    expect(result.included[0]).toMatchObject({
      cards: ['Gravecrawler', 'Phyrexian Altar'],
      steps: ['Step one.', 'Step two.', 'Repeat.'],
      prerequisites: ['You control an additional Zombie.'],
      url: 'https://commanderspellbook.com/combo/2577-4050/',
    });
    // Most popular near miss first, with the missing cards called out.
    expect(result.almostIncluded.map((n) => n.missing)).toEqual([['Nim Deathmantle'], ['Warren Soultrader']]);
  });
});

describe('fetchSpellbook', () => {
  it('sends main deck and commanders separately', async () => {
    let sent: unknown;
    const fake: typeof fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: RAW }));
    };
    await fetchSpellbook(
      [
        { name: 'Korvold, Fae-Cursed King', quantity: 1, section: 'commander' },
        { name: 'Gravecrawler', quantity: 1, section: 'main' },
      ],
      { fetchImpl: fake },
    );
    expect(sent).toEqual({ main: [{ card: 'Gravecrawler', quantity: 1 }], commanders: [{ card: 'Korvold, Fae-Cursed King', quantity: 1 }] });
  });

  it('throws on HTTP errors', async () => {
    const fake: typeof fetch = async () => new Response('nope', { status: 503 });
    await expect(fetchSpellbook([{ name: 'X', quantity: 1, section: 'main' }], { fetchImpl: fake })).rejects.toThrow('503');
  });
});

describe('mergeCombos', () => {
  const engine = findEngineCombos(['Gravecrawler', 'Phyrexian Altar', 'Sanguine Bond', 'Exquisite Blood'].map((n) => card(n)));
  const spellbook = mapSpellbookResults(RAW, ['Gravecrawler', 'Phyrexian Altar']);
  const report = mergeCombos(engine, spellbook, { status: 'ok', fetchedAt: '2026-10-25T00:00:00.000Z' });

  it('marks combos found by both sources and keeps engine-only ones', () => {
    expect(report.combos.map((c) => [c.cards.slice().sort().join(' + '), c.sources])).toEqual([
      ['Gravecrawler + Phyrexian Altar', ['spellbook', 'engine']],
      ['Exquisite Blood + Sanguine Bond', ['engine']],
    ]);
    const both = report.combos[0]!;
    expect(both.steps).toEqual(['Step one.', 'Step two.', 'Repeat.']);
    expect(both.engine?.netMana).toBe('none');
    expect(report.combos[1]!.steps.at(-1)).toBe('Repeat.');
  });

  it('turns combos into graph loops', () => {
    const reasons = comboReasons(report.combos);
    expect(reasons.filter((r) => r.from === 'Gravecrawler' || r.to === 'Gravecrawler')).toHaveLength(2);
    expect(reasons.every((r) => r.kind === 'combo')).toBe(true);
  });
});
