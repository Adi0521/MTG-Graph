import {
  abilityCopier,
  activationReducer,
  artifactTapper,
  blocksCounters,
  castFromHand,
  costReducers,
  deathDoubler,
  etbDoubler,
  imprintAbilities,
  landAmplifier,
  manaAmplifier,
  matchesTarget,
  parseAbilities,
  preventsMinusCounter,
  type Ability,
  type Output,
} from '../core/abilities.ts';
import { buildHelperIndex, findEngineCombos, inputs, outputsOf, type EngineCombo, type Resource } from '../core/combo-engine.ts';
import type { Card } from '../core/types.ts';
import type { KnownCombo } from './spellbook-index.ts';

/**
 * Discovery over the whole card pool.
 *
 * 1. Profile each card with the engine's own resource model (what its abilities produce and need).
 * 2. Link cards where one can feed the other, checking targets (a blink that targets creatures does not
 *    link to an artifact).
 * 3. Candidates are 1-card loops (a card that feeds itself) and 2-card loops (each feeds the other),
 *    plus Isochron Scepter with each eligible instant.
 * 4. Each candidate runs through the full engine and simulator, which may add one helper from the
 *    whole pool (a Treasure per death, a cost reducer, Panharmonicon...). 3-card combos come from here.
 * 5. Results are checked against Commander Spellbook's full database.
 */

export interface Discovered extends EngineCombo {
  /** The Spellbook combo it matches, if it is already known. */
  known: KnownCombo | null;
  /** A known combo it differs from by one card (swapped or added), if not known itself. */
  variantOf: { combo: KnownCombo; ours: string[]; theirs: string[] } | null;
}

export interface DiscoveryStats {
  poolCards: number;
  loopCards: number;
  helperCards: number;
  candidates: { single: number; pairs: number; imprint: number };
  combos: number;
  novel: number;
  rejectedBySimulator: number;
  ms: number;
}

const has = <T extends Output['type']>(a: Ability, type: T) => a.outputs.find((o): o is Extract<Output, { type: T }> => o.type === type);
const has2 = (a: Ability, ...types: Output['type'][]) => a.outputs.some((o) => types.includes(o.type));

interface Profile {
  card: Card;
  abilities: Ability[];
}

/** Abilities a card can use in a loop, including casting it from hand and its own undying/persist. */
function profile(card: Card): Profile {
  const parsed = parseAbilities(card).filter((a) => !a.unmodeledCost && !a.oncePerTurn);
  const extra: Ability[] = [];
  if (!/\bLand\b/.test(card.typeLine)) extra.push(castFromHand(card));
  for (const keyword of ['undying', 'persist']) {
    if (!card.keywords.includes(keyword) || !/\bCreature\b/.test(card.typeLine)) continue;
    extra.push({
      id: `${card.name}#${keyword}`,
      card: card.name,
      text: keyword,
      kind: 'triggered',
      trigger: { type: 'death', self: true, another: false, nontoken: true, what: 'creature' },
      cost: { mana: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, generic: 0 }, tap: false, sacrifice: null, life: 0, removeCounter: false, loyalty: false },
      host: false,
      outputs: [{ type: 'recur' }],
      oncePerTurn: false,
      conditions: [],
      unmodeledCost: false,
    });
  }
  return { card, abilities: [...parsed, ...extra] };
}

/**
 * Could ability `a` (on card X) feed ability `b` (on card Y) through resource `r`? Stricter than the
 * resource match: it checks the targets that decide whether the link is real.
 */
function links(a: Ability, b: Ability, r: Resource, cards: Map<string, Card>): boolean {
  const y = cards.get(b.card)!;
  switch (r) {
    case 'hand': {
      if (b.kind !== 'cast') return false;
      const toHand = has(a, 'toHand');
      const bounce = has(a, 'bounce');
      if (toHand && matchesTarget(toHand.target, y, a.card)) return true;
      if (bounce) return bounce.target === 'self' ? a.card === b.card : matchesTarget(bounce.target, y, a.card);
      return false;
    }
    case 'selfEtb': {
      if (b.trigger?.type !== 'selfEtb') return false;
      if (a.card === b.card) return true;
      const copy = has(a, 'copy');
      if (copy && (copy.target === 'host' || copy.target === 'entering' || matchesTarget(copy.target, y, a.card))) return true;
      const blink = has(a, 'blink');
      if (blink && typeof blink.target !== 'string' && matchesTarget(blink.target, y, a.card)) return true;
      if (blink && blink.target === 'host') return true;
      return has2(a, 'reanimate', 'returnExiled', 'massReanimate', 'recurDied');
    }
    case 'untap': {
      if (!b.cost.tap && !b.cost.loyalty) return false;
      const untap = has(a, 'untap');
      if (untap) {
        if (untap.target === 'self') return a.card === b.card;
        if (untap.target === 'host') return true;
        return matchesTarget(untap.target, y, a.card);
      }
      return a.card === b.card || Boolean(has(a, 'blink'));
    }
    case 'counter': {
      const c = has(a, 'counter');
      if (!c || !b.cost.removeCounter) return false;
      return c.target === 'self' ? a.card === b.card : c.target === 'host' || c.each || matchesTarget(c.target, y, a.card);
    }
    default:
      return true;
  }
}

/** Cards that can fill a helper role: triggered abilities that make mana/life/tokens, or a static effect. */
function isHelper(card: Card): boolean {
  if (costReducers(card).length || activationReducer(card) || abilityCopier(card) || artifactTapper(card)) return true;
  if (preventsMinusCounter(card) || blocksCounters(card) || etbDoubler(card) || deathDoubler(card) || landAmplifier(card) || manaAmplifier(card)) return true;
  return parseAbilities(card).some(
    (a) =>
      !a.unmodeledCost &&
      ((a.kind === 'triggered' && a.outputs.some((o) => o.type === 'mana' || o.type === 'lifegain' || o.type === 'creature')) ||
        // free sacrifice outlets that make mana, and mana rocks
        (a.kind === 'activated' && Boolean(has(a, 'mana')) && !a.cost.removeCounter && (Boolean(a.cost.sacrifice) || a.cost.tap))),
  );
}

export interface DiscoveryOptions {
  /** Stop after this many candidate sets (for quick runs). */
  limit?: number;
  /** Called with progress (done, total). */
  onProgress?: (done: number, total: number) => void;
}

export function discover(
  pool: Card[],
  isKnown: (cards: string[], loop: string[]) => KnownCombo | null,
  options: DiscoveryOptions & { variantOf?: (cards: string[]) => Discovered['variantOf'] } = {},
): { combos: Discovered[]; stats: DiscoveryStats } {
  const started = performance.now();
  const cards = new Map(pool.map((c) => [c.name, c]));
  const granterCtx = { granters: [], cardByName: cards };

  // 1. Profiles and resource buckets.
  const profiles = pool.map(profile);
  const consumers = new Map<Resource, { ability: Ability; card: string }[]>();
  const loopCards = new Set<string>();
  for (const p of profiles) {
    for (const a of p.abilities) {
      for (const r of inputs(a)) {
        if (r === 'free') continue;
        const list = consumers.get(r) ?? [];
        list.push({ ability: a, card: p.card.name });
        consumers.set(r, list);
      }
    }
  }

  // 2. Card-level links: X → Y when some ability of X can feed some ability of Y.
  // Mana and return-to-hand links are generic (they would link nearly everything), so only "specific"
  // links (a sacrifice, a death, a blink, an untap, life...) are indexed; the generic ones are only checked
  // in the reverse direction of a specific link. Every real loop has at least one specific link.
  const GENERIC = new Set<Resource>(['free', 'mana', 'hand']);
  const byName = new Map(profiles.map((p) => [p.card.name, p]));
  const makesMana = (p: Profile) => p.abilities.some((a) => a.kind !== 'cast' && outputsOf(a, granterCtx).includes('mana'));
  const needsMana = (p: Profile) => p.abilities.some((a) => inputs(a).includes('mana'));
  const returnsToHand = (x: Profile, y: Profile) =>
    x.abilities.some((a) => a.kind !== 'cast' && y.abilities.some((b) => b.kind === 'cast' && links(a, b, 'hand', cards)));
  const genericLink = (x: Profile, y: Profile) => (makesMana(x) && needsMana(y)) || returnsToHand(x, y);

  const out = new Map<string, Set<string>>();
  for (const p of profiles) {
    const targets = new Set<string>();
    for (const a of p.abilities) {
      if (a.kind === 'cast') continue; // casting a card only matters once something returns it
      for (const r of outputsOf(a, granterCtx)) {
        if (GENERIC.has(r)) continue;
        for (const { ability: b, card } of consumers.get(r) ?? []) {
          if (!targets.has(card) && links(a, b, r, cards)) targets.add(card);
        }
      }
    }
    // A free activation (Devoted Druid untapping itself) or a card that feeds itself.
    if (p.abilities.some((b) => b.kind === 'activated' && b.cost.minusCounter)) targets.add(p.card.name);
    if (targets.size) {
      out.set(p.card.name, targets);
      loopCards.add(p.card.name);
    }
  }
  const linked = (x: string, y: string) => Boolean(out.get(x)?.has(y)) || genericLink(byName.get(x)!, byName.get(y)!);

  // 3. Candidates.
  const candidates: string[][] = [];
  const seen = new Set<string>();
  const addCandidate = (names: string[]) => {
    const key = [...names].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push([...names].sort());
  };
  let single = 0;
  let pairs = 0;
  let imprint = 0;
  for (const [x, targets] of [...out].sort(([a], [b]) => a.localeCompare(b))) {
    if (targets.has(x)) {
      addCandidate([x]);
      single++;
    }
    for (const y of [...targets].sort()) {
      if (y === x) continue;
      if (linked(y, x)) {
        const before = candidates.length;
        addCandidate([x, y]);
        if (candidates.length > before) pairs++;
      }
    }
  }
  // Isochron Scepter-style imprints with each eligible instant.
  for (const p of profiles) {
    if (!/imprint — when ~ enters, you may exile an instant/.test(p.card.text)) continue;
    const instants = pool.filter((c) => /\bInstant\b/.test(c.typeLine) && imprintAbilities(p.card, [c]).some((a) => a.outputs.length > 0));
    for (const instant of instants) {
      addCandidate([p.card.name, instant.name]);
      imprint++;
    }
  }

  // 4. Evaluate with one helper from the pool.
  const helperPool = pool.filter(isHelper);
  const helperIndex = buildHelperIndex(helperPool);
  const limit = options.limit ?? candidates.length;
  const found = new Map<string, Discovered>();
  let rejected = 0;
  candidates.slice(0, limit).forEach((names, n) => {
    options.onProgress?.(n, Math.min(limit, candidates.length));
    const { combos, rejected: r } = findEngineCombos(
      names.map((name) => cards.get(name)!),
      { helperIndex, maxHelpers: 1, searchBudget: 200_000 },
    );
    rejected += r.length;
    for (const combo of combos) {
      const key = [...combo.cards].sort().join('|');
      if (found.has(key)) continue;
      const known = isKnown(combo.cards, combo.loop);
      found.set(key, { ...combo, known, variantOf: known ? null : (options.variantOf?.(combo.cards) ?? null) });
    }
  });

  // Keep minimal combos (and treat a helper's alternatives as the same combo).
  const all = [...found.values()];
  const contains = (c: EngineCombo, o: EngineCombo) =>
    o.loop.every((x) => c.cards.includes(x)) && o.helpers.every((h) => c.cards.includes(h) || (o.helperAlternatives[h] ?? []).some((alt) => c.cards.includes(alt)));
  const minimal = all
    .filter((c) => !all.some((o) => o !== c && o.cards.length < c.cards.length && contains(c, o)))
    .sort(
      (a, b) =>
        Number(Boolean(a.known)) - Number(Boolean(b.known)) ||
        Number(Boolean(a.variantOf)) - Number(Boolean(b.variantOf)) ||
        a.cards.length - b.cards.length ||
        a.cards.join('|').localeCompare(b.cards.join('|')),
    );

  return {
    combos: minimal,
    stats: {
      poolCards: pool.length,
      loopCards: loopCards.size,
      helperCards: helperPool.length,
      candidates: { single, pairs, imprint },
      combos: minimal.length,
      novel: minimal.filter((c) => !c.known && !c.variantOf).length,
      rejectedBySimulator: rejected,
      ms: Math.round(performance.now() - started),
    },
  };
}
