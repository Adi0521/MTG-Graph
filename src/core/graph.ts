import { COMBOS } from './combos.ts';
import { THEMES, THEME_BY_ID, tagCard, type CardTags, type ThemeId } from './rules.ts';
import { hasType, pluralize, referencedTypes } from './tribal.ts';
import type { Card } from './types.ts';

export type EdgeKind = ThemeId | 'tribal' | 'combo';

export const TRIBAL_WEIGHT = 3;
export const COMBO_WEIGHT = 8;

export const EDGE_KIND_META: Record<EdgeKind, { label: string; color: string }> = {
  ...Object.fromEntries(THEMES.map((t) => [t.id, { label: t.label, color: t.color }])),
  tribal: { label: 'Tribal', color: '#a0522d' },
  combo: { label: 'Known combo', color: '#ffd700' },
} as Record<EdgeKind, { label: string; color: string }>;

/** One reason why `from` feeds `to`. */
export interface SynergyReason {
  kind: EdgeKind;
  from: string;
  to: string;
  description: string;
  weight: number;
}

/** Directed edge: `source` provides something `target` uses. Aggregates every reason for the ordered pair. */
export interface SynergyEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  reasons: SynergyReason[];
  kinds: EdgeKind[];
}

export interface CardNode {
  card: Card;
  tags: CardTags;
  inDegree: number;
  outDegree: number;
  /** Number of distinct cards linked in either direction. */
  degree: number;
  /** Sum of the weights of all edges touching this card. */
  weightedDegree: number;
}

export interface ThemeSummary {
  kind: ThemeId;
  providers: string[];
  wanters: string[];
  edgeCount: number;
}

export interface SynergyGraph {
  nodes: CardNode[];
  edges: SynergyEdge[];
  /** Basic lands, left out of the graph. */
  excluded: Card[];
  themes: ThemeSummary[];
}

function isExcluded(card: Card): boolean {
  return /\bBasic\b.*\bLand\b/.test(card.typeLine);
}

export const edgeId = (from: string, to: string) => `${from} -> ${to}`;

/** Build the directed synergy graph. Output depends only on the input cards, never on input order. */
export function buildGraph(inputCards: Card[], options: { enabledKinds?: Set<EdgeKind> } = {}): SynergyGraph {
  const enabled = (k: EdgeKind) => !options.enabledKinds || options.enabledKinds.has(k);
  const sorted = [...inputCards].sort((a, b) => a.name.localeCompare(b.name));
  const excluded = sorted.filter(isExcluded);
  const cards = sorted.filter((c) => !isExcluded(c));
  const tags = new Map(cards.map((c) => [c.name, tagCard(c)]));

  const reasons: SynergyReason[] = [];

  // Theme edges: provider → wanter.
  for (const theme of THEMES) {
    if (!enabled(theme.id)) continue;
    for (const from of cards) {
      const provided = tags.get(from.name)!.provides.get(theme.id);
      if (!provided) continue;
      for (const to of cards) {
        if (to === from) continue;
        const wanted = tags.get(to.name)!.wants.get(theme.id);
        if (!wanted) continue;
        reasons.push({
          kind: theme.id,
          from: from.name,
          to: to.name,
          description: `${from.name} ${provided[0]}; ${to.name} ${wanted[0]}`,
          weight: theme.weight,
        });
      }
    }
  }

  // Tribal edges: a card of type T → a card whose text cares about T.
  if (enabled('tribal')) {
    const deckTypes = [...new Set(cards.flatMap((c) => c.creatureTypes))].sort();
    for (const to of cards) {
      for (const type of referencedTypes(to, deckTypes)) {
        for (const from of cards) {
          if (from === to || !hasType(from, type)) continue;
          reasons.push({
            kind: 'tribal',
            from: from.name,
            to: to.name,
            description: `${from.name} is a ${type}; ${to.name} cares about ${pluralize(type)}`,
            weight: TRIBAL_WEIGHT,
          });
        }
      }
    }
  }

  // Curated combos work both ways, so they form a two-card loop.
  if (enabled('combo')) {
    const names = new Set(cards.map((c) => c.name));
    for (const combo of COMBOS) {
      const [a, b] = combo.cards;
      if (!names.has(a) || !names.has(b)) continue;
      for (const [from, to] of [[a, b], [b, a]] as const) {
        if (reasons.some((r) => r.kind === 'combo' && r.from === from && r.to === to)) continue;
        reasons.push({ kind: 'combo', from, to, description: `Combo with ${to}: ${combo.result}`, weight: COMBO_WEIGHT });
      }
    }
  }

  // Merge reasons into one directed edge per ordered pair.
  const edgeMap = new Map<string, SynergyEdge>();
  for (const r of reasons) {
    const id = edgeId(r.from, r.to);
    let edge = edgeMap.get(id);
    if (!edge) {
      edge = { id, source: r.from, target: r.to, weight: 0, reasons: [], kinds: [] };
      edgeMap.set(id, edge);
    }
    edge.reasons.push(r);
    edge.weight += r.weight;
    if (!edge.kinds.includes(r.kind)) edge.kinds.push(r.kind);
  }
  const edges = [...edgeMap.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  for (const e of edges) e.reasons.sort((a, b) => b.weight - a.weight || a.kind.localeCompare(b.kind));

  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const weighted = new Map<string, number>();
  const neighbors = new Map<string, Set<string>>(cards.map((c) => [c.name, new Set()]));
  for (const e of edges) {
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    for (const n of [e.source, e.target]) weighted.set(n, (weighted.get(n) ?? 0) + e.weight);
    neighbors.get(e.source)!.add(e.target);
    neighbors.get(e.target)!.add(e.source);
  }

  const nodes: CardNode[] = cards.map((card) => ({
    card,
    tags: tags.get(card.name)!,
    inDegree: inDeg.get(card.name) ?? 0,
    outDegree: outDeg.get(card.name) ?? 0,
    degree: neighbors.get(card.name)!.size,
    weightedDegree: weighted.get(card.name) ?? 0,
  }));

  const themes = THEMES.map((theme) => ({
    kind: theme.id,
    providers: nodes.filter((n) => n.tags.provides.has(theme.id)).map((n) => n.card.name),
    wanters: nodes.filter((n) => n.tags.wants.has(theme.id)).map((n) => n.card.name),
    edgeCount: edges.filter((e) => e.kinds.includes(theme.id)).length,
  }));

  return { nodes, edges, excluded, themes };
}

export interface DeckInsights {
  keyCards: { name: string; degree: number; weightedDegree: number }[];
  isolated: string[];
  /** Themes with payoffs in the deck but nothing feeding them. */
  unsupported: { kind: ThemeId; label: string; wanters: string[] }[];
  /** Fraction of non-land cards with at least one synergy edge. */
  connectivity: number;
}

export function insights(graph: SynergyGraph, topN = 8): DeckInsights {
  const keyCards = [...graph.nodes]
    .filter((n) => n.degree > 0)
    .sort((a, b) => b.weightedDegree - a.weightedDegree || a.card.name.localeCompare(b.card.name))
    .slice(0, topN)
    .map((n) => ({ name: n.card.name, degree: n.degree, weightedDegree: n.weightedDegree }));
  const nonLand = graph.nodes.filter((n) => !/\bLand\b/.test(n.card.typeLine));
  const isolated = nonLand.filter((n) => n.degree === 0).map((n) => n.card.name);
  const unsupported = graph.themes
    .filter((t) => t.wanters.length > 0 && t.edgeCount === 0)
    .map((t) => ({ kind: t.kind, label: THEME_BY_ID.get(t.kind)!.label, wanters: t.wanters }));
  const connectivity = nonLand.length ? (nonLand.length - isolated.length) / nonLand.length : 0;
  return { keyCards, isolated, unsupported, connectivity };
}
