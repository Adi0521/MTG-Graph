import {
  COLORS,
  emptyCost,
  emptyProduction,
  lifelinkGranters,
  matchesTarget,
  parseAbilities,
  type Ability,
  type ManaCost,
  type ManaProduction,
  type Output,
} from './abilities.ts';
import type { Card } from './types.ts';

/**
 * Deterministic infinite-combo detection.
 *
 * 1. Build a graph of abilities: X → Y when something X produces can pay for or
 *    trigger Y (mana → mana costs, a creature → a sacrifice cost, a death → a
 *    death trigger, a copy/blink → an ETB trigger, an untap → a {T} cost, ...).
 * 2. Enumerate short cycles in that graph.
 * 3. Simulate one pass around each cycle, tracking which object is sacrificed
 *    (token or card), and count resources. A loop is infinite when every {T}
 *    is untapped again, mana (with colors) and life break even, nothing is
 *    once-per-turn, and recursion only returns cards that died in the loop.
 * 4. If mana or life falls short, try adding cards from the deck that trigger
 *    on the loop's events (e.g. a Treasure on each death) as extra pieces.
 *    Remaining such cards are reported as payoffs.
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
  steps: ComboStep[];
  /** For each helper, other deck cards that could fill the same role. */
  helperAlternatives: Record<string, string[]>;
  produces: string[];
  prerequisites: string[];
  payoffs: { card: string; effect: string }[];
  warnings: string[];
  /** Mana left over per loop, e.g. "{C}{C}", or "none". */
  netMana: string;
}

export interface EngineOptions {
  /** Longest ability cycle to consider. */
  maxLoopAbilities: number;
  /** DFS step cap, so huge decks stay bounded (and deterministic). */
  searchBudget: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = { maxLoopAbilities: 5, searchBudget: 1_000_000 };

type Resource = 'mana' | 'creature' | 'death' | 'selfEtb' | 'etb' | 'untap' | 'lifegain' | 'drain' | 'counter';

interface Binding {
  res: Resource;
  /** The creature involved: a card name, or null for a token. */
  object?: string | null;
  token?: boolean;
  /** Set when lifegain comes from damage dealt by a creature given lifelink. */
  lifelinkFrom?: string;
}

interface Context {
  cardByName: Map<string, Card>;
  granters: string[];
}

const totalMana = (c: ManaCost) => COLORS.reduce((n, k) => n + c[k], 0) + c.generic;
const has = <T extends Output['type']>(a: Ability, type: T) => a.outputs.find((o): o is Extract<Output, { type: T }> => o.type === type);
const putsCreatureOnBattlefield = (a: Ability) => a.kind === 'recast' || has(a, 'creature') || has(a, 'copy') || has(a, 'recur');
const isCreature = (ctx: Context, name: string) => /\bCreature\b/.test(ctx.cardByName.get(name)?.typeLine ?? '');
const hasHaste = (ctx: Context, name: string) => ctx.cardByName.get(name)?.keywords.includes('haste') ?? false;

/** The permanent a {T} cost taps: the card itself, or for "enchanted creature has ..." the host it copies. */
function tapObject(abilities: Ability[], i: number): string {
  const a = abilities[i]!;
  return a.host ? abilities[(i + 1) % abilities.length]!.card : a.card;
}

/** The creature that `a` puts onto the battlefield, if any. */
function enteringObject(a: Ability, next: Ability, ctx: Context): { object: string | null; token: boolean } | null {
  if (a.kind === 'recast' || has(a, 'recur')) return { object: a.card, token: false };
  if (has(a, 'creature')) return { object: null, token: true };
  const copy = has(a, 'copy');
  if (copy) return { object: null, token: true };
  const blink = has(a, 'blink');
  if (blink && matchesTarget(blink.target, ctx.cardByName.get(next.card)!, a.card)) return { object: next.card, token: false };
  return null;
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
        if (!a.cost.sacrifice || input?.res !== 'creature') return null;
        const object = input.object ?? null;
        const token = input.token ?? false;
        if (t.nontoken && token) return null;
        if (t.another && object === next.card) return null;
        if (t.self && object !== next.card) return null;
        return { res: 'death', object, token };
      }
      case 'selfEtb': {
        if ((a.kind === 'recast' || has(a, 'recur')) && a.card === next.card) return { res: 'selfEtb', object: next.card };
        const copy = has(a, 'copy');
        if (copy) {
          const ok = copy.target === 'host' ? isCreature(ctx, next.card) : matchesTarget(copy.target, nextCard, a.card);
          if (ok) return { res: 'selfEtb', object: next.card };
        }
        const blink = has(a, 'blink');
        if (blink && matchesTarget(blink.target, nextCard, a.card)) return { res: 'selfEtb', object: next.card };
        return null;
      }
      case 'etb': {
        const entering = enteringObject(a, next, ctx);
        if (!entering) return null;
        if (t.nontoken && entering.token) return null;
        if (t.another && entering.object === next.card) return null;
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
    }
  }

  // Activated or recast: bind to one of its costs.
  if (next.cost.sacrifice) {
    const entering = putsCreatureOnBattlefield(a) ? enteringObject(a, next, ctx) : null;
    if (entering && !(next.cost.sacrifice.another && entering.object === next.card)) return { res: 'creature', ...entering };
  }
  if (next.cost.tap) {
    const target = tapObject(abilities, nextIndex);
    const targetCard = ctx.cardByName.get(target)!;
    const untap = has(a, 'untap');
    if (untap && matchesTarget(untap.target, targetCard, a.card)) return { res: 'untap', object: target };
    // A blinked creature returns untapped but summoning sick, so it needs haste to tap again.
    const blink = has(a, 'blink');
    if (blink && matchesTarget(blink.target, targetCard, a.card) && (!isCreature(ctx, target) || hasHaste(ctx, target))) {
      return { res: 'untap', object: target };
    }
  }
  if (totalMana(next.cost.mana) > 0 && (has(a, 'mana') || has(a, 'tokenMana'))) return { res: 'mana' };
  if (next.cost.removeCounter) {
    const counter = has(a, 'counter');
    if (counter && (counter.target === 'self' ? a.card === next.card : matchesTarget(counter.target, nextCard, a.card))) {
      return { res: 'counter', object: next.card };
    }
  }
  return null;
}

/** Can `produced` pay `cost`? Returns leftover mana or null. */
export function payMana(produced: ManaProduction, cost: ManaCost): ManaProduction | null {
  const left = { ...produced };
  for (const color of COLORS) {
    let need = cost[color];
    const fromExact = Math.min(need, left[color]);
    left[color] -= fromExact;
    need -= fromExact;
    const fromAny = Math.min(need, left.any);
    left.any -= fromAny;
    need -= fromAny;
    if (need > 0) return null;
  }
  let generic = cost.generic;
  for (const key of [...COLORS, 'any'] as const) {
    const used = Math.min(generic, left[key]);
    left[key] -= used;
    generic -= used;
  }
  return generic > 0 ? null : left;
}

function describeMana(m: ManaProduction): string {
  const parts = COLORS.flatMap((c) => Array<string>(m[c]).fill(`{${c}}`));
  if (m.any) parts.push(...Array<string>(m.any).fill('{any}'));
  return parts.join('') || 'none';
}

function addMana(into: ManaProduction, m: ManaProduction, times = 1) {
  for (const k of [...COLORS, 'any'] as const) into[k] += m[k] * times;
}

interface Events {
  deaths: { object: string | null; token: boolean }[];
  etbs: { object: string | null; token: boolean }[];
  lifegains: number;
  drains: number;
}

/** How many times a triggered ability outside the loop fires per iteration. */
function riderFires(r: Ability, ev: Events): number {
  const t = r.trigger!;
  switch (t.type) {
    case 'death':
      return ev.deaths.filter((d) => !(t.nontoken && d.token) && !(t.another && d.object === r.card) && (!t.self || d.object === r.card)).length;
    case 'etb':
      return ev.etbs.filter((e) => !(t.nontoken && e.token) && !(t.another && e.object === r.card)).length;
    case 'lifegain':
      return ev.lifegains > 0 ? 1 : 0;
    case 'drain':
      return ev.drains > 0 ? 1 : 0;
    default:
      return 0;
  }
}

interface Ledger {
  mana: ManaProduction;
  cost: ManaCost;
  life: number;
}

function ledgerOk(l: Ledger): { ok: boolean; left: ManaProduction | null } {
  const left = payMana(l.mana, l.cost);
  return { ok: left !== null && l.life >= 0, left };
}

function riderContribution(r: Ability, fires: number): { mana: ManaProduction; life: number } {
  const mana = emptyProduction();
  let life = 0;
  for (const o of r.outputs) {
    if (o.type === 'mana') addMana(mana, o.mana, fires);
    if (o.type === 'lifegain') life += o.amount * fires;
    if (o.type === 'selfLifeLoss') life -= o.amount * fires;
  }
  return { mana, life };
}

const THEN: Record<Resource, (b: Binding, next: string) => string> = {
  mana: (_, next) => `its mana pays for ${next}`,
  creature: (b, next) => `${b.object ?? 'the token'} is sacrificed to ${next}`,
  death: (b, next) => `${b.object ?? 'the token'} dying triggers ${next}`,
  selfEtb: (_, next) => `${next} enters, triggering its ability`,
  etb: (b, next) => `${b.object ?? 'the token'} entering triggers ${next}`,
  untap: (b) => `this untaps ${b.object}`,
  lifegain: (b, next) => (b.lifelinkFrom ? `the damage, with lifelink, gains life and triggers ${next}` : `the lifegain triggers ${next}`),
  drain: (_, next) => `the life loss triggers ${next}`,
  counter: (_, next) => `the counter pays ${next}'s cost`,
};

function evaluate(cycle: Ability[], deckAbilities: Ability[], ctx: Context): EngineCombo | null {
  if (cycle.some((a) => a.oncePerTurn || a.unmodeledCost)) return null;
  const k = cycle.length;

  // Two laps so the first ability sees the binding produced by the last one.
  const bindings: (Binding | null)[] = new Array(k).fill(null);
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < k; i++) bindings[i] = feed(cycle, i, bindings[(i - 1 + k) % k] ?? undefined, ctx);
  }
  if (bindings.some((b) => b === null)) return null;
  const bound = bindings as Binding[];
  const inputOf = (i: number) => bound[(i - 1 + k) % k]!;

  // Every {T} must be untapped again within the loop.
  for (let i = 0; i < k; i++) {
    if (!cycle[i]!.cost.tap) continue;
    const target = tapObject(cycle, i);
    if (!bound.some((b) => b.res === 'untap' && b.object === target)) return null;
  }
  // Every sacrifice cost must be paid by a creature the loop provides.
  for (let i = 0; i < k; i++) if (cycle[i]!.cost.sacrifice && inputOf(i).res !== 'creature') return null;
  // Recursion only works for cards that died during the loop.
  const died = new Set(cycle.flatMap((a, i) => (a.cost.sacrifice ? [inputOf(i).object] : [])).filter((o): o is string => Boolean(o)));
  for (const a of cycle) if (a.kind === 'recast' && !died.has(a.card)) return null;
  // Counters removed must be put back.
  for (let i = 0; i < k; i++) if (cycle[i]!.cost.removeCounter && inputOf(i).res !== 'counter') return null;

  const ledger: Ledger = { mana: emptyProduction(), cost: emptyCost(), life: 0 };
  const events: Events = { deaths: [], etbs: [], lifegains: 0, drains: 0 };
  let damage = false;
  let tokens = 0;
  let hasteTokens = false;
  let draws = 0;
  let counters = 0;
  const prerequisites = new Set<string>();

  cycle.forEach((a, i) => {
    for (const color of [...COLORS, 'generic'] as const) ledger.cost[color] += a.cost.mana[color];
    ledger.life -= a.cost.life;
    if (a.cost.removeCounter) counters--;
    if (a.cost.sacrifice) events.deaths.push({ object: inputOf(i).object ?? null, token: inputOf(i).token ?? false });
    const next = cycle[(i + 1) % k]!;
    const entering = putsCreatureOnBattlefield(a) || has(a, 'blink') ? enteringObject(a, next, ctx) : null;
    if (entering) events.etbs.push(entering);
    for (const o of a.outputs) {
      if (o.type === 'mana') addMana(ledger.mana, o.mana);
      // A token that sacrifices itself for mana cannot also be the fodder passed to the next step.
      if (o.type === 'tokenMana' && bound[i]!.res !== 'creature') {
        addMana(ledger.mana, o.mana);
        events.deaths.push({ object: null, token: true });
      }
      if (o.type === 'lifegain') {
        ledger.life += o.amount;
        events.lifegains++;
      }
      if (o.type === 'drain') {
        events.drains++;
        damage ||= o.damage;
      }
      if (o.type === 'selfLifeLoss') ledger.life -= o.amount;
      if (o.type === 'creature') {
        tokens += o.count;
        hasteTokens ||= o.haste;
      }
      if (o.type === 'copy') {
        tokens++;
        hasteTokens ||= o.haste;
        if (o.target === 'host') prerequisites.add(`${a.card} is attached to ${next.card}`);
      }
      if (o.type === 'counter') counters++;
      if (o.type === 'draw') draws += o.amount;
    }
    const b = bound[i]!;
    if (b.lifelinkFrom) {
      ledger.life += 1;
      events.lifegains++;
      if (b.lifelinkFrom !== a.card) prerequisites.add(`${b.lifelinkFrom} gives ${a.card} lifelink`);
    }
    for (const c of a.conditions) prerequisites.add(`${a.card}: ${c}`);
  });

  // Triggered abilities elsewhere in the deck that fire on this loop's events.
  const inCycle = new Set(cycle.map((a) => a.id));
  const riders = deckAbilities
    .filter((r) => r.kind === 'triggered' && !inCycle.has(r.id) && !r.unmodeledCost)
    .map((r) => ({ r, fires: riderFires(r, events) }))
    .filter((x) => x.fires > 0);

  // If mana or life falls short, add helpful riders (in name order) until it balances, then drop any not needed.
  const helpers: typeof riders = [];
  const withHelpers = (list: typeof riders): Ledger => {
    const l: Ledger = { mana: { ...ledger.mana }, cost: { ...ledger.cost }, life: ledger.life };
    for (const { r, fires } of list) {
      const c = riderContribution(r, fires);
      addMana(l.mana, c.mana);
      l.life += c.life;
    }
    return l;
  };
  if (!ledgerOk(ledger).ok) {
    const candidates = riders.filter(({ r, fires }) => {
      const c = riderContribution(r, fires);
      return c.life > 0 || COLORS.some((col) => c.mana[col] > 0) || c.mana.any > 0;
    });
    for (const cand of candidates) {
      if (helpers.some((h) => h.r.card === cand.r.card)) continue;
      helpers.push(cand);
      if (ledgerOk(withHelpers(helpers)).ok) break;
    }
    if (!ledgerOk(withHelpers(helpers)).ok) return null;
    for (const h of [...helpers]) {
      const without = helpers.filter((x) => x !== h);
      if (ledgerOk(withHelpers(without)).ok) helpers.splice(helpers.indexOf(h), 1);
    }
  }
  const final = ledgerOk(withHelpers(helpers));
  const helperAlternatives: Record<string, string[]> = {};
  for (const h of helpers) {
    const alts = riders
      .filter((x) => x.r.card !== h.r.card && !helpers.some((y) => y.r.card === x.r.card) && !cycle.some((a) => a.card === x.r.card))
      .filter((x) => ledgerOk(withHelpers(helpers.map((y) => (y === h ? x : y)))).ok)
      .map((x) => x.r.card);
    if (alts.length) helperAlternatives[h.r.card] = [...new Set(alts)].sort();
  }
  for (const { r } of helpers) for (const c of r.conditions) prerequisites.add(`${r.card}: ${c}`);

  const loopCards = [...new Set(cycle.map((a) => a.card))];
  const helperCards = [...new Set(helpers.map((h) => h.r.card))].filter((c) => !loopCards.includes(c));
  const pieces = new Set([...loopCards, ...helperCards]);

  const payoffs: EngineCombo['payoffs'] = [];
  const warnings: string[] = [];
  for (const { r } of riders) {
    if (helpers.some((h) => h.r === r) || pieces.has(r.card)) continue;
    if (r.outputs.some((o) => o.type === 'selfLifeLoss')) warnings.push(`${r.card} makes you lose life each loop: ${r.text}`);
    else payoffs.push({ card: r.card, effect: r.text });
  }

  const surplus = final.left!;
  const produces: string[] = [];
  const surplusTotal = COLORS.reduce((n, c) => n + surplus[c], 0) + surplus.any;
  if (surplusTotal > 0) produces.push(surplus.any > 0 ? 'Infinite mana of any color' : `Infinite ${COLORS.filter((c) => surplus[c] > 0).map((c) => COLOR_NAMES[c]).join(' and ')} mana`);
  if (events.deaths.length) produces.push('Infinite death triggers', 'Infinite sacrifice triggers');
  if (tokens) produces.push(hasteTokens ? 'Infinite hasty creature tokens' : 'Infinite creature tokens');
  if (events.etbs.length) produces.push('Infinite creature ETBs');
  if (events.drains) produces.push(damage ? 'Infinite damage' : 'Infinite life loss for opponents');
  if (events.lifegains) produces.push('Infinite lifegain');
  if (counters > 0) produces.push('Infinite +1/+1 counters');
  if (draws) produces.push('Infinite card draw');
  const helperOutputs = helpers.flatMap((h) => h.r.outputs);
  if (!events.drains && helperOutputs.some((o) => o.type === 'drain')) produces.push('Infinite life loss for opponents');

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
    netMana: describeMana(surplus),
  };
}

const COLOR_NAMES: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless' };

/** Which resources an ability can take as its loop input. */
function inputs(a: Ability): Resource[] {
  if (a.kind === 'triggered') {
    const t = a.trigger!.type;
    return [t === 'death' ? 'death' : t === 'selfEtb' ? 'selfEtb' : t === 'etb' ? 'etb' : t === 'lifegain' ? 'lifegain' : 'drain'];
  }
  const r: Resource[] = [];
  if (a.cost.sacrifice) r.push('creature');
  if (a.cost.tap) r.push('untap');
  if (totalMana(a.cost.mana) > 0) r.push('mana');
  if (a.cost.removeCounter) r.push('counter');
  return r;
}

/** Which resources an ability can produce for the next step (a superset; `feed` checks the details). */
function outputsOf(a: Ability, ctx: Context): Resource[] {
  const r = new Set<Resource>();
  if (has(a, 'mana') || has(a, 'tokenMana')) r.add('mana');
  if (putsCreatureOnBattlefield(a)) r.add('creature').add('etb');
  if (a.kind === 'recast' || has(a, 'recur') || has(a, 'copy') || has(a, 'blink')) r.add('selfEtb');
  if (has(a, 'blink')) r.add('etb').add('untap');
  if (a.cost.sacrifice) r.add('death');
  if (has(a, 'untap')) r.add('untap');
  if (has(a, 'lifegain')) r.add('lifegain');
  if (has(a, 'drain')) {
    r.add('drain');
    if (a.outputs.some((o) => o.type === 'drain' && o.damage) && ctx.granters.length) r.add('lifegain');
  }
  if (has(a, 'counter')) r.add('counter');
  return [...r];
}

export function findEngineCombos(cards: Card[], options: Partial<EngineOptions> = {}): { combos: EngineCombo[]; exhaustive: boolean } {
  const opts = { ...DEFAULT_ENGINE_OPTIONS, ...options };
  const sorted = [...cards].sort((a, b) => a.name.localeCompare(b.name));
  const ctx: Context = { cardByName: new Map(sorted.map((c) => [c.name, c])), granters: lifelinkGranters(sorted) };
  const all = sorted.flatMap((c) => parseAbilities(c));
  const nodes = all.filter((a) => !a.oncePerTurn && !a.unmodeledCost);

  // Ability graph adjacency by resource compatibility.
  const out: number[][] = nodes.map((a) => {
    const produced = new Set(outputsOf(a, ctx));
    return nodes.flatMap((b, j) => (b !== a && inputs(b).some((r) => produced.has(r)) ? [j] : []));
  });

  const results = new Map<string, EngineCombo & { size: number }>();
  let steps = 0;
  let exhaustive = true;

  for (let s = 0; s < nodes.length && exhaustive; s++) {
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
      if (++steps > opts.searchBudget) {
        exhaustive = false;
        break;
      }
      const w = out[v]![i]!;
      if (w === s && path.length >= 2) {
        const combo = evaluate(path.map((p) => nodes[p]!), all, ctx);
        if (combo) {
          const key = [...combo.cards].sort().join('|');
          const existing = results.get(key);
          if (!existing || path.length < existing.size) results.set(key, { ...combo, size: path.length });
        }
        continue;
      }
      if (w <= s || onPath.has(w) || path.length >= opts.maxLoopAbilities) continue;
      path.push(w);
      onPath.add(w);
      frames.push([w, 0]);
    }
  }

  // Keep only minimal combos: drop any whose pieces include another combo's pieces.
  const found = [...results.values()];
  const minimal = found.filter(
    (c) => !found.some((o) => o !== c && o.cards.length < c.cards.length && o.cards.every((x) => c.cards.includes(x))),
  );
  const combos = minimal
    .sort((a, b) => a.cards.length - b.cards.length || a.cards.join('|').localeCompare(b.cards.join('|')))
    .map(({ size: _size, ...combo }) => combo);
  return { combos, exhaustive };
}
