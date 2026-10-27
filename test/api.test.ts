import { describe, expect, it } from 'vitest';
import { createApp, UpstreamError } from '../server/app.ts';
import type { AnalysisResult, CardSource, KnownComboSource } from '../src/core/analyze.ts';
import { mapSpellbookResults } from '../src/core/spellbook.ts';
import type { ScryfallCard } from '../src/core/types.ts';
import { FIXTURES } from './helpers.ts';

/** Card source backed by the offline fixtures, so API tests never hit the network. */
const fixtureSource: CardSource = async (names) => {
  const cards = new Map<string, ScryfallCard>();
  const notFound: string[] = [];
  for (const name of names) {
    const raw = FIXTURES[name] ?? Object.values(FIXTURES).find((c) => c.name.split(' // ')[0] === name);
    if (raw) cards.set(name.toLowerCase(), raw);
    else notFound.push(name);
  }
  return { cards, notFound };
};

/** A Spellbook stand-in that knows one combo. */
const spellbookSource: KnownComboSource = async (entries) => ({
  fetchedAt: '2026-10-25T00:00:00.000Z',
  result: mapSpellbookResults(
    {
      included: entries.some((e) => e.name === 'Gravecrawler')
        ? [{ id: 'sb-1', uses: [{ card: { name: 'Gravecrawler' } }, { card: { name: 'Phyrexian Altar' } }], produces: [{ feature: { name: 'Infinite death triggers' } }], description: 'Sac.\nRecast.' }]
        : [],
    },
    entries.map((e) => e.name),
  ),
});

const app = createApp({ cardSource: fixtureSource, knownComboSource: spellbookSource });

const postJson = (body: unknown) =>
  app.request('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/analyze', () => {
  it('analyzes a typed decklist', async () => {
    const res = await postJson({ decklist: '4 Gravecrawler\n2 Phyrexian Altar\n1 Not A Real Card\n10 Swamp', options: { maxLoopLength: 4 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalysisResult;
    expect(body.deck).toMatchObject({ totalCards: 16, uniqueCards: 3, notFound: ['Not A Real Card'], basicLands: ['Swamp'] });
    expect(body.structures.loops.map((l) => l.cards)).toContainEqual(['Gravecrawler', 'Phyrexian Altar']);
    expect(body.structures.options.maxLoopLength).toBe(4);
    expect(body.cards.find((c) => c.name === 'Gravecrawler')!.provides).toHaveProperty('sac_fodder');
  });

  it('accepts an uploaded .dek file', async () => {
    const form = new FormData();
    const xml = '<?xml version="1.0"?><Deck><Cards Quantity="1" Sideboard="false" Name="Sanguine Bond" /><Cards Quantity="1" Sideboard="false" Name="Exquisite Blood" /></Deck>';
    form.set('deck', new File([xml], 'combo.dek'));
    form.set('options', JSON.stringify({ maxLoopLength: 2 }));
    const res = await app.request('/api/analyze', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalysisResult;
    expect(body.structures.loops).toHaveLength(1);
    expect(body.structures.loops[0]!.knownCombo).toBe(true);
    // The rules find the loop on their own too, not just via the curated combo list.
    expect(body.edges.find((e) => e.source === 'Sanguine Bond')!.kinds).toContain('drain');
    expect(body.edges.find((e) => e.source === 'Exquisite Blood')!.kinds).toContain('lifegain');
  });

  it('returns the same result for the same deck', async () => {
    const deck = { decklist: '4 Viscera Seer\n4 Blood Artist\n2 Bitterblossom\n2 Pitiless Plunderer\n2 Gravecrawler\n1 Phyrexian Altar' };
    const analyze = async () => (await postJson(deck)).json();
    const [a, b] = await Promise.all([analyze(), analyze()]);
    expect(a).toEqual(b);
  });

  it('rejects bad input', async () => {
    expect((await postJson({ decklist: '' })).status).toBe(400);
    expect((await postJson({ decklist: '1 Sol Ring', options: { maxLoopLength: 'long' } })).status).toBe(400);
    expect((await postJson({ decklist: '1 Sol Ring', enabledKinds: ['nonsense'] })).status).toBe(400);
    const res = await app.request('/api/analyze', { method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain' } });
    expect(res.status).toBe(400);
  });

  it('maps upstream failures to 502', async () => {
    const failing = createApp({
      cardSource: async () => {
        throw new UpstreamError('Scryfall is down');
      },
    });
    const res = await failing.request('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decklist: '1 Sol Ring' }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Scryfall is down' });
  });
});

describe('combos in the analysis', () => {
  it('reports combos from both sources and links them in the graph', async () => {
    const res = await postJson({ decklist: '1 Gravecrawler\n1 Phyrexian Altar\n1 Sanguine Bond\n1 Exquisite Blood' });
    const body = (await res.json()) as AnalysisResult;
    expect(body.combos.spellbook).toEqual({ status: 'ok', fetchedAt: '2026-10-25T00:00:00.000Z' });
    expect(body.combos.combos.map((c) => c.sources)).toEqual([['spellbook', 'engine'], ['engine']]);
    expect(body.edges.find((e) => e.source === 'Gravecrawler' && e.target === 'Phyrexian Altar')!.kinds).toContain('combo');
  });

  it('still analyzes when Spellbook is down', async () => {
    const failing = createApp({
      cardSource: fixtureSource,
      knownComboSource: async () => {
        throw new Error('timeout');
      },
    });
    const res = await failing.request('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decklist: '1 Gravecrawler\n1 Phyrexian Altar' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalysisResult;
    expect(body.combos.spellbook).toEqual({ status: 'unavailable', error: 'timeout' });
    expect(body.combos.conditional.map((c) => c.sources)).toEqual([['engine']]);
  });

  it('can skip Spellbook per request', async () => {
    const body = (await (await postJson({ decklist: '1 Gravecrawler\n1 Phyrexian Altar', spellbook: false })).json()) as AnalysisResult;
    expect(body.combos.spellbook.status).toBe('disabled');
    expect((await postJson({ decklist: '1 Gravecrawler', spellbook: 'yes' })).status).toBe(400);
  });
});

describe('GET /api/rules', () => {
  it('lists every theme and its matchers', async () => {
    const body = (await (await app.request('/api/rules')).json()) as { themes: { id: string; provides: string[] }[] };
    expect(body.themes.map((t) => t.id)).toContain('untap');
    expect(body.themes.every((t) => t.provides.length > 0)).toBe(true);
  });
});
