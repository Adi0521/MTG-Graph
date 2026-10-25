import { describe, expect, it } from 'vitest';
import { parseDecklist } from '../src/core/decklist.ts';
import { buildGraph, insights, type SynergyGraph } from '../src/core/graph.ts';
import { SAMPLE_DECK } from '../src/core/sample-deck.ts';
import { card } from './helpers.ts';

const sampleCards = () =>
  parseDecklist(SAMPLE_DECK)
    .filter((e) => e.section !== 'sideboard')
    .map((e) => card(e.name, e.quantity));

const edge = (graph: SynergyGraph, from: string, to: string) => graph.edges.find((e) => e.source === from && e.target === to);

describe('buildGraph', () => {
  const graph = buildGraph(sampleCards());

  it('excludes basic lands but keeps nonbasic lands', () => {
    expect(graph.excluded.map((c) => c.name).sort()).toEqual(['Mountain', 'Plains', 'Swamp']);
    expect(graph.nodes.some((n) => n.card.name === 'Bloodstained Mire')).toBe(true);
  });

  it('points edges from the provider to the card that uses it', () => {
    expect(edge(graph, 'Bitterblossom', 'Viscera Seer')?.kinds).toContain('sac_fodder');
    expect(edge(graph, 'Viscera Seer', 'Bitterblossom')).toBeUndefined();
    expect(edge(graph, 'Viscera Seer', 'Blood Artist')?.reasons[0]?.description).toBe(
      'Viscera Seer is a sacrifice outlet; Blood Artist pays off when creatures die',
    );
  });

  it('finds the Gravecrawler + Phyrexian Altar loop from the rules alone', () => {
    expect(edge(graph, 'Gravecrawler', 'Phyrexian Altar')?.kinds).toContain('sac_fodder');
    expect(edge(graph, 'Phyrexian Altar', 'Gravecrawler')?.kinds).toContain('mana');
  });

  it('finds Kiki-Jiki loops through copy + untap', () => {
    expect(edge(graph, 'Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts')?.kinds).toContain('etb');
    expect(edge(graph, 'Zealous Conscripts', 'Kiki-Jiki, Mirror Breaker')?.kinds).toContain('untap');
    expect(edge(graph, 'Restoration Angel', 'Kiki-Jiki, Mirror Breaker')?.kinds).toContain('untap');
  });

  it('finds tribal links but ignores token-creation text', () => {
    expect(edge(graph, 'Mogg War Marshal', 'Goblin Chieftain')?.kinds).toContain('tribal');
    expect(edge(graph, 'Carrion Feeder', 'Gravecrawler')?.kinds).toContain('tribal');
    expect(graph.edges.filter((e) => e.target === 'Young Pyromancer' && e.kinds.includes('tribal'))).toEqual([]);
  });

  it('does not treat protection from a type as caring about it', () => {
    const g = buildGraph([card('Yawgmoth, Thran Physician'), card('Grim Haruspex')], { enabledKinds: new Set(['tribal']) });
    expect(g.edges).toEqual([]);
  });

  it('is deterministic regardless of input order', () => {
    const a = buildGraph(sampleCards());
    const b = buildGraph([...sampleCards()].reverse());
    const strip = (g: SynergyGraph) => ({ edges: g.edges, nodes: g.nodes.map((n) => [n.card.name, n.inDegree, n.outDegree, n.weightedDegree]) });
    expect(strip(b)).toEqual(strip(a));
  });

  it('can filter edge kinds', () => {
    const tribalOnly = buildGraph(sampleCards(), { enabledKinds: new Set(['tribal']) });
    expect(tribalOnly.edges.length).toBeGreaterThan(0);
    expect(tribalOnly.edges.every((e) => e.kinds.every((k) => k === 'tribal'))).toBe(true);
  });
});

describe('generic two-card loops', () => {
  it('detects Sanguine Bond + Exquisite Blood without the combo list', () => {
    const g = buildGraph([card('Sanguine Bond'), card('Exquisite Blood')], { enabledKinds: new Set(['lifegain', 'drain']) });
    expect(edge(g, 'Exquisite Blood', 'Sanguine Bond')?.kinds).toEqual(['lifegain']);
    expect(edge(g, 'Sanguine Bond', 'Exquisite Blood')?.kinds).toEqual(['drain']);
  });

  it('detects Splinter Twin + Pestermite without the combo list', () => {
    const g = buildGraph([card('Splinter Twin'), card('Pestermite')], { enabledKinds: new Set(['etb', 'untap']) });
    expect(edge(g, 'Splinter Twin', 'Pestermite')?.kinds).toEqual(['etb']);
    expect(edge(g, 'Pestermite', 'Splinter Twin')?.kinds).toEqual(['untap']);
  });
});

describe('insights', () => {
  it('ranks sacrifice outlets among the key cards of an aristocrats deck', () => {
    const result = insights(buildGraph(sampleCards()));
    const keyNames = result.keyCards.map((n) => n.name);
    expect(keyNames.some((n) => ['Viscera Seer', 'Phyrexian Altar', "Ashnod's Altar", 'Goblin Bombardment', 'Carrion Feeder'].includes(n))).toBe(true);
    expect(result.connectivity).toBeGreaterThan(0.8);
  });

  it('reports payoffs with nothing feeding them', () => {
    const result = insights(buildGraph([card('Lotus Cobra'), card('Lightning Bolt')]));
    expect(result.unsupported.map((u) => u.kind)).toContain('landfall');
  });
});
