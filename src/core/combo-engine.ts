import {
  COLORS,
  abilityCopier,
  activationReducer,
  artifactTapper,
  blocksCounters,
  castFromTopEnabler,
  deathDoubler,
  etbDoubler,
  landAmplifier,
  manaAmplifier,
  castFromHand,
  costReducers,
  emptyCost,
  emptyProduction,
  imprintAbilities,
  lifelinkGranters,
  matchesTarget,
  parseAbilities,
  payMana,
  preventsMinusCounter,
  type Ability,
  type CostReducer,
  type ManaCost,
  type ManaProduction,
  type Output,
} from './abilities.ts';
import { verifyLoop, type LoopPlan, type PerLoop } from './simulate.ts';
import type { Card } from './types.ts';

/**
 * Deterministic infinite-combo detection.
 *
 * 1. Build a graph of abilities: X → Y when something X produces can pay for or
 *    trigger Y (mana → mana costs, a permanent → a sacrifice cost, a death → a
 *    death trigger, a copy/blink → an ETB trigger, an untap → a {T} cost, a card
 *    returned to hand → casting it, a spell cast → a cast trigger, ...).
 * 2. Enumerate short cycles in that graph.
 * 3. Simulate one pass around each cycle, tracking which object moves where
 *    (token or card, artifact or creature), and count resources. A loop is
 *    infinite when every {T} and loyalty ability is reset, mana (with colors)
 *    and life break even, nothing is once-per-turn, recursion only returns cards
 *    that died in the loop, and the loop produces something.
 * 4. If mana or life falls short, try adding up to three supporting cards from
 *    the deck: triggers on the loop's events (a Treasure per death), cost
 *    reducers, sacrifice outlets for leftover tokens, mana rocks re-untapped by
 *    "untap all", ability-cost reducers (Power Artifact) and ability copiers
 *    (Rings of Brighthearth). Remaining triggers are reported as payoffs.
 */

export interface ComboStep {
  card: string;
  ability: string;
  /** How this step feeds the next one. */
  then: string;
}

export interface EngineCombo {
  /** Every card the combo needs: loop pieces first, then helpers. */
  cards: string[];
  loop: string[];
  helpers: string[];
  /** For each helper, other deck cards that could fill the same role. */
  helperAlternatives: Record<string, string[]>;
  steps: ComboStep[];
  produces: string[];
  prerequisites: string[];
  payoffs: { card: string; effect: string }[];
  warnings: string[];
  /** Mana left over per loop, e.g. "{C}{C}", or "none". */
  netMana: string;
  /** The loop played out on a concrete game state: what it needs to start and its exact net per loop. */
  verification: { startup: string[]; perLoop: PerLoop };
}

/** A loop the resource check accepted but the simulator rejected, with the reason. */
export interface RejectedLoop {
  cards: string[];
  reason: string;
}

export interface EngineOptions {
  /** Longest ability cycle to consider. */
  maxLoopAbilities: number;
  /** DFS step cap, so huge decks stay bounded (and deterministic). */
  searchBudget: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = { maxLoopAbilities: 6, searchBudget: 8_000_000 };

export type Resource = 'free' | 'library' | 'mana' | 'body' | 'death' | 'leave' | 'selfEtb' | 'etb' | 'untap' | 'reset' | 'lifegain' | 'drain' | 'counter' | 'draw' | 'damage' | 'hand' | 'cast';

export interface Binding {
  res: Resource;
  /** The permanent or card involved: a card name, or null for a token. */
  object?: string | null;
  token?: boolean;
  /** Card types of the object ("artifact", "creature", ...). */
  types?: string[];
  pt?: string | null;
  /** Set when lifegain comes from damage dealt by a creature given lifelink. */
  lifelinkFrom?: string;
  /** Life gained or lost, so "that much" effects downstream know the amount. */
  amount?: number;
}

export interface Context {
  cardByName: Map<string, Card>;
  granters: string[];
  reducers: CostReducer[];
  activationReducers: { card: string; amount: number }[];
  copiers: { card: string; cost: number }[];
  /** Cards that stop a single -1/-1 counter (Vizier of Remedies). */
  counterPreventers: string[];
  /** Panharmonicon-style cards that double enter-the-battlefield triggers. */
  etbDoublers: string[];
  /** Urza-style "Tap an untapped artifact you control: Add {U}". */
  artifactTappers: { card: string; mana: ManaProduction }[];
  /** Solemnity: undying/persist creatures return without counters. */
  counterBlockers: string[];
  /** Teysa Karlov: death triggers happen twice. */
  deathDoublers: string[];
  /** High Tide: lands untapped for mana make an extra {U} each (assuming Islands). */
  landAmplifiers: string[];
  /** Kinnan: each nonland mana ability makes one more mana. */
  manaAmplifiers: string[];
  /** Every parsed ability in the deck, for helpers and payoffs. */
  deckAbilities: Ability[];
  /** Loops the simulator rejected (for diagnostics). */
  rejected: RejectedLoop[];
}

const PERMANENT_TYPES = ['artifact', 'creature', 'enchantment', 'planeswalker', 'land'];
const totalMana = (c: ManaCost) => COLORS.reduce((n, k) => n + c[k], 0) + c.generic;
const totalProduction = (m: ManaProduction) => COLORS.reduce((n, k) => n + m[k], 0) + m.any;
const has = <T extends Output['type']>(a: Ability, type: T) => a.outputs.find((o): o is Extract<Output, { type: T }> => o.type === type);
const typesOf = (ctx: Context, name: string) => (ctx.cardByName.get(name)?.typeLine.toLowerCase() ?? '').split(/[\s—/]+/).filter((t) => PERMANENT_TYPES.includes(t));
const isCreature = (ctx: Context, name: string) => typesOf(ctx, name).includes('creature');
const hasHaste = (ctx: Context, name: string) => ctx.cardByName.get(name)?.keywords.includes('haste') ?? false;
const mv = (ctx: Context, name: string) => ctx.cardByName.get(name)?.cmc ?? 0;
const castsPermanent = (a: Ability) => a.kind === 'cast' && (a.casts ?? []).some((t) => PERMANENT_TYPES.includes(t));
/** An activated ability whose cost needs nothing from the loop (e.g. Devoted Druid's "Put a -1/-1 counter on ~: Untap ~"). */
const isFreeActivation = (a: Ability) =>
  a.kind === 'activated' && !a.cost.tap && !a.cost.sacrifice && !a.cost.loyalty && !a.cost.removeCounter && totalMana(a.cost.mana) === 0 && a.cost.life === 0;

const putsBodyOnBattlefield = (a: Ability) =>
  a.kind === 'recast' ||
  castsPermanent(a) ||
  Boolean(
    has(a, 'creature') || has(a, 'copy') || has(a, 'recur') || has(a, 'reanimate') || has(a, 'returnExiled') || has(a, 'massReanimate') || has(a, 'recurDied'),
  );

/**
 * The creature an ability acts through. For a granted ability (aura, equipment, soulbond)
 * that is its host, read off the loop: a "deals damage" trigger's host is the previous
 * card (the damage source); a copy or counter goes to the next card.
 */
function hostOf(abilities: Ability[], i: number): string {
  const a = abilities[i]!;
  const k = abilities.length;
  if (!a.host) return a.card;
  if (a.trigger?.type === 'damage') return abilities[(i - 1 + k) % k]!.card;
  return abilities[(i + 1) % k]!.card;
}

/** The permanent a {T} cost taps. */
const tapObject = hostOf;

interface Entering {
  object: string | null;
  token: boolean;
  types: string[];
  pt: string | null;
}

/** Does ability i's blink reach `target`? */
function blinkHits(abilities: Ability[], i: number, target: string, ctx: Context): boolean {
  const a = abilities[i]!;
  const blink = has(a, 'blink');
  if (!blink) return false;
  if (blink.target === 'self') return a.card === target;
  if (blink.target === 'host') return hostOf(abilities, i) === target && isCreature(ctx, target);
  return matchesTarget(blink.target, ctx.cardByName.get(target)!, a.card);
}

/** Karmic Guide's reanimation target: a creature in the loop, preferring one whose own leave/death trigger is in the loop. */
function reanimatedObject(abilities: Ability[], i: number, ctx: Context): string | null {
  const a = abilities[i]!;
  const r = has(a, 'reanimate');
  if (!r) return null;
  const k = abilities.length;
  const candidates: string[] = [];
  for (let d = 1; d <= k; d++) {
    const name = abilities[(i + d) % k]!.card;
    if (name !== a.card && isCreature(ctx, name) && matchesTarget(r.target, ctx.cardByName.get(name)!, a.card) && !candidates.includes(name)) candidates.push(name);
  }
  const ownTrigger = (n: string) => abilities.some((b) => b.card === n && (b.trigger?.type === 'leave' || (b.trigger?.type === 'death' && b.trigger.self)));
  return candidates.find(ownTrigger) ?? candidates[0] ?? null;
}

/** Fiend Hunter leaving returns the card its enter ability exiled; in a loop, that is the next card. */
function exileSpecOf(card: string, ctx: Context) {
  for (const b of ctx.deckAbilities) {
    const e = b.card === card ? has(b, 'exile') : undefined;
    if (e) return e.target;
  }
  return null;
}

function returnedExiled(a: Ability, next: Ability, ctx: Context): string | null {
  if (!has(a, 'returnExiled')) return null;
  const spec = exileSpecOf(a.card, ctx);
  return spec && isCreature(ctx, next.card) && matchesTarget(spec, ctx.cardByName.get(next.card)!, a.card) ? next.card : null;
}

/** The permanent that ability i puts onto the battlefield, if any. */
function enteringObject(abilities: Ability[], i: number, ctx: Context, input?: Binding): Entering | null {
  const a = abilities[i]!;
  const next = abilities[(i + 1) % abilities.length]!;
  const card = (name: string): Entering => ({ object: name, token: false, types: typesOf(ctx, name), pt: null });
  // Nim Deathmantle returns the creature that just died.
  if (has(a, 'recurDied')) return input?.res === 'death' && input.object ? card(input.object) : null;
  if (a.kind === 'recast' || has(a, 'recur') || castsPermanent(a)) return card(a.card);
  const tokens = has(a, 'creature');
  if (tokens) return { object: null, token: true, types: tokens.artifact ? ['artifact', 'creature'] : ['creature'], pt: tokens.pt };
  if (has(a, 'copy')) return { object: null, token: true, types: ['creature'], pt: null };
  if (blinkHits(abilities, i, next.card, ctx)) return card(next.card);
  const reanimated = reanimatedObject(abilities, i, ctx);
  if (reanimated) return card(reanimated);
  const returned = returnedExiled(a, next, ctx);
  if (returned) return card(returned);
  return null;
}

function untapReaches(abilities: Ability[], i: number, target: string, ctx: Context): boolean {
  const a = abilities[i]!;
  const untap = has(a, 'untap');
  if (untap) {
    if (untap.target === 'self' && a.card === target) return true;
    if (untap.target === 'host' && hostOf(abilities, i) === target && isCreature(ctx, target)) return true;
    if (typeof untap.target !== 'string' && matchesTarget(untap.target, ctx.cardByName.get(target)!, a.card)) return true;
  }
  // A blinked creature returns untapped but summoning sick, so it needs haste to tap again.
  return blinkHits(abilities, i, target, ctx) && (!isCreature(ctx, target) || hasHaste(ctx, target));
}

/** How ability `a` (which received `input`) can feed `next`, or null if it cannot. */
function feed(abilities: Ability[], i: number, input: Binding | undefined, ctx: Context): Binding | null {
  const a = abilities[i]!;
  const nextIndex = (i + 1) % abilities.length;
  const next = abilities[nextIndex]!;
  const nextCard = ctx.cardByName.get(next.card)!;

  if (next.kind === 'triggered') {
    const t = next.trigger!;
    switch (t.type) {
      case 'death': {
        // A creature can also kill itself: pinging itself, or piling -1/-1 counters on itself (undying loops).
        if (!a.cost.sacrifice) {
          const selfKill =
            t.self && a.card === next.card && isCreature(ctx, a.card) && (a.cost.minusCounter || a.outputs.some((o) => o.type === 'drain' && o.damage));
          return selfKill ? { res: 'death', object: a.card, token: false, types: typesOf(ctx, a.card) } : null;
        }
        if (input?.res !== 'body') return null;
        const object = input.object ?? null;
        const token = input.token ?? false;
        const types = input.types ?? [];
        if (!types.includes(t.what)) return null;
        if (t.nontoken && token) return null;
        if (t.another && object === next.card) return null;
        if (t.self && object !== next.card) return null;
        return { res: 'death', object, token, types };
      }
      case 'selfEtb': {
        if ((a.kind === 'recast' || has(a, 'recur') || castsPermanent(a)) && a.card === next.card) return { res: 'selfEtb', object: next.card };
        const copy = has(a, 'copy');
        if (copy) {
          const ok = copy.target === 'host' ? isCreature(ctx, next.card) : matchesTarget(copy.target, nextCard, a.card);
          if (ok) return { res: 'selfEtb', object: next.card };
        }
        if (blinkHits(abilities, i, next.card, ctx)) return { res: 'selfEtb', object: next.card };
        if (reanimatedObject(abilities, i, ctx) === next.card || returnedExiled(a, next, ctx)) return { res: 'selfEtb', object: next.card };
        if (has(a, 'massReanimate') && isCreature(ctx, next.card)) return { res: 'selfEtb', object: next.card };
        if (has(a, 'recurDied') && input?.res === 'death' && input.object === next.card) return { res: 'selfEtb', object: next.card };
        return null;
      }
      case 'leave': {
        const sacrificed = a.cost.sacrifice && input?.res === 'body' && input.object === next.card;
        return sacrificed || blinkHits(abilities, i, next.card, ctx) ? { res: 'leave', object: next.card } : null;
      }
      case 'etb': {
        const entering = enteringObject(abilities, i, ctx, input);
        if (!entering || !entering.types.includes('creature')) return null;
        if (t.nontoken && entering.token) return null;
        if (t.another && entering.object === next.card) return null;
        if (t.pt && entering.pt !== t.pt) return null;
        return { res: 'etb', ...entering };
      }
      case 'lifegain': {
        if (has(a, 'lifegain')) return { res: 'lifegain' };
        const damage = a.outputs.find((o) => o.type === 'drain' && o.damage);
        if (damage && isCreature(ctx, a.card)) {
          const granter = ctx.cardByName.get(a.card)!.keywords.includes('lifelink') ? a.card : ctx.granters.find((g) => g !== a.card);
          if (granter) return { res: 'lifegain', lifelinkFrom: granter };
        }
        return null;
      }
      case 'drain':
        return has(a, 'drain') ? { res: 'drain' } : null;
      case 'draw':
        return has(a, 'draw') ? { res: 'draw' } : null;
      case 'damage': {
        if (!a.outputs.some((o) => o.type === 'drain' && o.damage) || !isCreature(ctx, a.card)) return null;
        if (t.source === 'self' && a.card !== next.card) return null;
        return { res: 'damage', object: a.card };
      }
      case 'cast': {
        const casts = a.casts ?? [];
        const ok = t.what === 'any' ? casts.length > 0 : t.what === 'artifact' ? casts.includes('artifact') : casts.includes('instant') || casts.includes('sorcery');
        return ok ? { res: 'cast' } : null;
      }
    }
  }

  // Activated, recast or cast: bind to one of its costs.
  if (next.kind === 'cast' && next.from === 'library') {
    return has(a, 'toTop') && a.card === next.card ? { res: 'library', object: next.card } : null;
  }
  if (next.kind === 'cast') {
    const bounce = has(a, 'bounce');
    const bounces = bounce && (bounce.target === 'self' ? a.card === next.card : matchesTarget(bounce.target, nextCard, a.card));
    if (bounces) return { res: 'hand', object: next.card };
    const toHand = has(a, 'toHand');
    if (toHand && matchesTarget(toHand.target, nextCard, a.card)) {
      // Scrap Trawler: the returned card must have lesser mana value than the artifact that died.
      const lesserOk = !toHand.lesserMv || (input?.res === 'death' && input.object != null && mv(ctx, next.card) < mv(ctx, input.object));
      if (lesserOk) return { res: 'hand', object: next.card };
    }
  }
  const sac = next.cost.sacrifice;
  if (sac) {
    const entering = putsBodyOnBattlefield(a) ? enteringObject(abilities, i, ctx, input) : null;
    if (
      entering &&
      (sac.what === 'permanent' || entering.types.includes(sac.what)) &&
      !(sac.nontoken && entering.token) &&
      !(sac.another && entering.object === next.card)
    ) {
      return { res: 'body', ...entering };
    }
  }
  if (next.cost.tap) {
    const target = tapObject(abilities, nextIndex);
    if (untapReaches(abilities, i, target, ctx)) return { res: 'untap', object: target };
    // Recasting or returning a permanent brings it back as a new, untapped object.
    const reenters = a.card === target && (castsPermanent(a) || a.kind === 'recast' || Boolean(has(a, 'recur')));
    if (reenters && (!isCreature(ctx, target) || hasHaste(ctx, target))) return { res: 'untap', object: target };
  }
  // A blinked planeswalker returns as a new object, so its loyalty ability can be used again.
  if (next.cost.loyalty && blinkHits(abilities, i, next.card, ctx)) return { res: 'reset', object: next.card };
  if (totalMana(next.cost.mana) > 0 && (has(a, 'mana') || has(a, 'tokenMana'))) return { res: 'mana' };
  // Paying life (Aetherflux Reservoir) with life the loop gains back.
  if (next.cost.life > 0 && has(a, 'lifegain')) return { res: 'lifegain' };
  if (isFreeActivation(next)) return { res: 'free' };
  if (next.cost.removeCounter) {
    const counter = has(a, 'counter');
    const reaches =
      counter &&
      (counter.target === 'self'
        ? a.card === next.card
        : counter.target === 'host'
          ? isCreature(ctx, next.card)
          : matchesTarget(counter.target, nextCard, a.card));
    if (reaches) return { res: 'counter', object: next.card };
  }
  return null;
}

export { payMana };

function describeMana(m: ManaProduction): string {
  const parts = COLORS.flatMap((c) => Array<string>(m[c]).fill(`{${c}}`));
  if (m.any) parts.push(...Array<string>(m.any).fill('{any}'));
  return parts.join('') || 'none';
}

function addMana(into: ManaProduction, m: ManaProduction, times = 1) {
  for (const k of [...COLORS, 'any'] as const) into[k] += m[k] * times;
}

interface Events {
  deaths: { object: string | null; token: boolean; types: string[] }[];
  etbs: { object: string | null; token: boolean; types: string[] }[];
  casts: string[][];
  lifegains: number;
  drains: number;
  draws: number;
}

/** How many times a triggered ability outside the loop fires per iteration. */
function riderFires(r: Ability, ev: Events): number {
  const t = r.trigger!;
  switch (t.type) {
    case 'death':
      return ev.deaths.filter(
        (d) => d.types.includes(t.what) && !(t.nontoken && d.token) && !(t.another && d.object === r.card) && (!t.self || d.object === r.card),
      ).length;
    case 'etb':
      return ev.etbs.filter((e) => e.types.includes('creature') && !(t.nontoken && e.token) && !(t.another && e.object === r.card)).length;
    case 'cast':
      return ev.casts.filter((c) => (t.what === 'any' ? true : t.what === 'artifact' ? c.includes('artifact') : c.includes('instant') || c.includes('sorcery'))).length;
    case 'selfEtb':
      // A card re-entering during the loop (returned by Nim Deathmantle) triggers its own enter ability.
      return ev.etbs.filter((e) => e.object === r.card).length;
    case 'lifegain':
      return ev.lifegains > 0 ? 1 : 0;
    case 'drain':
      return ev.drains > 0 ? 1 : 0;
    case 'draw':
      return ev.draws;
    default:
      return 0;
  }
}

/** A card added to make a loop break even. */
export type Helper =
  | { kind: 'rider'; card: string; ability: Ability; fires: number }
  | { kind: 'reducer'; card: string; what: string; amount: number }
  | { kind: 'outlet'; card: string; ability: Ability }
  | { kind: 'rock'; card: string; ability: Ability }
  | { kind: 'activationReducer'; card: string; amount: number }
  | { kind: 'copier'; card: string; cost: number }
  /** The second target of a two-target flicker (Ghostly Flicker + Peregrine Drake). */
  | { kind: 'blinkTarget'; card: string; ability: Ability }
  | { kind: 'counterPreventer'; card: string }
  | { kind: 'etbDoubler'; card: string }
  | { kind: 'artifactTapper'; card: string; mana: ManaProduction }
  | { kind: 'counterBlocker'; card: string }
  | { kind: 'deathDoubler'; card: string }
  | { kind: 'landAmplifier'; card: string }
  | { kind: 'manaAmplifier'; card: string };

const HELPER_ORDER: Helper['kind'][] = [
  'rider',
  'reducer',
  'outlet',
  'rock',
  'activationReducer',
  'copier',
  'blinkTarget',
  'counterPreventer',
  'etbDoubler',
  'artifactTapper',
  'deathDoubler',
  'landAmplifier',
  'manaAmplifier',
  'counterBlocker',
];

function reducerApplies(what: string, casts: string[]): boolean {
  if (what === 'any') return true;
  if (what === 'noncreature') return !casts.includes('creature');
  if (what === 'instant and sorcery') return casts.includes('instant') || casts.includes('sorcery');
  return casts.includes(what);
}

/** A "Sacrifice a X: Add ..." ability with no other cost, usable on spare tokens. */
const isFreeOutlet = (a: Ability) =>
  a.kind === 'activated' && Boolean(a.cost.sacrifice) && !a.cost.tap && totalMana(a.cost.mana) === 0 && a.cost.life === 0 && !a.oncePerTurn && !a.unmodeledCost && Boolean(has(a, 'mana'));

/** A "{T}: Add ..." ability on a nonland permanent with no other cost. */
const isRock = (a: Ability, ctx: Context) =>
  a.kind === 'activated' && a.cost.tap && !a.cost.sacrifice && totalMana(a.cost.mana) === 0 && !a.host && Boolean(has(a, 'mana')) && !typesOf(ctx, a.card).includes('land');

const THEN: Record<Resource, (b: Binding, next: string) => string> = {
  free: (_, next) => `then activate ${next}'s ability`,
  mana: (_, next) => `its mana pays for ${next}`,
  body: (b, next) => `${b.object ?? 'the token'} is sacrificed to ${next}`,
  death: (b, next) => `${b.object ?? 'the token'} dying triggers ${next}`,
  selfEtb: (_, next) => `${next} enters, triggering its ability`,
  etb: (b, next) => `${b.object ?? 'the token'} entering triggers ${next}`,
  untap: (b) => `this untaps ${b.object}`,
  lifegain: (b, next) => (b.lifelinkFrom ? `the damage, with lifelink, gains life and triggers ${next}` : `the lifegain triggers ${next}`),
  drain: (_, next) => `the life loss triggers ${next}`,
  counter: (_, next) => `the counter pays ${next}'s cost`,
  reset: (b) => `this blinks ${b.object}, so it returns as a new object and its loyalty ability can be used again`,
  draw: (_, next) => `the draw triggers ${next}`,
  damage: (b, next) => `${b.object} dealing damage to an opponent triggers ${next}`,
  hand: (b) => `this returns ${b.object} to your hand`,
  library: (b) => `this puts ${b.object} on top of your library`,
  leave: (b, next) => `${b.object} leaving the battlefield triggers ${next}`,
  cast: (_, next) => `casting the spell triggers ${next}`,
};

const COLOR_NAMES: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless' };

/**
 * `seed`: for loops that recycle a creature which is not itself a step (Nim Deathmantle returning Wurmcoil
 * Engine to Ashnod's Altar), the creature being sacrificed and returned each time.
 */
function evaluate(cycle: Ability[], ctx: Context, seed?: string): EngineCombo | null {
  if (cycle.some((a) => a.oncePerTurn || a.unmodeledCost)) return null;
  const k = cycle.length;

  // Two laps so the first ability sees the binding produced by the last one (three with a seed, which
  // starts the circle: the sacrifice step consumes the seed creature before anything has returned it).
  const bindings: (Binding | null)[] = new Array(k).fill(null);
  const seedBody: Binding | undefined = seed ? { res: 'body', object: seed, token: false, types: typesOf(ctx, seed) } : undefined;
  for (let lap = 0; lap < (seed ? 3 : 2); lap++) {
    for (let i = 0; i < k; i++) {
      const prev = bindings[(i - 1 + k) % k] ?? (lap === 0 && cycle[i]!.cost.sacrifice ? seedBody : undefined);
      bindings[i] = feed(cycle, i, prev ?? undefined, ctx);
    }
  }
  if (bindings.some((b) => b === null)) return null;
  const bound = bindings as Binding[];
  const inputOf = (i: number) => bound[(i - 1 + k) % k]!;

  // Every {T} must be untapped again within the loop.
  // A permanent that leaves and comes back during the loop returns untapped (a creature needs haste to tap again).
  const reenters = (name: string) =>
    cycle.some((a) => a.card === name && (castsPermanent(a) || a.kind === 'recast' || Boolean(has(a, 'recur')))) &&
    (!isCreature(ctx, name) || hasHaste(ctx, name));
  for (let i = 0; i < k; i++) {
    if (!cycle[i]!.cost.tap) continue;
    const target = tapObject(cycle, i);
    if (!bound.some((b) => b.res === 'untap' && b.object === target) && !reenters(target)) return null;
  }
  // Every loyalty ability needs its planeswalker blinked within the loop.
  for (let i = 0; i < k; i++) {
    if (cycle[i]!.cost.loyalty && !bound.some((b) => b.res === 'reset' && b.object === cycle[i]!.card)) return null;
  }
  // Every sacrifice cost must be paid by a permanent the loop provides.
  for (let i = 0; i < k; i++) if (cycle[i]!.cost.sacrifice && inputOf(i).res !== 'body') return null;
  // Recursion only works for cards that died during the loop; casting from hand only for cards returned to hand.
  const died = new Set(
    [...cycle.flatMap((a, i) => (a.cost.sacrifice ? [inputOf(i).object] : [])), ...bound.filter((b) => b.res === 'death').map((b) => b.object)].filter(
      (o): o is string => Boolean(o),
    ),
  );
  const freeSacrifice = cycle.some((a) => a.kind === 'activated' && a.cost.sacrifice && !a.cost.tap && totalMana(a.cost.mana) === 0 && a.cost.life === 0);
  const extraSacrifices: string[] = [];
  for (const [i, a] of cycle.entries()) {
    if ((a.kind === 'recast' || has(a, 'recur')) && !died.has(a.card)) return null;
    // Instants and sorceries go to the graveyard when cast; permanents must have died first.
    const spellOnly = a.kind === 'cast' && !castsPermanent(a);
    if (a.kind === 'cast' && a.from === 'library') {
      if (!bound.some((b) => b.res === 'library' && b.object === a.card)) return null;
    } else if (a.kind === 'cast') {
      const returned = bound.some((b) => b.res === 'hand' && b.object === a.card);
      // Bounced permanents need not have died; Venser can bounce itself with a doubled trigger (checked below).
      const bounced = returned && cycle.some((c, j) => has(c, 'bounce') && bound[j]!.res === 'hand' && bound[j]!.object === a.card);
      const selfBounce = cycle.some((c) => c.card === a.card && has(c, 'bounce'));
      if (!((returned && (spellOnly || died.has(a.card) || bounced)) || selfBounce)) return null;
    }
    const reanimated = reanimatedObject(cycle, i, ctx);
    if (has(a, 'reanimate') && reanimated && !died.has(reanimated) && freeSacrifice) {
      // Reveillark's partner (Karmic Guide) has to die each loop too: sacrifice it to the loop's free outlet.
      died.add(reanimated);
      extraSacrifices.push(reanimated);
    }
    if (has(a, 'reanimate') && !(reanimated && died.has(reanimated))) return null;
  }
  // Counters removed must be put back.
  for (let i = 0; i < k; i++) if (cycle[i]!.cost.removeCounter && inputOf(i).res !== 'counter') return null;

  // Resolve "that much" amounts along the loop (Exquisite Blood gains as much as Aetherflux Reservoir dealt).
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < k; i++) {
      const out = cycle[i]!.outputs.find((o) => (o.type === 'lifegain' || o.type === 'drain') && (bound[i]!.res === 'lifegain' || bound[i]!.res === 'drain'));
      if (out && (out.type === 'lifegain' || out.type === 'drain')) bound[i]!.amount = out.amount === 0 ? (inputOf(i).amount ?? 1) : out.amount;
    }
  }
  const amountOf = (i: number, o: { amount: number }) => (o.amount === 0 ? (bound[i]!.amount ?? inputOf(i).amount ?? 1) : o.amount);

  const events: Events = { deaths: [], etbs: [], casts: [], lifegains: 0, drains: 0, draws: 0 };
  for (const name of extraSacrifices) events.deaths.push({ object: name, token: false, types: typesOf(ctx, name) });
  const baseMana = emptyProduction();
  let baseLife = 0;
  let damage = false;
  let tokens = 0;
  let hasteTokens = false;
  let counters = 0;
  /** Tokens the loop creates but does not consume: fodder for a sacrifice outlet. */
  const spare: string[][] = [];
  const prerequisites = new Set<string>();
  let hostOk = true;

  cycle.forEach((a, i) => {
    baseLife -= a.cost.life;
    if (a.cost.removeCounter) counters--;
    if (a.cost.sacrifice) events.deaths.push({ object: inputOf(i).object ?? null, token: inputOf(i).token ?? false, types: inputOf(i).types ?? [] });
    else if (bound[i]!.res === 'death') events.deaths.push({ object: bound[i]!.object ?? null, token: false, types: bound[i]!.types ?? [] });
    if (a.casts) events.casts.push(a.casts);
    const entering = putsBodyOnBattlefield(a) || has(a, 'blink') ? enteringObject(cycle, i, ctx, inputOf(i)) : null;
    if (entering?.types.includes('creature')) events.etbs.push(entering);
    const consumedAsBody = bound[i]!.res === 'body';
    let tokenSelfSacrificed = false;
    for (const o of a.outputs) {
      if (o.type === 'mana' && !o.variable) addMana(baseMana, o.mana);
      // A token that sacrifices itself for mana cannot also be the fodder passed to the next step.
      if (o.type === 'tokenMana' && !consumedAsBody) {
        addMana(baseMana, o.mana);
        events.deaths.push({ object: null, token: true, types: ['creature'] });
        tokenSelfSacrificed = true;
      }
      if (o.type === 'lifegain') {
        baseLife += amountOf(i, o);
        events.lifegains++;
      }
      if (o.type === 'drain') {
        events.drains++;
        damage ||= o.damage;
      }
      if (o.type === 'selfLifeLoss') baseLife -= o.amount;
      if (o.type === 'creature') {
        tokens += o.count;
        hasteTokens ||= o.haste;
      }
      if (o.type === 'copy') {
        tokens++;
        hasteTokens ||= o.haste;
      }
      if (o.type === 'counter') counters++;
      if (o.type === 'draw') events.draws += o.amount;
    }
    // Tokens not passed on as fodder and not sacrificed for their own mana are left over.
    const made = has(a, 'creature');
    if (made) {
      const left = made.count - (consumedAsBody ? 1 : 0) - (tokenSelfSacrificed ? 1 : 0);
      for (let n = 0; n < left; n++) spare.push(made.artifact ? ['artifact', 'creature'] : ['creature']);
    }
    const b = bound[i]!;
    if (b.lifelinkFrom) {
      baseLife += 1;
      events.lifegains++;
      if (b.lifelinkFrom !== a.card) prerequisites.add(`${b.lifelinkFrom} gives ${a.card} lifelink`);
    }
    // Rules-text conditions ("as long as you control a zombie") are prefixed with their card; synthesized ones are full sentences.
    for (const c of a.conditions) prerequisites.add(/^(as long as|if you control)/.test(c) ? `${a.card}: ${c}` : c);
    if (a.host) {
      const host = hostOf(cycle, i);
      if (!isCreature(ctx, host)) hostOk = false;
      if (a.hostVia === 'paired') prerequisites.add(host === a.card ? `${a.card} is paired with another creature` : `${a.card} is paired with ${host}`);
      else prerequisites.add(`${a.card} is attached to ${host}`);
    }
  });
  if (!hostOk) return null;

  // Fiend Hunter returns the card its enter ability exiled, so it must have entered during the loop.
  for (const [i, a] of cycle.entries()) {
    const returned = returnedExiled(a, cycle[(i + 1) % k]!, ctx);
    if (!has(a, 'returnExiled')) continue;
    if (!returned || !events.etbs.some((e) => e.object === a.card)) return null;
    prerequisites.add(`${a.card}'s enter ability exiles ${returned} each time`);
  }
  for (const a of [...cycle]) {
    if (a.outputs.some((o) => o.type === 'mana' && o.fromLands)) prerequisites.add(`${a.card}: assumes the lands it untaps make the colors you need`);
  }

  const loopCardSet = new Set(cycle.flatMap((a) => (a.with ? [a.card, a.with] : [a.card])));
  if (seed) {
    if (!bound.some((b) => b.object === seed)) return null;
    loopCardSet.add(seed);
  }
  const inCycle = new Set(cycle.map((a) => a.id.replace(/~\d+$/, '')));

  // Triggered abilities elsewhere in the deck that fire on this loop's events.
  const riders = ctx.deckAbilities
    .filter((r) => r.kind === 'triggered' && !inCycle.has(r.id) && !r.unmodeledCost && !r.oncePerTurn)
    .map((r) => ({ ability: r, fires: riderFires(r, events) }))
    .filter((x) => x.fires > 0);

  const castAbilities = cycle.filter((a) => a.kind === 'cast');
  const untapsAll = cycle.some((a) => a.outputs.some((o) => o.type === 'untap' && o.all));
  const cycleOutlets = cycle.filter(isFreeOutlet);
  const manaActivated = cycle.filter((a) => a.kind === 'activated' && totalMana(a.cost.mana) > 0 && typesOf(ctx, a.card).includes('artifact'));
  const copyable = cycle.flatMap((a) => {
    if (a.kind !== 'activated' || has(a, 'mana')) return [];
    const untap = has(a, 'untap');
    if (!untap || untap.target !== 'self') return [];
    const rock = cycle.find((m) => m.card === a.card && m.cost.tap && has(m, 'mana'));
    return rock ? [has(rock, 'mana')!.mana] : [];
  });

  // Permanents entering per loop (for Urza tapping artifacts, and Panharmonicon doubling enter triggers).
  const entering = cycle.map((a, i) => (putsBodyOnBattlefield(a) || has(a, 'blink') ? enteringObject(cycle, i, ctx, inputOf(i)) : null));
  const artifactEntries = entering.filter((e) => e?.types.includes('artifact')).length;
  const doublable = cycle.filter(
    (a, i) => a.kind === 'triggered' && (a.trigger?.type === 'selfEtb' || a.trigger?.type === 'etb') && ['artifact', 'creature'].some((t) => (inputOf(i).types ?? typesOf(ctx, a.card)).includes(t)),
  );
  // Venser bouncing itself needs its enter trigger to happen twice.
  // (Palinchron returning itself with an activated ability needs no doubler.)
  const needsDoubler = cycle.some(
    (a) => a.kind === 'cast' && cycle.some((c, j) => c.card === a.card && has(c, 'bounce') && bound[j]!.res === 'hand' && bound[j]!.object !== c.card),
  );
  const massReanimate = cycle.some((a) => has(a, 'massReanimate'));
  let extraCreatures = 0;
  // Mana that scales with the board (Priest of Titania): the loop picks how many units it needs.
  const variableMana = cycle.flatMap((a) => a.outputs.flatMap((o) => (o.type === 'mana' && o.variable ? [{ card: a.card, mana: o.mana, variable: o.variable }] : [])));
  const MAX_VARIABLE = 12;
  let variableX = 0;
  const deathTriggered = cycle.filter((a) => a.trigger?.type === 'death');
  const landMana = cycle.flatMap((a) => a.outputs.flatMap((o) => (o.type === 'mana' && o.fromLands ? [o.mana] : [])));
  const nonlandManaTaps = cycle.flatMap((a) => {
    const m = has(a, 'mana');
    return a.kind === 'activated' && a.cost.tap && m && !typesOf(ctx, a.card).includes('land') ? [m.mana] : [];
  });

  const ledgerFor = (helpers: Helper[], extra = 0, x = 0): { mana: ManaProduction; cost: ManaCost; life: number } => {
    const mana = { ...baseMana };
    for (const v of variableMana) addMana(mana, v.mana, x);
    const firstUnit = (m: ManaProduction): ManaProduction => {
      const one = emptyProduction();
      const key = ([...COLORS, 'any'] as const).find((k) => m[k] > 0);
      if (key) one[key] = 1;
      return one;
    };
    if (helpers.some((h) => h.kind === 'deathDoubler')) for (const a of deathTriggered) for (const o of a.outputs) if (o.type === 'mana' && !o.variable) addMana(mana, o.mana);
    if (helpers.some((h) => h.kind === 'landAmplifier')) for (const m of landMana) addMana(mana, { ...emptyProduction(), U: totalProduction(m) });
    if (helpers.some((h) => h.kind === 'manaAmplifier')) for (const m of nonlandManaTaps) addMana(mana, firstUnit(m));
    const cost = emptyCost();
    let life = baseLife;
    const reducers = helpers.filter((h): h is Extract<Helper, { kind: 'reducer' }> => h.kind === 'reducer');
    const actReducer = helpers.find((h): h is Extract<Helper, { kind: 'activationReducer' }> => h.kind === 'activationReducer');
    const reducedCard = actReducer ? manaActivated[0]?.card : undefined;
    for (const a of cycle) {
      const c = { ...a.cost.mana };
      if (a.kind === 'cast') for (const r of reducers) if (reducerApplies(r.what, a.casts ?? [])) c.generic = Math.max(0, c.generic - r.amount);
      if (actReducer && a.card === reducedCard && a.kind === 'activated' && totalMana(c) > 0) {
        // "can't reduce the mana in that cost to less than one mana"
        c.generic = Math.max(0, c.generic - Math.min(actReducer.amount, totalMana(c) - 1));
      }
      for (const key of [...COLORS, 'generic'] as const) cost[key] += c[key];
    }
    // Riders and the tokens they make.
    const spareBodies = [...spare];
    const riderTimes = (h: Extract<Helper, { kind: 'rider' }>) => h.fires * (h.ability.trigger?.type === 'death' && helpers.some((d) => d.kind === 'deathDoubler') ? 2 : 1);
    for (const h of helpers) {
      if (h.kind === 'rider') {
        for (const o of h.ability.outputs) {
          if (o.type === 'mana') addMana(mana, o.mana, riderTimes(h));
          if (o.type === 'lifegain') life += o.amount * h.fires;
          if (o.type === 'selfLifeLoss') life -= o.amount * h.fires;
          if (o.type === 'creature') for (let n = 0; n < o.count * h.fires; n++) spareBodies.push(o.artifact ? ['artifact', 'creature'] : ['creature']);
        }
      }
      if (h.kind === 'rock') addMana(mana, has(h.ability, 'mana')!.mana);
      if (h.kind === 'copier' && copyable.length) {
        addMana(mana, copyable[0]!);
        cost.generic += h.cost;
      }
      if (h.kind === 'blinkTarget') {
        for (const o of h.ability.outputs) {
          if (o.type === 'mana') addMana(mana, o.mana);
          if (o.type === 'lifegain') life += o.amount;
        }
      }
    }
    if (helpers.some((h) => h.kind === 'etbDoubler')) {
      for (const a of doublable) for (const o of a.outputs) if (o.type === 'mana') addMana(mana, o.mana);
    }
    for (const h of helpers) if (h.kind === 'artifactTapper') addMana(mana, h.mana, artifactEntries);
    // Living Death returns every creature card, which the outlet sacrifices again: the loop card plus `extra` others.
    if (massReanimate) for (let n = 0; n < 1 + extra; n++) spareBodies.push(['creature']);
    for (const name of extraSacrifices) spareBodies.push(typesOf(ctx, name));
    // Spare tokens go to the best free sacrifice outlet available.
    const outlets = [...cycleOutlets, ...helpers.flatMap((h) => (h.kind === 'outlet' ? [h.ability] : []))];
    for (const body of spareBodies) {
      const usable = outlets.filter((o) => o.cost.sacrifice!.what === 'permanent' || body.includes(o.cost.sacrifice!.what));
      const best = usable.sort((x, y) => totalProduction(has(y, 'mana')!.mana) - totalProduction(has(x, 'mana')!.mana))[0];
      if (best) addMana(mana, has(best, 'mana')!.mana);
    }
    return { mana, cost, life };
  };

  const hasEvents =
    events.deaths.length > 0 || events.etbs.length > 0 || events.casts.length > 0 || events.draws > 0 || events.drains > 0 || events.lifegains > 0 || counters > 0 || tokens > 0;
  // -1/-1 counter costs need Vizier of Remedies, unless the creature is meant to die and come back (undying).
  const needsPreventer = cycle.some((a) => a.cost.minusCounter && !cycle.some((b) => b.card === a.card && /#(undying|persist)$/.test(b.id)));
  const worksWith = (helpers: Helper[], extra: number, x: number) => {
    const l = ledgerFor(helpers, extra, x);
    const left = payMana(l.mana, l.cost);
    return left !== null && l.life >= 0 && (hasEvents || totalProduction(left) > 0);
  };
  const MAX_EXTRA_CREATURES = 8;
  /** Smallest board requirements (other creatures for Living Death, units of variable mana) that make it work. */
  const params = (helpers: Helper[]): { extra: number; x: number } | null => {
    if (needsPreventer && !helpers.some((h) => h.kind === 'counterPreventer')) return null;
    if (needsDoubler && !helpers.some((h) => h.kind === 'etbDoubler')) return null;
    const xs = variableMana.length ? Array.from({ length: MAX_VARIABLE }, (_, n) => n + 1) : [0];
    const extras = massReanimate ? Array.from({ length: MAX_EXTRA_CREATURES + 1 }, (_, n) => n) : [0];
    for (const x of xs) for (const extra of extras) if (worksWith(helpers, extra, x)) return { extra, x };
    return null;
  };
  const works = (helpers: Helper[]) => params(helpers) !== null;

  // Triggers of cards already in the loop (Wurmcoil Engine's own death trigger) always happen: no extra card needed.
  const ownTriggers: Helper[] = riders
    .filter((r) => loopCardSet.has(r.ability.card))
    .map((r) => ({ kind: 'rider', card: r.ability.card, ability: r.ability, fires: r.fires }));
  let helpers: Helper[] = [...ownTriggers];
  let candidates: Helper[] = [];
  if (!works(helpers)) {
    const seen = new Set<string>(loopCardSet);
    const add = (h: Helper) => {
      if (seen.has(`${h.kind}:${h.card}`) || loopCardSet.has(h.card)) return;
      seen.add(`${h.kind}:${h.card}`);
      candidates.push(h);
    };
    for (const { ability, fires } of riders) {
      const useful = ability.outputs.some((o) => (o.type === 'mana') || (o.type === 'lifegain') || (o.type === 'creature' && (cycleOutlets.length > 0 || ctx.deckAbilities.some(isFreeOutlet))));
      if (useful) add({ kind: 'rider', card: ability.card, ability, fires });
    }
    for (const r of ctx.reducers) if (castAbilities.some((a) => reducerApplies(r.what, a.casts ?? []))) add({ kind: 'reducer', ...r });
    for (const a of ctx.deckAbilities) if (isFreeOutlet(a) && !inCycle.has(a.id)) add({ kind: 'outlet', card: a.card, ability: a });
    if (untapsAll) for (const a of ctx.deckAbilities) if (isRock(a, ctx)) add({ kind: 'rock', card: a.card, ability: a });
    if (manaActivated.length) for (const r of ctx.activationReducers) add({ kind: 'activationReducer', ...r });
    if (copyable.length) for (const c of ctx.copiers) add({ kind: 'copier', ...c });
    if (needsPreventer) for (const card of ctx.counterPreventers) add({ kind: 'counterPreventer', card });
    if (needsDoubler || doublable.some((a) => has(a, 'mana'))) for (const card of ctx.etbDoublers) add({ kind: 'etbDoubler', card });
    if (artifactEntries) for (const t of ctx.artifactTappers) add({ kind: 'artifactTapper', ...t });
    const deathRiders = riders.some((r) => r.ability.trigger?.type === 'death' && r.ability.outputs.some((o) => o.type === 'mana'));
    if (deathRiders || deathTriggered.some((a) => has(a, 'mana'))) for (const card of ctx.deathDoublers) add({ kind: 'deathDoubler', card });
    if (landMana.length) for (const card of ctx.landAmplifiers) add({ kind: 'landAmplifier', card });
    if (nonlandManaTaps.length) for (const card of ctx.manaAmplifiers) add({ kind: 'manaAmplifier', card });
    const twoTargetBlink = cycle.find((a) => has(a, 'blink')?.count === 2);
    if (twoTargetBlink) {
      const spec = has(twoTargetBlink, 'blink')!.target;
      for (const b of ctx.deckAbilities) {
        if (b.trigger?.type !== 'selfEtb' || loopCardSet.has(b.card) || typeof spec === 'string') continue;
        if (matchesTarget(spec, ctx.cardByName.get(b.card)!, twoTargetBlink.card)) add({ kind: 'blinkTarget', card: b.card, ability: b });
      }
    }
    candidates = candidates
      .sort((x, y) => HELPER_ORDER.indexOf(x.kind) - HELPER_ORDER.indexOf(y.kind) || x.card.localeCompare(y.card))
      .slice(0, 16);

    // Smallest set of up to three helpers that makes the loop work, in a fixed order.
    const tryWith = (extra: Helper[]) => works([...ownTriggers, ...extra]);
    const found = (() => {
      const n = candidates.length;
      for (let a = 0; a < n; a++) if (tryWith([candidates[a]!])) return [candidates[a]!];
      for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (tryWith([candidates[a]!, candidates[b]!])) return [candidates[a]!, candidates[b]!];
      for (let a = 0; a < n; a++)
        for (let b = a + 1; b < n; b++)
          for (let c = b + 1; c < n; c++) if (tryWith([candidates[a]!, candidates[b]!, candidates[c]!])) return [candidates[a]!, candidates[b]!, candidates[c]!];
      return null;
    })();
    if (!found) return null;
    helpers = [...ownTriggers, ...found];
  }

  const helperAlternatives: Record<string, string[]> = {};
  for (const h of helpers) {
    const alts = candidates
      .filter((c) => c.card !== h.card && !helpers.some((y) => y.card === c.card))
      .filter((c) => works(helpers.map((y) => (y === h ? c : y))))
      .filter(() => !ownTriggers.includes(h))
      .map((c) => c.card);
    if (alts.length) helperAlternatives[h.card] = [...new Set(alts)].sort();
  }
  for (const h of helpers) {
    if (h.kind === 'rider') for (const c of h.ability.conditions) prerequisites.add(`${h.card}: ${c}`);
    if (h.kind === 'activationReducer' && manaActivated[0]) prerequisites.add(`${h.card} is attached to ${manaActivated[0].card}`);
    if (h.kind === 'blinkTarget') {
      prerequisites.add(`${h.card} is the second target of each flicker`);
      if (h.ability.outputs.some((o) => o.type === 'mana' && o.fromLands)) prerequisites.add(`${h.card}: assumes the lands it untaps make the colors you need`);
    }
  }

  const loopCards = [...loopCardSet];
  const helperCards = [...new Set(helpers.map((h) => h.card))].filter((c) => !loopCardSet.has(c));
  const pieces = new Set([...loopCards, ...helperCards]);

  const payoffs: EngineCombo['payoffs'] = [];
  const warnings: string[] = [];
  for (const { ability } of riders) {
    if (helpers.some((h) => h.kind === 'rider' && h.ability === ability) || pieces.has(ability.card)) continue;
    if (ability.outputs.some((o) => o.type === 'selfLifeLoss')) warnings.push(`${ability.card} makes you lose life each loop: ${ability.text}`);
    else payoffs.push({ card: ability.card, effect: ability.text });
  }

  const chosen = params(helpers) ?? { extra: 0, x: 0 };
  extraCreatures = chosen.extra;
  variableX = chosen.x;
  if (extraCreatures) prerequisites.add(`You have at least ${extraCreatures} other creature cards in your graveyard or on the battlefield`);
  for (const v of variableMana) prerequisites.add(`${v.card} makes at least ${variableX} mana (${v.variable})`);
  for (const h of helpers) {
    if (h.kind === 'landAmplifier') prerequisites.add(`${h.card} was cast this turn and the lands untapped are Islands`);
  }
  const final = ledgerFor(helpers, extraCreatures, variableX);
  if (!payMana(final.mana, final.cost)) return null;


  // Play the loop out on a concrete game state; the resource check above is necessary but not sufficient.
  const plan: LoopPlan = {
    cycle,
    bindings: bound,
    helpers,
    hosts: Object.fromEntries(cycle.flatMap((a, i) => (a.host ? [[i, hostOf(cycle, i)]] : []))),
    exiles: Object.fromEntries(cycle.flatMap((a, i) => {
      const returned = returnedExiled(a, cycle[(i + 1) % k]!, ctx);
      return returned ? [[a.card, returned]] : [];
    })),
    reanimates: Object.fromEntries(cycle.flatMap((_, i) => {
      const r = reanimatedObject(cycle, i, ctx);
      return r ? [[i, r]] : [];
    })),
    reducedCard: helpers.some((h) => h.kind === 'activationReducer') ? manaActivated[0]?.card : undefined,
    extraCreatures,
    variableX,
    extraSacrifices,
  };
  let verification = verifyLoop(plan, ctx);
  // Undying/persist creatures can come back every time if counters can't be put on them (Solemnity).
  if (!verification.ok && /(undying|persist) does not return/.test(verification.reason ?? '') && ctx.counterBlockers.length) {
    const blocker: Helper = { kind: 'counterBlocker', card: ctx.counterBlockers[0]! };
    const retry = verifyLoop({ ...plan, helpers: [...helpers, blocker] }, ctx);
    if (retry.ok) {
      helpers.push(blocker);
      plan.helpers = helpers;
      verification = retry;
      if (!loopCards.includes(blocker.card) && !helperCards.includes(blocker.card)) helperCards.push(blocker.card);
      if (ctx.counterBlockers.length > 1) helperAlternatives[blocker.card] = ctx.counterBlockers.slice(1);
    }
  }
  if (!verification.ok) {
    ctx.rejected.push({ cards: [...loopCards, ...helperCards], reason: verification.reason ?? 'fails when played out' });
    return null;
  }
  const exact = verification.perLoop.mana;

  // Describe what the loop makes from the simulator's exact per-loop numbers.
  const per = verification.perLoop;
  const produces: string[] = [];
  if (totalProduction(exact) > 0) {
    produces.push(exact.any > 0 ? 'Infinite mana of any color' : `Infinite ${COLORS.filter((c) => exact[c] > 0).map((c) => COLOR_NAMES[c]).join(' and ')} mana`);
  }
  if (per.deaths) produces.push('Infinite death triggers');
  if (per.deaths && (cycle.some((a) => a.cost.sacrifice) || helpers.some((h) => h.kind === 'outlet'))) produces.push('Infinite sacrifice triggers');
  if (tokens) produces.push(hasteTokens ? 'Infinite hasty creature tokens' : 'Infinite creature tokens');
  if (per.etbs) produces.push('Infinite creature ETBs');
  if (per.casts) produces.push('Infinite spell casts');
  if (per.opponentLife < 0) produces.push(damage ? 'Infinite damage' : 'Infinite life loss for opponents');
  if (per.life > 0) produces.push('Infinite lifegain');
  if (counters > 0) produces.push('Infinite +1/+1 counters');
  if (per.draws) produces.push('Infinite card draw');
  if (produces.length === 0) return null;

  return {
    cards: [...loopCards, ...helperCards],
    loop: loopCards,
    helpers: helperCards,
    helperAlternatives,
    steps: cycle.map((a, i) => ({ card: a.card, ability: a.text, then: THEN[bound[i]!.res](bound[i]!, cycle[(i + 1) % k]!.card) })),
    produces: [...new Set(produces)],
    prerequisites: [...prerequisites],
    payoffs,
    warnings,
    netMana: describeMana(exact),
    verification: { startup: verification.startup, perLoop: verification.perLoop },
  };
}

/**
 * A "when ~ dies" trigger (undying, Myr Retriever) after step `v` needs that very card to die there:
 * either `v` kills itself, or `v` sacrifices a body that the step before it put onto the battlefield.
 * The full check in `feed` would reject anything else; this just avoids exploring it.
 */
function selfDeathPossible(prev: Ability | null, v: Ability, w: Ability): boolean {
  const t = w.trigger;
  if (!t || t.type !== 'death' || !t.self) return true;
  if (!v.cost.sacrifice) return v.card === w.card;
  if (!prev) return true; // v starts the path; its input comes from the (unknown) last step.
  if (prev.card === w.card && putsBodyOnBattlefield(prev)) return true;
  return Boolean(has(prev, 'blink') || has(prev, 'reanimate') || has(prev, 'returnExiled'));
}

/** Which resources an ability can take as its loop input. */
function inputs(a: Ability): Resource[] {
  if (a.kind === 'triggered') {
    const byTrigger: Record<NonNullable<Ability['trigger']>['type'], Resource> = {
      death: 'death',
      selfEtb: 'selfEtb',
      etb: 'etb',
      lifegain: 'lifegain',
      drain: 'drain',
      draw: 'draw',
      damage: 'damage',
      cast: 'cast',
      leave: 'leave',
    };
    return [byTrigger[a.trigger!.type]];
  }
  const r: Resource[] = [];
  if (isFreeActivation(a)) r.push('free');
  if (a.kind === 'cast') r.push(a.from === 'library' ? 'library' : 'hand');
  if (a.cost.life > 0) r.push('lifegain');
  if (a.cost.loyalty) r.push('reset');
  if (a.cost.sacrifice) r.push('body');
  if (a.cost.tap) r.push('untap');
  if (totalMana(a.cost.mana) > 0) r.push('mana');
  if (a.cost.removeCounter) r.push('counter');
  return r;
}

/** Which resources an ability can produce for the next step (a superset; `feed` checks the details). */
function outputsOf(a: Ability, ctx: Context): Resource[] {
  const r = new Set<Resource>(['free']);
  if (has(a, 'mana') || has(a, 'tokenMana')) r.add('mana');
  if (putsBodyOnBattlefield(a)) r.add('body').add('etb');
  if (castsPermanent(a) || a.kind === 'recast' || has(a, 'recur')) r.add('untap');
  if (
    a.kind === 'recast' ||
    castsPermanent(a) ||
    has(a, 'recur') ||
    has(a, 'copy') ||
    has(a, 'blink') ||
    has(a, 'reanimate') ||
    has(a, 'returnExiled') ||
    has(a, 'massReanimate') ||
    has(a, 'recurDied')
  ) {
    r.add('selfEtb');
  }
  if (has(a, 'blink')) r.add('etb').add('untap').add('reset').add('leave');
  if (has(a, 'draw')) r.add('draw');
  if (a.cost.sacrifice) r.add('death').add('leave');
  // Pinging itself or piling -1/-1 counters on itself can kill the creature (undying/persist loops).
  if (isCreature(ctx, a.card) && (a.cost.minusCounter || a.outputs.some((o) => o.type === 'drain' && o.damage))) r.add('death');
  if (has(a, 'untap')) r.add('untap');
  if (has(a, 'toHand') || has(a, 'bounce')) r.add('hand');
  if (has(a, 'toTop')) r.add('library');
  if (a.casts?.length) r.add('cast');
  if (has(a, 'lifegain')) r.add('lifegain');
  if (has(a, 'drain')) {
    r.add('drain');
    if (a.outputs.some((o) => o.type === 'drain' && o.damage)) {
      r.add('damage');
      if (ctx.granters.length) r.add('lifegain');
    }
  }
  if (has(a, 'counter')) r.add('counter');
  return [...r];
}

/**
 * Undying / persist as explicit death triggers: the creature's own keyword, or granted by another card
 * ("Other non-Human creatures you control get +1/+1 and have undying", Mikaeus). Whether the creature
 * actually returns (it must die without a +1/+1 / -1/-1 counter) is checked by the simulator.
 */
function deathReturnAbilities(card: Card, deck: Card[]): Ability[] {
  if (!/\bCreature\b/.test(card.typeLine)) return [];
  const out: Ability[] = [];
  for (const keyword of ['undying', 'persist'] as const) {
    const granter = card.keywords.includes(keyword)
      ? null
      : deck.find((g) => {
          if (g === card) return false;
          const m = new RegExp(`(other )?(?:non-(\\w+) )?creatures you control (?:get [^.]* and )?have ${keyword}`).exec(g.text);
          return Boolean(m) && !(m![2] && new RegExp(`\\b${m![2]}\\b`, 'i').test(card.typeLine));
        });
    if (granter === undefined) continue;
    out.push({
      id: `${card.name}#${keyword}`,
      card: card.name,
      text: granter ? `${keyword[0]!.toUpperCase()}${keyword.slice(1)} (granted by ${granter.name})` : `${keyword[0]!.toUpperCase()}${keyword.slice(1)}`,
      kind: 'triggered',
      trigger: { type: 'death', self: true, another: false, nontoken: true, what: 'creature' },
      cost: { mana: emptyCost(), tap: false, sacrifice: null, life: 0, removeCounter: false, loyalty: false },
      host: false,
      outputs: keyword === 'undying' ? [{ type: 'recur' }, { type: 'counter', target: 'self', amount: 1 }] : [{ type: 'recur' }],
      oncePerTurn: false,
      conditions: [],
      unmodeledCost: false,
      with: granter?.name,
    });
  }
  return out;
}

export function findEngineCombos(
  cards: Card[],
  options: Partial<EngineOptions> = {},
): { combos: EngineCombo[]; exhaustive: boolean; rejected: RejectedLoop[] } {
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  const sorted = [...cards].sort((a, b) => a.name.localeCompare(b.name));
  const parsed = sorted.flatMap((c) => parseAbilities(c));
  const cardByName = new Map(sorted.map((c) => [c.name, c]));

  // Synthetic abilities: Isochron Scepter casting each eligible instant, and casting cards that can be returned to hand.
  const imprints = sorted.flatMap((c) => imprintAbilities(c, sorted));
  const handTargets = parsed.flatMap((a) => a.outputs.flatMap((o) => (o.type === 'toHand' || o.type === 'bounce' ? [{ spec: o.target, source: a.card }] : [])));
  const casts = sorted
    .filter((c) => !/\bLand\b/.test(c.typeLine) && handTargets.some((t) => (t.spec === 'self' ? t.source === c.name : matchesTarget(t.spec, c, t.source))))
    .map((c) => castFromHand(c));
  // Cards that put themselves on top of the library (Sensei's Divining Top), recast with Mystic Forge.
  const enablers = sorted.flatMap((c) => castFromTopEnabler(c) ?? []);
  for (const a of parsed) {
    if (!has(a, 'toTop')) continue;
    const card = cardByName.get(a.card)!;
    const colorless = card.colorIdentity.length === 0 || !/[WUBRG]/.test(card.manaCost);
    const enabler = enablers.find((e) => e.what === 'any' || /\bArtifact\b/.test(card.typeLine) || colorless);
    if (enabler) casts.push(castFromHand(card, 'library', enabler.card));
  }
  const deathReturns = sorted.flatMap((c) => deathReturnAbilities(c, sorted));
  const deckAbilities = [...parsed, ...imprints, ...casts, ...deathReturns];

  const ctx: Context = {
    cardByName,
    granters: lifelinkGranters(sorted),
    reducers: sorted.flatMap((c) => costReducers(c)),
    activationReducers: sorted.flatMap((c) => activationReducer(c) ?? []),
    copiers: sorted.flatMap((c) => abilityCopier(c) ?? []),
    counterPreventers: sorted.filter(preventsMinusCounter).map((c) => c.name),
    etbDoublers: sorted.filter(etbDoubler).map((c) => c.name),
    artifactTappers: sorted.flatMap((c) => artifactTapper(c) ?? []),
    counterBlockers: sorted.filter(blocksCounters).map((c) => c.name),
    deathDoublers: sorted.filter(deathDoubler).map((c) => c.name),
    landAmplifiers: sorted.filter(landAmplifier).map((c) => c.name),
    manaAmplifiers: sorted.filter(manaAmplifier).map((c) => c.name),
    deckAbilities,
    rejected: [],
  };

  // Free sacrifice outlets may be used twice per loop (two artifacts to Krark-Clan Ironworks, or a persist
  // creature dying twice to Viscera Seer between Nim Deathmantle returns).
  const usable = deckAbilities.filter((a) => !a.oncePerTurn && !a.unmodeledCost);
  const freeSacrifice = (a: Ability) => a.kind === 'activated' && Boolean(a.cost.sacrifice) && !a.cost.tap && totalMana(a.cost.mana) === 0 && a.cost.life === 0;
  const nodes = usable.flatMap((a) => (freeSacrifice(a) ? [a, { ...a, id: `${a.id}~2` }] : [a]));

  const out: number[][] = nodes.map((a) => {
    const produced = new Set(outputsOf(a, ctx));
    // Self-loops are allowed (Isochron Scepter + Dramatic Reversal untaps itself).
    // A card is cast from hand right after something returns it, so cast steps are only entered that way.
    return nodes.flatMap((b, j) => {
      if (b.kind === 'cast') {
        // Venser-style cards return themselves (with a doubled trigger), so their cast can follow any mana source.
        const selfBouncer = b.from !== 'library' && usable.some((x) => x.card === b.card && has(x, 'bounce'));
        return produced.has(b.from === 'library' ? 'library' : 'hand') || (selfBouncer && produced.has('mana')) ? [j] : [];
      }
      return inputs(b).some((r) => produced.has(r)) ? [j] : [];
    });
  });

  const results = new Map<string, EngineCombo & { size: number; surplus: number }>();
  // Creatures a Nim Deathmantle-style loop could recycle.
  const recyclable = sorted.filter((c) => /\bCreature\b/.test(c.typeLine)).map((c) => c.name);
  const into: number[][] = nodes.map(() => []);
  out.forEach((targets, from) => targets.forEach((to) => into[to]!.push(from)));

  /** Enumerate loops whose first ability is `s`, up to `allowance` DFS steps. Returns steps used, or -1 if cut short. */
  const searchFrom = (s: number, allowance: number): number => {
    // Steps from each ability back to the start, through abilities after it (each loop is found once, from its first ability).
    const back = new Map<number, number>([[s, 0]]);
    const queue = [s];
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi]!;
      for (const u of into[v]!) {
        if (u > s && !back.has(u)) {
          back.set(u, back.get(v)! + 1);
          queue.push(u);
        }
      }
    }
    if (!out[s]!.some((w) => w === s || back.has(w))) return 0;
    let steps = 0;
    const path = [s];
    const onPath = new Set([s]);
    const frames: [number, number][] = [[s, 0]];
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      const [v, i] = frame;
      if (i >= out[v]!.length) {
        frames.pop();
        path.pop();
        onPath.delete(v);
        continue;
      }
      frame[1]++;
      if (++steps > allowance) return -1;
      const w = out[v]![i]!;
      if (w === s) {
        const cycleAbilities = path.map((p) => nodes[p]!);
        const seeds = cycleAbilities.some((a) => has(a, 'recurDied')) ? recyclable : [undefined];
        for (const seed of seeds) {
        const combo = evaluate(cycleAbilities, ctx, seed);
        if (combo) {
          // Same cards: prefer the shorter loop, then the one that leaves more mana over.
          const key = [...combo.cards].sort().join('|');
          const existing = results.get(key);
          const surplus = combo.netMana === 'none' ? 0 : combo.netMana.split('}').length - 1;
          if (!existing || path.length < existing.size || (path.length === existing.size && surplus > existing.surplus)) {
            results.set(key, { ...combo, size: path.length, surplus });
          }
        }
        }
        continue;
      }
      const d = back.get(w);
      // Prune paths that cannot get back to the start within the step limit.
      if (w < s || d === undefined || onPath.has(w) || path.length + d > opts.maxLoopAbilities) continue;
      if (!selfDeathPossible(path.length >= 2 ? nodes[path[path.length - 2]!]! : null, nodes[v]!, nodes[w]!)) continue;
      path.push(w);
      onPath.add(w);
      frames.push([w, 0]);
    }
    return steps;
  };

  // Pass 1: an even share per start. Pass 2: budget the easy starts did not use goes to the ones cut short.
  // Same total budget, same order, so the result is still deterministic.
  const share = Math.max(2000, Math.floor(opts.searchBudget / Math.max(1, nodes.length)));
  let used = 0;
  const starved: number[] = [];
  for (let s = 0; s < nodes.length; s++) {
    const steps = searchFrom(s, share);
    if (steps < 0) {
      starved.push(s);
      used += share;
    } else used += steps;
  }
  let leftover = Math.max(0, opts.searchBudget - used);
  let exhaustive = true;
  starved.forEach((s, n) => {
    const allowance = Math.floor(leftover / (starved.length - n));
    const steps = searchFrom(s, allowance);
    if (steps < 0) {
      exhaustive = false;
      leftover -= allowance;
    } else leftover -= steps;
  });

  // Keep only minimal combos: drop any that contains a smaller combo, counting a helper's alternatives
  // (a combo using Krark-Clan Ironworks contains one that lists it as an alternative to Ashnod's Altar).
  const found = [...results.values()];
  const contains = (c: EngineCombo, o: EngineCombo) =>
    o.loop.every((x) => c.cards.includes(x)) &&
    o.helpers.every((h) => c.cards.includes(h) || (o.helperAlternatives[h] ?? []).some((alt) => c.cards.includes(alt)));
  const minimal = found.filter((c) => !found.some((o) => o !== c && o.cards.length < c.cards.length && contains(c, o)));
  const combos = minimal
    .sort((a, b) => a.cards.length - b.cards.length || a.cards.join('|').localeCompare(b.cards.join('|')))
    .map(({ size: _size, surplus: _surplus, ...combo }) => combo);
  return { combos, exhaustive, rejected: ctx.rejected };
}
