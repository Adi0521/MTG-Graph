import type { EngineCombo } from './combo-engine.ts';
import { COMBO_WEIGHT, type SynergyReason } from './graph.ts';
import type { SpellbookCombo, SpellbookNearMiss, SpellbookResult } from './spellbook.ts';

export type ComboSourceName = 'spellbook' | 'engine';

export interface DetectedCombo {
  id: string;
  cards: string[];
  produces: string[];
  steps: string[];
  prerequisites: string[];
  /** Where the combo was found. Both = Spellbook-documented and verified by our engine. */
  sources: ComboSourceName[];
  spellbookUrl?: string;
  /** The engine's own analysis: loop order, helpers, payoffs, warnings, net mana. */
  engine?: EngineCombo;
}

export interface SpellbookStatus {
  status: 'ok' | 'unavailable' | 'disabled';
  error?: string;
  /** When the cached Spellbook data was fetched (results are stable until then). */
  fetchedAt?: string;
}

export interface ComboReport {
  combos: DetectedCombo[];
  nearMisses: SpellbookNearMiss[];
  spellbook: SpellbookStatus;
  engine: { found: number; exhaustive: boolean };
}

const setKey = (cards: string[]) => [...new Set(cards)].sort().join('|');

function engineSteps(e: EngineCombo): string[] {
  return [...e.steps.map((s) => `${s.card}: ${s.ability} → ${s.then}.`), 'Repeat.'];
}

export function mergeCombos(engine: { combos: EngineCombo[]; exhaustive: boolean }, spellbook: SpellbookResult | null, status: SpellbookStatus): ComboReport {
  const engineByKey = new Map(engine.combos.map((e) => [setKey(e.cards), e]));
  const used = new Set<string>();
  const combos: DetectedCombo[] = [];

  for (const sb of spellbook?.included ?? []) {
    const key = setKey(sb.cards);
    const match = engineByKey.get(key);
    if (match) used.add(key);
    combos.push(fromSpellbook(sb, match));
  }
  for (const [key, e] of engineByKey) {
    if (used.has(key)) continue;
    combos.push({
      id: `engine:${key}`,
      cards: e.cards,
      produces: e.produces,
      steps: engineSteps(e),
      prerequisites: e.prerequisites,
      sources: ['engine'],
      engine: e,
    });
  }

  combos.sort(
    (a, b) => b.sources.length - a.sources.length || a.cards.length - b.cards.length || setKey(a.cards).localeCompare(setKey(b.cards)),
  );
  return {
    combos,
    nearMisses: spellbook?.almostIncluded ?? [],
    spellbook: status,
    engine: { found: engine.combos.length, exhaustive: engine.exhaustive },
  };
}

function fromSpellbook(sb: SpellbookCombo, engine: EngineCombo | undefined): DetectedCombo {
  return {
    id: `spellbook:${sb.id}`,
    // Prefer the engine's loop order when it verified the combo.
    cards: engine ? engine.cards : sb.cards,
    produces: sb.produces,
    steps: sb.steps,
    prerequisites: sb.prerequisites,
    sources: engine ? ['spellbook', 'engine'] : ['spellbook'],
    spellbookUrl: sb.url,
    engine,
  };
}

/** Combo links for the synergy graph: each combo becomes a ring, so it shows up as a loop. */
export function comboReasons(combos: DetectedCombo[]): SynergyReason[] {
  const reasons: SynergyReason[] = [];
  const seen = new Set<string>();
  for (const combo of combos) {
    const cards = [...new Set(combo.cards)];
    if (cards.length < 2) continue;
    const pairs = cards.length === 2 ? [[cards[0]!, cards[1]!], [cards[1]!, cards[0]!]] : cards.map((c, i) => [c, cards[(i + 1) % cards.length]!]);
    for (const [from, to] of pairs as [string, string][]) {
      const key = `${from}->${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reasons.push({ kind: 'combo', from, to, description: `Combo with ${cards.filter((c) => c !== from).join(' + ')}: ${combo.produces[0] ?? 'infinite loop'}`, weight: COMBO_WEIGHT });
    }
  }
  return reasons;
}
