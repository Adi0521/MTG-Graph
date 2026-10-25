import { toCard } from './card.ts';
import { findEngineCombos } from './combo-engine.ts';
import { comboReasons, mergeCombos, type ComboReport, type SpellbookStatus } from './combos.ts';
import { buildGraph, insights, type DeckInsights, type EdgeKind, type SynergyEdge, type ThemeSummary } from './graph.ts';
import type { FetchResult } from './scryfall.ts';
import type { SpellbookResult } from './spellbook.ts';
import { analyzeStructures, type StructureOptions, type Structures } from './structures.ts';
import type { Card, DeckEntry } from './types.ts';

/** Bump when rules or algorithms change, so stored results can be compared like-for-like. */
export const ENGINE_VERSION = '0.3.0';
export const MAX_UNIQUE_CARDS = 250;

export type CardSource = (names: string[]) => Promise<FetchResult>;
/** Looks up known combos for a deck (Commander Spellbook). `fetchedAt` dates the cached data. */
export type KnownComboSource = (entries: DeckEntry[]) => Promise<{ result: SpellbookResult; fetchedAt: string }>;

export interface Sources {
  cards: CardSource;
  /** Omit to skip the Spellbook lookup (the engine still runs). */
  knownCombos?: KnownComboSource;
}

export interface AnalyzeOptions {
  structure?: Partial<StructureOptions>;
  /** Restrict the graph to these edge kinds (default: all). */
  enabledKinds?: EdgeKind[];
  /** Set false to skip the Commander Spellbook lookup. */
  spellbook?: boolean;
}

export interface AnalyzedCard {
  name: string;
  quantity: number;
  section: DeckEntry['section'];
  typeLine: string;
  manaCost: string;
  oracleText: string;
  colorIdentity: string[];
  imageUrl?: string;
  artUrl?: string;
  scryfallUri?: string;
  provides: Record<string, string[]>;
  wants: Record<string, string[]>;
  inDegree: number;
  outDegree: number;
  degree: number;
  weightedDegree: number;
}

export interface AnalysisResult {
  engineVersion: string;
  deck: {
    totalCards: number;
    uniqueCards: number;
    notFound: string[];
    sideboardIgnored: number;
    basicLands: string[];
  };
  cards: AnalyzedCard[];
  edges: SynergyEdge[];
  themes: ThemeSummary[];
  insights: DeckInsights;
  structures: Structures;
  combos: ComboReport;
}

export class DeckError extends Error {}

export async function analyzeDeck(entries: DeckEntry[], sources: Sources, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const playable = entries.filter((e) => e.section !== 'sideboard');
  if (playable.length === 0) throw new DeckError('No cards found in the decklist.');
  const uniqueNames = [...new Set(playable.map((e) => e.name))];
  if (uniqueNames.length > MAX_UNIQUE_CARDS) throw new DeckError(`Decks are limited to ${MAX_UNIQUE_CARDS} unique cards.`);

  const { cards: found, notFound } = await sources.cards(uniqueNames);

  const byName = new Map<string, { card: Card; section: DeckEntry['section'] }>();
  for (const entry of playable) {
    const raw = found.get(entry.name.toLowerCase());
    if (!raw) continue;
    const existing = byName.get(raw.name);
    if (existing) existing.card.quantity += entry.quantity;
    else byName.set(raw.name, { card: toCard(raw, entry.quantity), section: entry.section });
  }

  const deckCards = [...byName.values()].map((v) => v.card);
  const combos = await detectCombos(deckCards, byName, sources, options);

  const enabledKinds = options.enabledKinds ? new Set(options.enabledKinds) : undefined;
  const graph = buildGraph(deckCards, { enabledKinds, extraReasons: comboReasons(combos.combos) });
  const structures = analyzeStructures(
    graph.nodes.map((n) => n.card.name),
    graph.edges,
    options.structure,
  );

  const cards: AnalyzedCard[] = graph.nodes.map((n) => ({
    name: n.card.name,
    quantity: n.card.quantity,
    section: byName.get(n.card.name)!.section,
    typeLine: n.card.typeLine,
    manaCost: n.card.manaCost,
    oracleText: n.card.oracleText,
    colorIdentity: n.card.colorIdentity,
    imageUrl: n.card.imageUrl,
    artUrl: n.card.artUrl,
    scryfallUri: n.card.scryfallUri,
    provides: Object.fromEntries(n.tags.provides),
    wants: Object.fromEntries(n.tags.wants),
    inDegree: n.inDegree,
    outDegree: n.outDegree,
    degree: n.degree,
    weightedDegree: n.weightedDegree,
  }));

  return {
    engineVersion: ENGINE_VERSION,
    deck: {
      totalCards: [...byName.values()].reduce((sum, v) => sum + v.card.quantity, 0),
      uniqueCards: byName.size,
      notFound: [...notFound].sort(),
      sideboardIgnored: entries.filter((e) => e.section === 'sideboard').reduce((sum, e) => sum + e.quantity, 0),
      basicLands: graph.excluded.map((c) => c.name),
    },
    cards,
    edges: graph.edges,
    themes: graph.themes,
    insights: insights(graph),
    structures,
    combos,
  };
}

async function detectCombos(
  deckCards: Card[],
  byName: Map<string, { card: Card; section: DeckEntry['section'] }>,
  sources: Sources,
  options: AnalyzeOptions,
): Promise<ComboReport> {
  const engine = findEngineCombos(deckCards);
  let spellbook: SpellbookResult | null = null;
  let status: SpellbookStatus = { status: 'disabled' };
  if (sources.knownCombos && options.spellbook !== false) {
    // Query with canonical Scryfall names, so typos fixed by the card lookup do not hide combos.
    const canonical: DeckEntry[] = [...byName.values()].map(({ card, section }) => ({ name: card.name, quantity: card.quantity, section }));
    try {
      const { result, fetchedAt } = await sources.knownCombos(canonical);
      spellbook = result;
      status = { status: 'ok', fetchedAt };
    } catch (err) {
      // Spellbook being down should not fail the analysis; the engine's combos still apply.
      status = { status: 'unavailable', error: err instanceof Error ? err.message : String(err) };
    }
  }
  return mergeCombos(engine, spellbook, status);
}
