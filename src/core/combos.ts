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
  /** Conditions beyond setup (a subset of prerequisites). A combo with any is listed as conditional. */
  conditions: string[];
  /** Where the combo was found. Both = Spellbook-documented and verified by our engine. */
  sources: ComboSourceName[];
  spellbookUrl?: string;
  /** The engine's own analysis: loop order, helpers, payoffs, warnings, net mana. */
  engine?: EngineCombo;
  /** Other engine-verified card sets for the same combo (e.g. each persist creature for "a creature with persist"). */
  variants?: string[][];
}

export interface SpellbookStatus {
  status: 'ok' | 'unavailable' | 'disabled';
  error?: string;
  /** When the cached Spellbook data was fetched (results are stable until then). */
  fetchedAt?: string;
}

export interface ComboReport {
  /** Combos that work whenever their cards are assembled and set up. */
  combos: DetectedCombo[];
  /** Combos that also need a condition on the game (enough lands, a creature connecting in combat...). */
  conditional: DetectedCombo[];
  nearMisses: SpellbookNearMiss[];
  spellbook: SpellbookStatus;
  engine: { found: number; exhaustive: boolean };
}

const setKey = (cards: string[]) => [...new Set(cards)].sort().join('|');

function engineSteps(e: EngineCombo): string[] {
  // Lock steps are turn actions with no "feeds the next step" link.
  return [...e.steps.map((s) => (s.then ? `${s.card}: ${s.ability} → ${s.then}.` : `${s.card}: ${s.ability}.`)), e.produces.includes('Lock') ? 'Repeat every turn.' : 'Repeat.'];
}

/**
 * Does an engine combo confirm a Spellbook combo? Its loop cards must all be in the Spellbook combo,
 * and every Spellbook card must be one of its pieces or an alternative for one of its helpers.
 * (Spellbook often lists a generic role, like "a mana rock", as a prerequisite instead of a card.)
 */
export function confirms(e: EngineCombo, sbCards: string[], sbPrerequisites: string[] = []): boolean {
  const sb = new Set(sbCards);
  const covered = new Set([...e.cards, ...Object.values(e.helperAlternatives).flat()]);
  // Spellbook may name a generic piece ("Requires Creature with Persist or Undying") where the engine names a card.
  const generic = sbPrerequisites.filter((p) => p.startsWith('Requires ')).length;
  const unlisted = e.loop.filter((c) => !sb.has(c)).length;
  return unlisted <= generic && sbCards.every((c) => covered.has(c));
}

export function mergeCombos(engine: { combos: EngineCombo[]; exhaustive: boolean }, spellbook: SpellbookResult | null, status: SpellbookStatus): ComboReport {
  const used = new Set<EngineCombo>();
  const combos: DetectedCombo[] = [];

  for (const sb of spellbook?.included ?? []) {
    // Every engine combo that confirms it counts; the one closest in size is shown, the rest are variants.
    const matches = engine.combos
      .filter((e) => confirms(e, sb.cards, sb.prerequisites))
      .sort((a, b) => Math.abs(a.cards.length - sb.cards.length) - Math.abs(b.cards.length - sb.cards.length));
    for (const m of matches) used.add(m);
    const combo = fromSpellbook(sb, matches[0]);
    if (matches.length > 1) combo.variants = matches.slice(1).map((m) => m.cards);
    combos.push(combo);
  }
  for (const e of engine.combos) {
    const key = setKey(e.cards);
    if (used.has(e)) continue;
    combos.push({
      id: `engine:${key}`,
      cards: e.cards,
      produces: e.produces,
      steps: engineSteps(e),
      prerequisites: e.prerequisites,
      conditions: e.conditions,
      sources: ['engine'],
      engine: e,
    });
  }

  combos.sort(
    (a, b) => b.sources.length - a.sources.length || a.cards.length - b.cards.length || setKey(a.cards).localeCompare(setKey(b.cards)),
  );
  return {
    combos: combos.filter((c) => c.conditions.length === 0),
    conditional: combos.filter((c) => c.conditions.length > 0),
    nearMisses: spellbook?.almostIncluded ?? [],
    spellbook: status,
    engine: { found: engine.combos.length, exhaustive: engine.exhaustive },
  };
}

function fromSpellbook(sb: SpellbookCombo, engine: EngineCombo | undefined): DetectedCombo {
  return {
    id: `spellbook:${sb.id}`,
    // Spellbook's card list is authoritative; the engine's analysis is attached for loop order and helpers.
    cards: sb.cards,
    produces: sb.produces,
    steps: sb.steps,
    prerequisites: sb.prerequisites,
    // Spellbook's own notable prerequisites when recorded; for older cached data, the engine's.
    conditions: sb.conditions ?? engine?.conditions ?? [],
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
