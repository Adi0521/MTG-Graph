import { describe, expect, it } from 'vitest';
import type { SynergyEdge } from '../src/core/graph.ts';
import { parseDecklist } from '../src/core/decklist.ts';
import { findEngineCombos } from '../src/core/combo-engine.ts';
import { comboReasons, mergeCombos } from '../src/core/combos.ts';
import { buildGraph } from '../src/core/graph.ts';
import { SAMPLE_COMMANDER_DECK } from '../src/core/sample-commander.ts';
import { SAMPLE_DECK } from '../src/core/sample-deck.ts';
import { analyzeStructures, normalizeOptions } from '../src/core/structures.ts';
import { card } from './helpers.ts';

/** Build synthetic edges from "A>B" strings, all weight 1 unless given as "A>B:3". */
function edges(...specs: string[]): SynergyEdge[] {
  return specs.map((spec) => {
    const [pair, w] = spec.split(':');
    const [source, target] = pair!.split('>') as [string, string];
    const weight = w ? Number(w) : 1;
    return {
      id: `${source} -> ${target}`,
      source,
      target,
      weight,
      kinds: ['tokens'],
      reasons: [{ kind: 'tokens', from: source, to: target, description: `${source} feeds ${target}`, weight }],
    };
  });
}

function complete(n: number): { names: string[]; edges: SynergyEdge[] } {
  const names = Array.from({ length: n }, (_, i) => `C${i}`);
  const specs: string[] = [];
  for (const a of names) for (const b of names) if (a !== b) specs.push(`${a}>${b}`);
  return { names, edges: edges(...specs) };
}

describe('loop search', () => {
  it('finds every elementary cycle of a complete digraph exactly once', () => {
    // K4 has C(4,2)*1! + C(4,3)*2! + C(4,4)*3! = 6 + 8 + 6 = 20 cycles.
    const { names, edges: e } = complete(4);
    const s = analyzeStructures(names, e, { maxLoops: 1000 });
    expect(s.loopSearch).toEqual({ found: 20, exhaustive: true, byLength: { 2: 6, 3: 8, 4: 6 } });
    const keys = s.loops.map((l) => l.cards.join(','));
    expect(new Set(keys).size).toBe(20);
  });

  it('respects the loop length window', () => {
    const { names, edges: e } = complete(5);
    const s = analyzeStructures(names, e, { minLoopLength: 4, maxLoopLength: 4, maxLoops: 1000 });
    // C(5,4) * 3! = 30 four-card cycles.
    expect(s.loopSearch.found).toBe(30);
    expect(s.loops.every((l) => l.length === 4)).toBe(true);
  });

  it('finds long loops (a 15-card ring)', () => {
    const names = Array.from({ length: 15 }, (_, i) => `R${String(i).padStart(2, '0')}`);
    const ring = edges(...names.map((n, i) => `${n}>${names[(i + 1) % names.length]}`));
    const s = analyzeStructures(names, ring, { maxLoopLength: 20 });
    expect(s.loops).toHaveLength(1);
    expect(s.loops[0]!.length).toBe(15);
    expect(s.loops[0]!.steps.at(-1)).toMatchObject({ from: 'R14', to: 'R00' });
    // Too short a limit finds nothing.
    expect(analyzeStructures(names, ring, { maxLoopLength: 14 }).loops).toHaveLength(0);
  });

  it('ranks heavier loops first and keeps only maxLoops', () => {
    const s = analyzeStructures(['A', 'B', 'C'], edges('A>B:5', 'B>A:5', 'B>C', 'C>A'), { maxLoops: 1 });
    expect(s.loops.map((l) => l.cards)).toEqual([['A', 'B']]);
    expect(s.loopSearch.found).toBe(2);
  });

  it('reports a non-exhaustive search when the budget runs out', () => {
    const { names, edges: e } = complete(9);
    const s = analyzeStructures(names, e, { searchBudget: 10_000 });
    expect(s.loopSearch.exhaustive).toBe(false);
    expect(s.loops.length).toBeGreaterThan(0);
  });

  it('ignores edges below minEdgeWeight', () => {
    const s = analyzeStructures(['A', 'B'], edges('A>B:1', 'B>A:3'), { minEdgeWeight: 2 });
    expect(s.loops).toHaveLength(0);
  });
});

describe('loop systems, chains and trees', () => {
  // Source -> {A <-> B <-> C} -> Sink, plus an isolated card.
  const names = ['A', 'B', 'C', 'Lonely', 'Sink', 'Source'];
  const e = edges('Source>A', 'A>B', 'B>A', 'B>C', 'C>B', 'C>Sink');
  const s = analyzeStructures(names, e);

  it('groups mutually reachable cards into loop systems', () => {
    expect(s.loopSystems).toHaveLength(1);
    expect(s.loopSystems[0]).toMatchObject({ cards: ['A', 'B', 'C'], internalEdges: 4, feeders: ['Source'], outputs: ['Sink'] });
  });

  it('finds chains through the loop systems', () => {
    expect(s.chains).toEqual([
      {
        stages: [
          { cards: ['Source'], loopSystem: null },
          { cards: ['A', 'B', 'C'], loopSystem: 0 },
          { cards: ['Sink'], loopSystem: null },
        ],
        cardCount: 5,
      },
    ]);
  });

  it('builds downstream and upstream trees', () => {
    expect(s.trees.Source!.downstream).toEqual([
      ['Source', 'A'],
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'Sink'],
    ]);
    expect(s.trees.Source!.downstreamDepth).toBe(4);
    expect(s.trees.Sink!.upstream.map(([, child]) => child)).toEqual(['C', 'B', 'A', 'Source']);
    expect(s.trees.Lonely).toEqual({ downstream: [], downstreamDepth: 0, upstream: [], upstreamDepth: 0 });
  });

  it('finds load-bearing cards and critical links', () => {
    expect(s.clusters).toEqual([['A', 'B', 'C', 'Sink', 'Source']]);
    expect(s.loadBearing.map((l) => l.card)).toEqual(['B', 'A', 'C']);
    expect(s.loadBearing[0]).toEqual({ card: 'B', splitsInto: [2, 2] });
    expect(s.criticalLinks).toEqual([{ between: ['A', 'B'], splitsInto: [3, 2] }, { between: ['B', 'C'], splitsInto: [3, 2] }]);
  });
});

describe('sample deck structures', () => {
  const cards = parseDecklist(SAMPLE_DECK)
    .filter((e) => e.section !== 'sideboard')
    .map((e) => card(e.name, e.quantity));
  // Combo links come from the combo engine (no network in tests).
  const combos = mergeCombos(findEngineCombos(cards), null, { status: 'disabled' });
  const graph = buildGraph(cards, { extraReasons: comboReasons(combos.combos) });
  const names = graph.nodes.map((n) => n.card.name);

  it('finds known combos as two-card loops', () => {
    const s = analyzeStructures(names, graph.edges, { maxLoopLength: 2 });
    const pairs = s.loops.map((l) => l.cards.join(' + '));
    expect(pairs).toContain('Gravecrawler + Phyrexian Altar');
    expect(pairs).toContain('Kiki-Jiki, Mirror Breaker + Zealous Conscripts');
    expect(s.loops.find((l) => l.cards.includes('Zealous Conscripts'))!.knownCombo).toBe(true);
  });

  it('reports when the deck has no loops that long (exhaustive search)', () => {
    const s = analyzeStructures(names, graph.edges, { minLoopLength: 10, maxLoopLength: 20 });
    expect(s.loopSystems[0]!.cards.length).toBeLessThan(10);
    expect(s.loopSearch).toMatchObject({ found: 0, exhaustive: true });
  });

  it('is deterministic', () => {
    const a = analyzeStructures(names, graph.edges, { maxLoopLength: 12 });
    const b = analyzeStructures([...names], [...graph.edges].reverse(), { maxLoopLength: 12 });
    expect(b).toEqual(a);
  });
});

describe('commander deck structures', () => {
  const cards = parseDecklist(SAMPLE_COMMANDER_DECK)
    .filter((e) => e.section !== 'sideboard')
    .map((e) => card(e.name, e.quantity));
  const graph = buildGraph(cards);
  const names = graph.nodes.map((n) => n.card.name);

  it('finds long loops of 10-20 cards', () => {
    const s = analyzeStructures(names, graph.edges, { minLoopLength: 10, maxLoopLength: 20, maxLoops: 25 });
    expect(s.loopSystems[0]!.cards.length).toBeGreaterThanOrEqual(20);
    expect(s.loops.length).toBe(25);
    for (const loop of s.loops) {
      expect(loop.length).toBeGreaterThanOrEqual(10);
      expect(loop.length).toBeLessThanOrEqual(20);
      expect(new Set(loop.cards).size).toBe(loop.length); // elementary: no card repeats
      for (const step of loop.steps) expect(graph.edges.some((e) => e.source === step.from && e.target === step.to)).toBe(true);
      expect(loop.steps.at(-1)!.to).toBe(loop.cards[0]);
    }
  });
});

describe('normalizeOptions', () => {
  it('clamps out-of-range values', () => {
    expect(normalizeOptions({ maxLoopLength: 99, minLoopLength: 50, maxLoops: 0 })).toMatchObject({ maxLoopLength: 30, minLoopLength: 30, maxLoops: 1 });
  });
});
