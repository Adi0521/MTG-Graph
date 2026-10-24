import type { EdgeKind, SynergyEdge } from './graph.ts';

/**
 * Structural analysis of the directed synergy graph. Everything here is plain
 * graph theory over integer indices, with work bounded by a step budget (not a
 * clock), so the same graph and options always produce the same result.
 */

export interface StructureOptions {
  /** Shortest loop to report (2 = two cards feeding each other). */
  minLoopLength: number;
  /** Longest loop to search for. */
  maxLoopLength: number;
  /** How many loops to return (the best-scoring ones). */
  maxLoops: number;
  /** Upper bound on DFS steps for loop search, shared evenly across start cards. */
  searchBudget: number;
  /** Ignore edges lighter than this when finding loops, trees and chains. */
  minEdgeWeight: number;
}

export const DEFAULT_STRUCTURE_OPTIONS: StructureOptions = {
  minLoopLength: 2,
  maxLoopLength: 20,
  maxLoops: 100,
  searchBudget: 2_000_000,
  minEdgeWeight: 0,
};

export const MAX_LOOP_LENGTH_LIMIT = 30;

export interface LoopStep {
  from: string;
  to: string;
  kind: EdgeKind;
  description: string;
}

export interface Loop {
  cards: string[];
  length: number;
  weight: number;
  meanWeight: number;
  steps: LoopStep[];
  /** True when the loop is exactly a curated two-card combo. */
  knownCombo: boolean;
}

export interface LoopSearchSummary {
  /** Loops found within the length range (all of them when `exhaustive`). */
  found: number;
  /** False when the step budget ran out, so more loops may exist. */
  exhaustive: boolean;
  /** Loops found per length, e.g. { "2": 4, "3": 9 }. */
  byLength: Record<string, number>;
}

/** A strongly connected component: every card in it can reach every other, so every loop lives inside one. */
export interface LoopSystem {
  id: number;
  cards: string[];
  internalEdges: number;
  /** Fraction of possible directed edges present. */
  density: number;
  kinds: { kind: EdgeKind; count: number }[];
  /** Cards outside the system that feed into it. */
  feeders: string[];
  /** Cards outside the system that it feeds. */
  outputs: string[];
}

/** Shortest-path tree from a root, as [parent, child] pairs. */
export interface CardTrees {
  /** What this card powers, directly and transitively. */
  downstream: [string, string][];
  downstreamDepth: number;
  /** What powers this card, directly and transitively. */
  upstream: [string, string][];
  upstreamDepth: number;
}

/** A path through the DAG of loop systems: raw enablers → engines → payoffs. */
export interface Chain {
  /** Each stage is a single card or a whole loop system. */
  stages: { cards: string[]; loopSystem: number | null }[];
  cardCount: number;
}

export interface LoadBearingCard {
  card: string;
  /** Sizes of the pieces its synergy cluster splits into without it. */
  splitsInto: number[];
}

export interface CriticalLink {
  between: [string, string];
  splitsInto: number[];
}

export interface Structures {
  options: StructureOptions;
  loopSystems: LoopSystem[];
  loops: Loop[];
  loopSearch: LoopSearchSummary;
  trees: Record<string, CardTrees>;
  chains: Chain[];
  clusters: string[][];
  loadBearing: LoadBearingCard[];
  criticalLinks: CriticalLink[];
}

interface IndexedGraph {
  names: string[];
  out: number[][];
  in: number[][];
  edge: Map<number, SynergyEdge>;
}

const pairKey = (a: number, b: number) => a * 65536 + b;

function indexGraph(names: string[], edges: SynergyEdge[], minEdgeWeight: number): IndexedGraph {
  const index = new Map(names.map((n, i) => [n, i]));
  const out: number[][] = names.map(() => []);
  const inn: number[][] = names.map(() => []);
  const edge = new Map<number, SynergyEdge>();
  for (const e of edges) {
    if (e.weight < minEdgeWeight) continue;
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined) continue;
    out[s]!.push(t);
    inn[t]!.push(s);
    edge.set(pairKey(s, t), e);
  }
  // Strongest links first so BFS trees prefer them; ties by name for determinism.
  const byWeight = (from: number, list: number[], forward: boolean) =>
    list.sort((a, b) => {
      const wa = edge.get(forward ? pairKey(from, a) : pairKey(a, from))!.weight;
      const wb = edge.get(forward ? pairKey(from, b) : pairKey(b, from))!.weight;
      return wb - wa || a - b;
    });
  out.forEach((l, i) => byWeight(i, l, true));
  inn.forEach((l, i) => byWeight(i, l, false));
  return { names, out, in: inn, edge };
}

// ---------------------------------------------------------------------------
// Strongly connected components (iterative Tarjan)

function stronglyConnected(g: IndexedGraph): number[][] {
  const n = g.names.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const result: number[][] = [];
  let counter = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: [number, number][] = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1]!;
      const [v, i] = frame;
      if (i === 0) {
        index[v] = low[v] = counter++;
        stack.push(v);
        onStack[v] = true;
      }
      const neighbors = g.out[v]!;
      if (i < neighbors.length) {
        frame[1]++;
        const w = neighbors[i]!;
        if (index[w] === -1) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]![0];
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        const component: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          component.push(w);
        } while (w !== v);
        result.push(component.sort((a, b) => a - b));
      }
    }
  }
  return result; // Reverse topological order of the condensation.
}

// ---------------------------------------------------------------------------
// Elementary cycles

interface RawLoop {
  nodes: number[];
  weight: number;
}

function loopScore(l: RawLoop) {
  return l.weight / l.nodes.length;
}

/** Better loops first: higher mean weight, then longer, then lexicographic node order. */
function compareLoops(a: RawLoop, b: RawLoop): number {
  return loopScore(b) - loopScore(a) || b.nodes.length - a.nodes.length || compareArrays(a.nodes, b.nodes);
}

function compareArrays(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * Enumerate elementary cycles within each SCC. Each cycle is found exactly once,
 * from its lowest-index card. A reverse-BFS distance table prunes paths that
 * cannot return to the start within the length limit. Keeps the best `maxLoops`.
 */
function findLoops(g: IndexedGraph, sccs: number[][], opts: StructureOptions): { loops: RawLoop[]; summary: LoopSearchSummary } {
  const { minLoopLength, maxLoopLength, maxLoops } = opts;
  const starts = sccs.filter((c) => c.length > 1).reduce((n, c) => n + c.length, 0);
  const budgetPerStart = starts ? Math.max(1000, Math.floor(opts.searchBudget / starts)) : 0;
  const best: RawLoop[] = [];
  const byLength: Record<string, number> = {};
  let found = 0;
  let exhaustive = true;

  const keep = (loop: RawLoop) => {
    found++;
    byLength[loop.nodes.length] = (byLength[loop.nodes.length] ?? 0) + 1;
    if (best.length === maxLoops && compareLoops(loop, best[best.length - 1]!) >= 0) return;
    let lo = 0;
    let hi = best.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareLoops(best[mid]!, loop) <= 0) lo = mid + 1;
      else hi = mid;
    }
    best.splice(lo, 0, { nodes: [...loop.nodes], weight: loop.weight });
    if (best.length > maxLoops) best.pop();
  };

  for (const scc of sccs) {
    if (scc.length < 2) continue;
    const inScc = new Set(scc);
    for (const s of scc) {
      // Distance from each allowed node back to s, using only nodes > s in this SCC.
      const dist = new Map<number, number>([[s, 0]]);
      const queue = [s];
      for (let qi = 0; qi < queue.length; qi++) {
        const v = queue[qi]!;
        for (const u of g.in[v]!) {
          if (u > s && inScc.has(u) && !dist.has(u)) {
            dist.set(u, dist.get(v)! + 1);
            queue.push(u);
          }
        }
      }

      let steps = 0;
      const path = [s];
      const onPath = new Set([s]);
      // Iterative DFS: each frame is [node, next neighbor index, weight so far].
      const frames: [number, number, number][] = [[s, 0, 0]];
      while (frames.length) {
        const frame = frames[frames.length - 1]!;
        const [v, i, weight] = frame;
        const neighbors = g.out[v]!;
        if (i >= neighbors.length) {
          frames.pop();
          path.pop();
          onPath.delete(v);
          continue;
        }
        frame[1]++;
        if (++steps > budgetPerStart) {
          exhaustive = false;
          break;
        }
        const w = neighbors[i]!;
        const ew = g.edge.get(pairKey(v, w))!.weight;
        if (w === s) {
          if (path.length >= minLoopLength && path.length <= maxLoopLength) keep({ nodes: path, weight: weight + ew });
          continue;
        }
        const d = dist.get(w);
        if (d === undefined || onPath.has(w) || path.length + d > maxLoopLength) continue;
        path.push(w);
        onPath.add(w);
        frames.push([w, 0, weight + ew]);
      }
    }
  }
  return { loops: best, summary: { found, exhaustive, byLength } };
}

// ---------------------------------------------------------------------------
// Trees, chains, clusters, cut vertices

function bfsTree(g: IndexedGraph, root: number, forward: boolean): { pairs: [string, string][]; depth: number } {
  const depth = new Map<number, number>([[root, 0]]);
  const pairs: [string, string][] = [];
  const queue = [root];
  let maxDepth = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi]!;
    for (const w of forward ? g.out[v]! : g.in[v]!) {
      if (depth.has(w)) continue;
      const d = depth.get(v)! + 1;
      depth.set(w, d);
      maxDepth = Math.max(maxDepth, d);
      pairs.push([g.names[v]!, g.names[w]!]);
      queue.push(w);
    }
  }
  return { pairs, depth: maxDepth };
}

function longestChains(g: IndexedGraph, sccs: number[][], systemIdOf: Map<number, number>, limit = 10): Chain[] {
  // Tarjan returns SCCs in reverse topological order; flip to get sources first.
  const topo = [...sccs].reverse();
  const compOf = new Map<number, number>();
  topo.forEach((c, i) => c.forEach((v) => compOf.set(v, i)));
  const succ: Set<number>[] = topo.map(() => new Set());
  const hasPred = new Array<boolean>(topo.length).fill(false);
  for (let v = 0; v < g.names.length; v++) {
    for (const w of g.out[v]!) {
      const a = compOf.get(v)!;
      const b = compOf.get(w)!;
      if (a !== b) {
        succ[a]!.add(b);
        hasPred[b] = true;
      }
    }
  }
  // Longest path (by card count) from each component, computed sinks-first.
  const best = new Array<number>(topo.length).fill(0);
  const next = new Array<number>(topo.length).fill(-1);
  for (let i = topo.length - 1; i >= 0; i--) {
    let bestNext = -1;
    for (const j of [...succ[i]!].sort((a, b) => a - b)) if (bestNext === -1 || best[j]! > best[bestNext]!) bestNext = j;
    best[i] = topo[i]!.length + (bestNext === -1 ? 0 : best[bestNext]!);
    next[i] = bestNext;
  }
  const chains: Chain[] = [];
  for (let i = 0; i < topo.length; i++) {
    if (hasPred[i] || succ[i]!.size === 0) continue;
    const stages: Chain['stages'] = [];
    for (let c = i; c !== -1; c = next[c]!) {
      const members = topo[c]!;
      stages.push({
        cards: members.map((v) => g.names[v]!),
        loopSystem: members.length > 1 ? systemIdOf.get(members[0]!)! : null,
      });
    }
    if (stages.length > 1) chains.push({ stages, cardCount: best[i]! });
  }
  return chains
    .sort((a, b) => b.cardCount - a.cardCount || b.stages.length - a.stages.length || a.stages[0]!.cards[0]!.localeCompare(b.stages[0]!.cards[0]!))
    .slice(0, limit);
}

/** Weakly connected components, ignoring `removedNode` and `removedPair`. */
function clustersOf(g: IndexedGraph, removedNode = -1, removedPair: [number, number] | null = null): number[][] {
  const n = g.names.length;
  const seen = new Array<boolean>(n).fill(false);
  const result: number[][] = [];
  const isRemovedPair = (a: number, b: number) =>
    removedPair !== null && ((removedPair[0] === a && removedPair[1] === b) || (removedPair[0] === b && removedPair[1] === a));
  for (let start = 0; start < n; start++) {
    if (seen[start] || start === removedNode) continue;
    const members: number[] = [];
    const queue = [start];
    seen[start] = true;
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi]!;
      members.push(v);
      for (const w of [...g.out[v]!, ...g.in[v]!]) {
        if (seen[w] || w === removedNode || isRemovedPair(v, w)) continue;
        seen[w] = true;
        queue.push(w);
      }
    }
    result.push(members.sort((a, b) => a - b));
  }
  return result;
}

const multiCardSizes = (clusters: number[][]) => clusters.map((c) => c.length).sort((a, b) => b - a);

function cutVertices(g: IndexedGraph, clusters: number[][]): LoadBearingCard[] {
  const result: LoadBearingCard[] = [];
  const clusterOf = new Map<number, number>();
  clusters.forEach((c, i) => c.forEach((v) => clusterOf.set(v, i)));
  for (let v = 0; v < g.names.length; v++) {
    const own = clusters[clusterOf.get(v) ?? -1];
    if (!own || own.length < 3) continue;
    const ownSet = new Set(own);
    const pieces = clustersOf(g, v).filter((c) => ownSet.has(c[0]!));
    if (pieces.length > 1) result.push({ card: g.names[v]!, splitsInto: multiCardSizes(pieces) });
  }
  return result.sort((a, b) => (b.splitsInto[1] ?? 0) - (a.splitsInto[1] ?? 0) || a.card.localeCompare(b.card));
}

function bridges(g: IndexedGraph, clusters: number[][]): CriticalLink[] {
  const result: CriticalLink[] = [];
  const clusterOf = new Map<number, number>();
  clusters.forEach((c, i) => c.forEach((v) => clusterOf.set(v, i)));
  const seen = new Set<number>();
  for (let v = 0; v < g.names.length; v++) {
    for (const w of [...g.out[v]!, ...g.in[v]!]) {
      const [a, b] = v < w ? [v, w] : [w, v];
      if (seen.has(pairKey(a, b))) continue;
      seen.add(pairKey(a, b));
      const ownSet = new Set(clusters[clusterOf.get(a)!]!);
      const pieces = clustersOf(g, -1, [a, b]).filter((c) => ownSet.has(c[0]!));
      // Only report links whose loss strands more than a single card.
      if (pieces.length > 1 && Math.min(...pieces.map((p) => p.length)) > 1) {
        result.push({ between: [g.names[a]!, g.names[b]!], splitsInto: multiCardSizes(pieces) });
      }
    }
  }
  return result.sort((x, y) => (y.splitsInto[1] ?? 0) - (x.splitsInto[1] ?? 0) || x.between[0].localeCompare(y.between[0]));
}

// ---------------------------------------------------------------------------

export function analyzeStructures(names: string[], edges: SynergyEdge[], partial: Partial<StructureOptions> = {}): Structures {
  const options = normalizeOptions(partial);
  const g = indexGraph(names, edges, options.minEdgeWeight);
  const sccs = stronglyConnected(g);

  const systems = sccs
    .filter((c) => c.length > 1)
    .sort((a, b) => b.length - a.length || a[0]! - b[0]!);
  const systemIdOf = new Map<number, number>();
  systems.forEach((c, i) => c.forEach((v) => systemIdOf.set(v, i)));

  const loopSystems: LoopSystem[] = systems.map((members, id) => {
    const set = new Set(members);
    const kindCounts = new Map<EdgeKind, number>();
    let internal = 0;
    const feeders = new Set<string>();
    const outputs = new Set<string>();
    for (const v of members) {
      for (const w of g.out[v]!) {
        if (set.has(w)) {
          internal++;
          for (const k of g.edge.get(pairKey(v, w))!.kinds) kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
        } else outputs.add(g.names[w]!);
      }
      for (const u of g.in[v]!) if (!set.has(u)) feeders.add(g.names[u]!);
    }
    return {
      id,
      cards: members.map((v) => names[v]!),
      internalEdges: internal,
      density: internal / (members.length * (members.length - 1)),
      kinds: [...kindCounts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
      feeders: [...feeders].sort(),
      outputs: [...outputs].sort(),
    };
  });

  const { loops: rawLoops, summary } = findLoops(g, sccs, options);
  const loops: Loop[] = rawLoops.map((l) => {
    const steps = l.nodes.map((v, i) => {
      const w = l.nodes[(i + 1) % l.nodes.length]!;
      const reason = g.edge.get(pairKey(v, w))!.reasons[0]!;
      return { from: names[v]!, to: names[w]!, kind: reason.kind, description: reason.description };
    });
    return {
      cards: l.nodes.map((v) => names[v]!),
      length: l.nodes.length,
      weight: l.weight,
      meanWeight: Math.round((l.weight / l.nodes.length) * 100) / 100,
      steps,
      knownCombo: l.nodes.length === 2 && steps.every((s) => g.edge.get(pairKey(names.indexOf(s.from), names.indexOf(s.to)))!.kinds.includes('combo')),
    };
  });

  const trees: Record<string, CardTrees> = {};
  names.forEach((name, v) => {
    const down = bfsTree(g, v, true);
    const up = bfsTree(g, v, false);
    trees[name] = { downstream: down.pairs, downstreamDepth: down.depth, upstream: up.pairs, upstreamDepth: up.depth };
  });

  const clusters = clustersOf(g)
    .filter((c) => c.length > 1)
    .sort((a, b) => b.length - a.length || a[0]! - b[0]!);

  return {
    options,
    loopSystems,
    loops,
    loopSearch: summary,
    trees,
    chains: longestChains(g, sccs, systemIdOf),
    clusters: clusters.map((c) => c.map((v) => names[v]!)),
    loadBearing: cutVertices(g, clusters),
    criticalLinks: bridges(g, clusters),
  };
}

export function normalizeOptions(partial: Partial<StructureOptions>): StructureOptions {
  const o = { ...DEFAULT_STRUCTURE_OPTIONS, ...partial };
  const int = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));
  const maxLoopLength = int(o.maxLoopLength, 2, MAX_LOOP_LENGTH_LIMIT);
  return {
    maxLoopLength,
    minLoopLength: int(o.minLoopLength, 2, maxLoopLength),
    maxLoops: int(o.maxLoops, 1, 1000),
    searchBudget: int(o.searchBudget, 10_000, 20_000_000),
    minEdgeWeight: Math.max(0, Number.isFinite(o.minEdgeWeight) ? o.minEdgeWeight : 0),
  };
}
