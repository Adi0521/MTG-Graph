import { COLORS, COMBAT_STEP, emptyProduction, matchesTarget, payMana, type Ability, type ManaCost, type ManaProduction, type Output } from './abilities.ts';
import { ANY_CREATURE, type Binding, type Context, type Helper } from './combo-engine.ts';
import type { Card } from './types.ts';

/**
 * Loop verifier: plays a candidate loop out on a small, concrete game state.
 *
 * The combo engine's ledger checks that resources break even on average. This
 * replays the exact steps with real objects (which permanent is tapped, what
 * counters it has, how much damage it has taken, which zone each card is in)
 * and applies state-based actions (lethal damage, 0 toughness) and undying /
 * persist conditions. It runs one setup pass, recording what has to be true to
 * start, then three strict passes; passes 2 and 3 must end in the same state
 * (tokens, mana and opponent damage may grow). Deterministic: no randomness, and
 * every choice follows a fixed rule.
 *
 * Combat: the turn is a list of upcoming phases. An extra combat is inserted after
 * the current phase (Aggravated Assault's also brings a main phase), and combat
 * steps happen in order (beginning of combat, attackers, damage), so a loop that
 * uses up combats without making new ones runs out. Each creature object tracks
 * whether it attacked or was exerted this turn: "the first time each turn" and
 * exert only repeat with a new object (a token copy, a flickered creature).
 */

export interface LoopPlan {
  cycle: Ability[];
  /** bindings[i] is what step i passes to step i+1. */
  bindings: Binding[];
  helpers: Helper[];
  /** Step index → the permanent a granted ability acts through. */
  hosts: Record<number, string>;
  /** Card whose enter ability exiles another card, which it returns on leaving (Fiend Hunter → Karmic Guide). */
  exiles: Record<string, string>;
  /** Step index → card that step reanimates. */
  reanimates: Record<number, string>;
  /** The artifact whose activated abilities an activation reducer (Power Artifact) is attached to. */
  reducedCard?: string;
  /** Other creatures a mass reanimation (Living Death) needs, beyond the loop's cards. */
  extraCreatures?: number;
  /** Units for board-dependent mana (Priest of Titania's Elves). */
  variableX?: number;
  /** Cards the loop also sacrifices each pass (Reveillark's partner), to a free outlet. */
  extraSacrifices?: string[];
}

export interface PerLoop {
  mana: ManaProduction;
  life: number;
  opponentLife: number;
  deaths: number;
  etbs: number;
  draws: number;
  tokens: number;
  casts: number;
  combats: number;
  /** Cards you mill from your own library per loop (dredge). */
  selfMilled: number;
  /** Cards opponents mill per loop (the loop ends when their library does: it is a win, not infinite). */
  milled: number;
}

export interface Verification {
  ok: boolean;
  /** Why the loop fails, when it does. */
  reason?: string;
  /** What must be true before the first loop (mana available, a card in the graveyard, a counter...). */
  startup: string[];
  /** Exact net change per loop, measured on the last pass. */
  perLoop: PerLoop;
}

interface Perm {
  id: number;
  card: string;
  token: boolean;
  types: string[];
  tapped: boolean;
  sick: boolean;
  plus: number;
  minus: number;
  damage: number;
  loyaltyUsed: boolean;
  haste: boolean;
  /** Printed toughness for tokens ("a 1/1 Thopter"); cards use their own. */
  baseToughness?: number;
  attacked: boolean;
  exerted: boolean;
}

type Phase = 'main' | 'combat';

interface Event {
  type: 'death' | 'etb' | 'cast' | 'lifegain' | 'drain' | 'draw' | 'minus' | 'attack' | 'combatDamage' | 'beginCombat' | 'mill' | 'discard';
  /** For attacks: the first attack event of its combat (an aura's trigger fires once per combat). */
  first?: boolean;
  card?: string | null;
  token?: boolean;
  types?: string[];
  amount?: number;
  casts?: string[];
  /** For deaths: the counters it had, for undying/persist. */
  plus?: number;
  minus?: number;
}

class LoopFails extends Error {}

const PERMANENT_TYPES = ['artifact', 'creature', 'enchantment', 'planeswalker', 'land'];
const has = <T extends Output['type']>(a: Ability, type: T) => a.outputs.find((o): o is Extract<Output, { type: T }> => o.type === type);
const totalMana = (c: ManaCost) => COLORS.reduce((n, k) => n + c[k], 0) + c.generic;
const NUMBER: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, x: 0 };

class Simulation {
  perms: Perm[] = [];
  graveyard: string[] = [];
  hand: string[] = [];
  /** Library, top card first (only cards the loop puts there are tracked). */
  library: string[] = [];
  exile: { card: string; by: string }[] = [];
  pool = emptyProduction();
  life = 20;
  opponentLife = 40;
  opponentMilled = 0;
  selfMilled = 0;
  setup = true;
  startup = new Set<string>();
  events: Event[] = [];
  /** The previous pass's events: a loop's first step can be triggered by its last step's event. */
  previousEvents: Event[] = [];
  /** Tokens made by the most recent step, for the next step to sacrifice. */
  lastTokens: number[] = [];
  /** Tokens made this pass that were never used: fodder for a helper sacrifice outlet. */
  spareTokens = new Set<number>();
  /** Phases still to come this turn (`turn[at]` is the current one), and where in the current combat we are. */
  turn: Phase[] = ['main', 'combat', 'main'];
  at = 0;
  combatStep = -1;
  /** Creatures attacking in the current combat, and the ones that started attacking during this pass. */
  attackers = new Set<number>();
  passAttackers = new Set<number>();
  combatsStarted = 0;
  /** Events up to here have had their riders fired. */
  firedUpTo = 0;
  private nextId = 1;
  private readonly plan: LoopPlan;
  private readonly ctx: Context;

  constructor(plan: LoopPlan, ctx: Context) {
    this.plan = plan;
    this.ctx = ctx;
  }

  // --- small helpers --------------------------------------------------------

  private cardOf(name: string) {
    return this.ctx.cardByName.get(name) ?? fillerCard(name);
  }

  private typesOf(name: string) {
    return this.cardOf(name).typeLine.toLowerCase().split(/[\s—/]+/).filter((t) => PERMANENT_TYPES.includes(t));
  }

  /** In the setup pass a problem is noted and patched over; afterwards it fails the loop. */
  private problem(message: string): boolean {
    if (this.setup) {
      this.startup.add(message);
      return true;
    }
    throw new LoopFails(message);
  }

  private find(card: string): Perm | undefined {
    return this.perms.find((p) => p.card === card && !p.token);
  }

  private require(card: string, why: string): Perm {
    let p = this.find(card);
    if (!p) {
      this.problem(`${card} must be on the battlefield (${why})`);
      this.graveyard = this.graveyard.filter((c, i) => c !== card || i !== this.graveyard.indexOf(card));
      this.hand = this.hand.filter((c, i) => c !== card || i !== this.hand.indexOf(card));
      p = this.enter(card, false, { sick: false });
    }
    return p;
  }

  enter(
    card: string,
    token: boolean,
    { sick = true, haste = false, types, pt }: { sick?: boolean; haste?: boolean; types?: string[]; pt?: string | null } = {},
  ): Perm {
    const c = this.cardOf(card);
    const p: Perm = {
      id: this.nextId++,
      card,
      token,
      types: types ?? this.typesOf(card),
      tapped: false,
      sick,
      plus: 0,
      minus: 0,
      damage: 0,
      loyaltyUsed: false,
      haste: haste || c.keywords.includes('haste'),
      attacked: false,
      exerted: false,
      baseToughness: pt !== undefined ? Number(pt?.split('/')[1] ?? 1) || 1 : undefined,
    };
    // "~ enters with three +1/+1 counters on it" (X is 0).
    const counters = /~ enters with (\w+) \+1\/\+1 counters? on it/.exec(c.text);
    if (counters && !token && !this.plan.helpers.some((h) => h.kind === 'counterBlocker')) p.plus += NUMBER[counters[1]!] ?? (Number(counters[1]) || 0);
    this.perms.push(p);
    if (p.types.includes('creature')) this.events.push({ type: 'etb', card: token ? null : card, token, types: p.types });
    // Urza: tap each artifact as it arrives for mana, unless the loop needs to tap it itself.
    const tapper = this.plan.helpers.find((h): h is Extract<Helper, { kind: 'artifactTapper' }> => h.kind === 'artifactTapper');
    if (tapper && p.types.includes('artifact') && !this.plan.cycle.some((a) => a.cost.tap && (this.plan.hosts[this.plan.cycle.indexOf(a)] ?? a.card) === card)) {
      p.tapped = true;
      for (const k of [...COLORS, 'any'] as const) this.pool[k] += tapper.mana[k];
    }
    // Fiend Hunter-style enter abilities exile their linked card.
    const exiled = this.plan.exiles[card];
    if (exiled && !token) {
      const target = this.find(exiled);
      if (target) {
        this.leave(target);
        this.exile.push({ card: exiled, by: card });
      } else this.problem(`${exiled} must be on the battlefield for ${card} to exile`);
    }
    return p;
  }

  /** Remove a permanent from the battlefield without dying (blink, exile). */
  private leave(p: Perm) {
    this.perms = this.perms.filter((x) => x !== p);
  }

  private die(p: Perm) {
    this.leave(p);
    if (!p.token) this.graveyard.push(p.card);
    this.events.push({ type: 'death', card: p.token ? null : p.card, token: p.token, types: p.types, plus: p.plus, minus: p.minus });
  }

  private addCounters(p: Perm, plus: number, minus: number) {
    // Solemnity: counters can't be put on permanents. Melira: no -1/-1 counters on your creatures.
    if (this.plan.helpers.some((h) => h.kind === 'counterBlocker')) return;
    if (this.plan.helpers.some((h) => h.kind === 'minusBlocker')) minus = 0;
    p.plus += plus;
    p.minus += minus;
    // +1/+1 and -1/-1 counters annihilate.
    const cancel = Math.min(p.plus, p.minus);
    p.plus -= cancel;
    p.minus -= cancel;
  }

  /** Static +N/+N from permanents like Mikaeus: "Other non-Human creatures you control get +1/+1". */
  private anthem(p: Perm): number {
    let bonus = 0;
    for (const source of this.perms) {
      const m = /(other )?(?:non-(\w+) )?creatures you control get \+(\d+)\/\+(\d+)/.exec(this.cardOf(source.card).text);
      if (!m || source.token) continue;
      if (m[1] && source === p) continue;
      if (m[2] && new RegExp(`\\b${m[2]}\\b`, 'i').test(this.cardOf(p.card).typeLine)) continue;
      bonus += Number(m[4]);
    }
    return bonus;
  }

  private toughness(p: Perm): number {
    // "~ gets +1/+1 for each color among permanents you control" (Faeburrow Elder, a 0/0): at least one.
    const self = /~ gets \+(\d+)\/\+(\d+) for each\b/.exec(this.cardOf(p.card).text);
    return (p.baseToughness ?? this.cardOf(p.card).toughness ?? 0) + p.plus - p.minus + this.anthem(p) + (self ? Number(self[2]) : 0);
  }

  /** State-based actions: creatures with 0 toughness or lethal damage die. */
  private checkState() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of [...this.perms]) {
        if (!p.types.includes('creature')) continue;
        const t = this.toughness(p);
        if (t <= 0 || p.damage >= t) {
          this.die(p);
          changed = true;
        }
      }
    }
  }

  private pay(cost: ManaCost, what: string) {
    if (totalMana(cost) === 0) return;
    let left = payMana(this.pool, cost);
    if (!left) {
      // Tap helper mana rocks that are untapped.
      for (const h of this.plan.helpers) {
        if (h.kind !== 'rock') continue;
        const rock = this.find(h.card);
        const mana = has(h.ability, 'mana');
        if (!rock || rock.tapped || !mana) continue;
        rock.tapped = true;
        for (const k of [...COLORS, 'any'] as const) this.pool[k] += mana.mana[k];
        left = payMana(this.pool, cost);
        if (left) break;
      }
    }
    if (!left) {
      this.problem(`needs ${describeCost(cost)} available to start (for ${what})`);
      // Patch: conjure the shortfall.
      for (const k of COLORS) this.pool[k] += cost[k];
      this.pool.any += cost.generic;
      left = payMana(this.pool, cost)!;
    }
    this.pool = left;
  }

  private costWithReductions(a: Ability): ManaCost {
    const c = { ...a.cost.mana };
    if (a.kind === 'cast' || (a.kind === 'recast' && a.isCast)) {
      for (const h of this.plan.helpers) {
        if (h.kind !== 'reducer' || !reducerApplies(h.what, a.casts ?? this.typesOf(a.card))) continue;
        if (h.creatureType && !new RegExp(`\\b${h.creatureType}\\b`, 'i').test(this.cardOf(a.card).typeLine)) continue;
        if (h.maxMv !== undefined) {
          if (this.cardOf(a.card).cmc <= h.maxMv) for (const key of [...COLORS, 'generic'] as const) c[key] = 0;
          continue;
        }
        c.generic = Math.max(0, c.generic - (h.variable ? (this.plan.variableX ?? 0) : h.amount));
      }
    }
    const act = this.plan.helpers.find((h): h is Extract<Helper, { kind: 'activationReducer' }> => h.kind === 'activationReducer');
    if (act && a.kind === 'activated' && totalMana(c) > 0 && (act.global ? !has(a, 'mana') : a.card === this.plan.reducedCard)) {
      c.generic = Math.max(0, c.generic - Math.min(act.amount, totalMana(c) - 1));
    }
    return c;
  }

  // --- turn structure and combat ------------------------------------------------

  /** Move on to the next phase of this kind (the current one counts only if `stay`). */
  private advanceTo(kind: Phase, stay: boolean) {
    if (stay && this.turn[this.at] === kind) return;
    // Leaving a combat whose damage step the loop did not reach: the attackers deal their damage now (riders like
    // Sword of Feast and Famine trigger before the next step pays its costs).
    if (this.turn[this.at] === 'combat' && this.combatStep >= 1 && this.combatStep < 2 && this.attackers.size) {
      const from = this.events.length;
      for (const p of this.perms) if (this.attackers.has(p.id)) this.events.push({ type: 'combatDamage', card: p.card });
      this.fireRiders(from);
    }
    let j = this.turn.indexOf(kind, this.at + 1);
    if (j === -1) {
      this.problem(kind === 'combat' ? 'needs another combat phase' : 'needs another main phase');
      this.turn.push(kind);
      j = this.turn.length - 1;
    }
    // Combat phases passed on the way still happen (Neheb's creature attacks in them; nothing in the loop triggers).
    for (let n = this.at + 1; n < j; n++) if (this.turn[n] === 'combat') this.combatsStarted++;
    this.at = j;
    this.combatStep = -1;
    if (kind === 'combat') {
      this.attackers.clear();
      this.combatsStarted++;
    }
  }

  /** "After this phase, there is an additional combat phase [followed by an additional main phase]." */
  private addCombat(withMain: boolean) {
    this.turn.splice(this.at + 1, 0, ...(withMain ? (['combat', 'main'] as Phase[]) : (['combat'] as Phase[])));
  }

  /** The creature object that attacks for `name`: the newest one able to (untapped, not summoning sick, and new enough). */
  private declareAttacker(name: string, rules: { firstTime?: boolean; exert?: boolean }): Perm {
    const once = rules.firstTime || /can't attack a player it has already attacked this turn/.test(this.cardOf(name).text);
    const reasons: string[] = [];
    const able = (p: Perm) => {
      if (p.tapped) reasons.push('it is tapped');
      else if (p.sick && !p.haste) reasons.push('it is summoning sick');
      else if (once && p.attacked) reasons.push('it already attacked this turn');
      else if (rules.exert && p.exerted) reasons.push('it was already exerted this turn');
      else return true;
      return false;
    };
    const candidates = this.perms.filter((p) => p.card === name && p.types.includes('creature')).sort((x, y) => y.id - x.id);
    let p = candidates.find(able);
    if (!p) {
      this.problem(`${name} cannot attack again (${[...new Set(reasons)].join(', ') || 'not on the battlefield'})`);
      p = candidates[0] ?? this.enter(name, false, { sick: false });
      p.tapped = false;
      p.attacked = false;
      p.exerted = false;
    }
    if (!this.cardOf(name).keywords.includes('vigilance')) p.tapped = true;
    p.attacked = true;
    if (rules.exert) p.exerted = true;
    this.attackers.add(p.id);
    this.passAttackers.add(p.id);
    this.events.push({ type: 'attack', card: name, first: this.attackers.size === 1 });
    return p;
  }

  /** Put the game in the right phase for step `a`, declaring its attacker if it is a combat trigger. */
  private timing(i: number, a: Ability) {
    const t = a.trigger;
    const step = t ? COMBAT_STEP[t.type] : undefined;
    if (step === undefined) {
      // Sorcery-speed actions need a main phase: "activate only as a sorcery", casting a creature or other
      // non-instant without flash.
      const card = this.cardOf(a.card);
      const sorcerySpeed =
        a.sorcery ||
        ((a.kind === 'cast' || a.kind === 'recast') && !/Instant/.test(card.typeLine) && !card.keywords.includes('flash'));
      if (sorcerySpeed) this.advanceTo('main', true);
      return;
    }
    if (t!.type === 'beginCombat') {
      this.advanceTo('combat', false);
      this.combatStep = 0;
      this.events.push({ type: 'beginCombat' });
      return;
    }
    if (t!.type === 'postcombatMain') {
      this.advanceTo('main', false);
      return;
    }
    const name = (t!.type === 'attack' || t!.type === 'combatDamage') && t!.source === 'host' ? (this.plan.hosts[i] ?? ANY_CREATURE) : a.card;
    const inCombat = this.turn[this.at] === 'combat';
    if (t!.type === 'attack') {
      // Attackers are declared once per combat: after the beginning of combat, or else in the next combat.
      if (!(inCombat && this.combatStep === 0)) this.advanceTo('combat', false);
      this.combatStep = 1;
      this.declareAttacker(name, { firstTime: t!.firstTime, exert: t!.exert });
      return;
    }
    // Combat damage: from a creature that started attacking in this combat during this pass, or a new attack.
    const attacking = inCombat && this.combatStep >= 1 && this.perms.some((p) => p.card === name && this.attackers.has(p.id) && this.passAttackers.has(p.id));
    if (!attacking) {
      if (!(inCombat && this.combatStep === 0)) this.advanceTo('combat', false);
      this.declareAttacker(name, {});
    }
    this.combatStep = 2;
    this.events.push({ type: 'combatDamage', card: name });
  }

  // --- running the loop -----------------------------------------------------

  runPass() {
    this.previousEvents = this.events;
    this.events = [];
    this.passAttackers.clear();
    this.combatsStarted = 0;
    this.firedUpTo = 0;
    this.spareTokens.clear();
    const k = this.plan.cycle.length;
    for (let i = 0; i < k; i++) {
      const before = this.events.length;
      this.step(i);
      this.checkState();
      this.fireRiders(before);
    }
    this.sacrificeSpareTokens();
  }

  private step(i: number) {
    const { cycle, bindings } = this.plan;
    const k = cycle.length;
    const a = cycle[i]!;
    const input = bindings[(i - 1 + k) % k]!;
    const output = bindings[i]!;

    // A step that kills its own creature (pinging itself, piling on -1/-1 counters) repeats until it does.
    if (output.res === 'death' && output.object === a.card && !a.cost.sacrifice) {
      this.repeatUntilDeath(i, a, input, output);
      return;
    }
    this.activate(i, a, input, output);
  }

  private repeatUntilDeath(i: number, a: Ability, input: Binding, output: Binding) {
    const self = this.require(a.card, 'it must die to continue the loop');
    if (a.cost.removeCounter && a.outputs.some((o) => o.type === 'drain' && o.damage)) {
      // Each activation removes a counter and deals 1 damage. Ping the opponent first, then itself.
      const baseToughness = (this.cardOf(a.card).toughness ?? 0) + this.anthem(self) - self.minus;
      if (self.plus < 1 && this.problem(`${a.card} needs a +1/+1 counter to start`)) self.plus = 1;
      const toSelf = Math.max(0, baseToughness);
      if (self.plus < toSelf) throw new LoopFails(`${a.card} has too few counters to finish itself off`);
      const toOpponent = self.plus - toSelf;
      for (let n = 0; n < toOpponent; n++) this.activate(i, a, input, { res: 'drain' });
      for (let n = 0; n < toSelf; n++) this.activate(i, a, input, output, { damageSelf: true });
    } else if (a.kind === 'triggered' && a.outputs.some((o) => o.type === 'drain' && o.damage)) {
      // An enter trigger that deals damage to itself (Murderous Redcap pointing at itself).
      this.activate(i, a, input, output, { damageSelf: true });
    } else {
      for (let n = 0; n < 40 && this.perms.includes(self); n++) {
        this.activate(i, a, input, output);
        this.checkState();
      }
    }
    this.checkState();
    if (this.perms.includes(self)) throw new LoopFails(`${a.card} does not die, so the loop stops`);
  }

  private activate(i: number, a: Ability, input: Binding, output: Binding, opts: { damageSelf?: boolean } = {}) {
    const host = this.plan.hosts[i];

    // Trigger conditions that depend on state.
    if (a.trigger?.type === 'death' && a.trigger.hadMinus) {
      const death = [...this.previousEvents, ...this.events].reverse().find((e) => e.type === 'death');
      if (!death || !(death.minus ?? 0)) this.problem(`${a.card} needs a creature to die with a -1/-1 counter on it`);
    }
    if (a.id.endsWith('#undying') || a.id.endsWith('#persist')) {
      const death = [...this.events].reverse().find((e) => e.type === 'death' && e.card === a.card);
      if (!death) throw new LoopFails(`${a.card} did not die`);
      if (a.id.endsWith('#undying') && (death.plus ?? 0) > 0) throw new LoopFails(`${a.card} died with a +1/+1 counter, so undying does not return it`);
      if (a.id.endsWith('#persist') && (death.minus ?? 0) > 0) throw new LoopFails(`${a.card} died with a -1/-1 counter, so persist does not return it`);
    }

    this.timing(i, a);

    // Costs.
    if (a.cost.loyalty) {
      const pw = this.require(a.card, 'to use its loyalty ability');
      if (pw.loyaltyUsed && this.problem(`${a.card}'s loyalty ability was already used this turn`)) pw.loyaltyUsed = false;
      pw.loyaltyUsed = true;
    }
    if (a.cost.tap) {
      const name = host ?? a.card;
      // A token copy of the card has the same ability (Kiki-Jiki's hasty copies), so an untapped one can be used.
      const copy = this.perms.filter((x) => x.card === name && x.token && !x.tapped && (!x.sick || x.haste)).sort((x, y) => y.id - x.id)[0];
      const original = this.find(name);
      const p = original && !original.tapped ? original : (copy ?? this.require(name, 'to tap it'));
      if (p.tapped && this.problem(`${name} must start untapped`)) p.tapped = false;
      if (p.sick && !p.haste && p.types.includes('creature') && this.problem(`${name} must not be summoning sick`)) p.sick = false;
      p.tapped = true;
    }
    if (a.cost.sacrifice) {
      const victim = this.pickSacrifice(input, a);
      this.die(victim);
    }
    if (a.cost.life > 0 && this.life <= a.cost.life && this.problem(`needs more than ${a.cost.life} life to start`)) this.life = a.cost.life + 1;
    this.life -= a.cost.life;
    if (a.cost.removeCounter && a.cost.removeCounterFromAny) {
      const p = this.perms.find((x) => x.plus > 0);
      if (p) p.plus--;
      else this.problem(`a creature you control needs a +1/+1 counter for ${a.card}`);
    } else if (a.cost.removeCounter) {
      const p = this.require(a.card, 'to remove a counter');
      if (p.plus < 1 && this.problem(`${a.card} needs a +1/+1 counter to start`)) p.plus = 1;
      p.plus--;
    }
    if (a.cost.minusCounter) {
      const p = this.require(a.card, 'to put a -1/-1 counter on it');
      const prevented = this.plan.helpers.some((h) => h.kind === 'counterPreventer');
      if (!prevented) this.addCounters(p, 0, 1);
    }
    if (a.cost.discard) {
      const card = input.res === 'hand' && input.object ? input.object : this.hand[0];
      if (!card || (!this.takeFrom(this.hand, card) && this.problem(`${card} starts in your hand`))) this.leaveIfPresent(card ?? '');
      if (card) this.graveyard.push(card);
      this.events.push({ type: 'discard', card });
    }
    if (a.kind === 'recast') {
      if (!this.takeFrom(this.graveyard, a.card) && this.problem(`${a.card} starts in your graveyard`)) this.leaveIfPresent(a.card);
    }
    if (a.kind === 'cast' && a.from === 'library') {
      if (this.library[0] === a.card) this.library.shift();
      else if (this.problem(`${a.card} starts on top of your library`)) this.leaveIfPresent(a.card);
    } else if (a.kind === 'cast') {
      if (!this.takeFrom(this.hand, a.card) && this.problem(`${a.card} starts in your hand`)) this.leaveIfPresent(a.card);
    }
    // Before a mass reanimation (Living Death), sacrifice every creature to the outlet: that pays for it
    // and puts them in the graveyard to come back.
    if (has(a, 'massReanimate')) {
      for (const p of [...this.perms]) if (p.types.includes('creature')) this.spareTokens.add(p.id);
      this.sacrificeSpareTokens();
    }
    this.pay(this.costWithReductions(a), a.card);
    if (a.casts) this.events.push({ type: 'cast', casts: a.casts });

    // Effects.
    this.lastTokens = [];
    const permanentCast = (a.kind === 'cast' || a.kind === 'recast') && this.typesOf(a.card).length > 0;
    if (permanentCast) this.enter(a.card, false);
    for (const o of a.outputs) this.resolve(i, a, o, input, output, opts);
    // Panharmonicon: enter triggers from an artifact or creature entering happen twice. A doubled bounce
    // returns the source itself the second time (Venser bouncing Peregrine Drake, then itself).
    const doubled =
      this.plan.helpers.some((h) => h.kind === 'etbDoubler') &&
      a.kind === 'triggered' &&
      (a.trigger?.type === 'selfEtb' || a.trigger?.type === 'etb') &&
      this.typesOf(a.card).some((t) => t === 'artifact' || t === 'creature');
    if (doubled) {
      for (const o of a.outputs) this.resolve(i, a, o, input, o.type === 'bounce' ? { res: 'hand', object: a.card } : output, opts);
    }
    // Teysa Karlov: death triggers happen twice (the second copy's mana and life; its targets are the same).
    if (a.trigger?.type === 'death' && this.plan.helpers.some((h) => h.kind === 'deathDoubler')) {
      for (const o of a.outputs) if (o.type === 'mana' || o.type === 'lifegain' || o.type === 'drain') this.resolve(i, a, o, input, output, opts);
    }
    if (a.id.endsWith('#persist')) {
      const back = this.find(a.card);
      // Vizier of Remedies puts one fewer -1/-1 counter (Melira and Solemnity are handled in addCounters).
      const prevented = this.plan.helpers.some((h) => h.kind === 'counterPreventer');
      if (back && !prevented) this.addCounters(back, 0, 1);
    }
    if (a.kind === 'cast' && !permanentCast) this.graveyard.push(a.card);

    // Rings of Brighthearth: copy an untap-self ability, then tap the untapped rock for mana again.
    const copier = this.plan.helpers.find((h): h is Extract<Helper, { kind: 'copier' }> => h.kind === 'copier');
    const untapSelf = has(a, 'untap');
    if (copier && a.kind === 'activated' && untapSelf?.target === 'self') {
      const rock = this.find(a.card);
      const mana = this.plan.cycle.map((c) => (c.card === a.card && c.cost.tap ? has(c, 'mana') : undefined)).find(Boolean);
      if (rock && mana) {
        this.pay({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, generic: copier.cost }, copier.card);
        for (const k of [...COLORS, 'any'] as const) this.pool[k] += mana.mana[k];
      }
    }
  }

  private leaveIfPresent(card: string) {
    const p = this.find(card);
    if (p) this.leave(p);
  }

  private takeFrom(zone: string[], card: string): boolean {
    const at = zone.indexOf(card);
    if (at === -1) return false;
    zone.splice(at, 1);
    return true;
  }

  private pickSacrifice(input: Binding, a: Ability): Perm {
    if (input.object) return this.require(input.object, `to be sacrificed to ${a.card}`);
    // A token: the one just made, or any spare token of the right type.
    const what = a.cost.sacrifice!.what;
    const fits = (p: Perm) => p.token && (what === 'permanent' || p.types.includes(what));
    const recent = this.lastTokens.map((id) => this.perms.find((p) => p.id === id)).find((p): p is Perm => Boolean(p && fits(p)));
    const any = recent ?? this.perms.find(fits);
    if (any) {
      this.spareTokens.delete(any.id);
      return any;
    }
    this.problem(`needs a token to sacrifice to ${a.card}`);
    return this.enter(a.card, true, { types: what === 'artifact' ? ['artifact', 'creature'] : ['creature'], pt: '1/1' });
  }

  private resolve(i: number, a: Ability, o: Output, input: Binding, output: Binding, opts: { damageSelf?: boolean }) {
    const host = this.plan.hosts[i];
    switch (o.type) {
      case 'mana': {
        const times = o.variable ? (this.plan.variableX ?? 1) : 1;
        // High Tide: each Island untapped for mana makes an extra {U}.
        if (o.fromLands && this.plan.helpers.some((h) => h.kind === 'landAmplifier')) this.pool.U += o.mana.any * times;
        for (const k of [...COLORS, 'any'] as const) this.pool[k] += o.mana[k] * times;
        // Kinnan: tapping a nonland permanent for mana adds one more.
        if (a.kind === 'activated' && a.cost.tap && !this.typesOf(a.card).includes('land') && this.plan.helpers.some((h) => h.kind === 'manaAmplifier')) {
          const key = ([...COLORS, 'any'] as const).find((k) => o.mana[k] > 0);
          if (key) this.pool[key] += 1;
        }
        return;
      }
      case 'recurDied': {
        const card = input.res === 'death' ? input.object : null;
        if (!card) return;
        if (!this.takeFrom(this.graveyard, card) && this.problem(`${card} starts in your graveyard`)) this.leaveIfPresent(card);
        this.enter(card, false);
        return;
      }
      case 'tokenMana':
        if (output.res !== 'body') {
          for (const k of [...COLORS, 'any'] as const) this.pool[k] += o.mana[k];
          this.events.push({ type: 'death', card: null, token: true, types: ['creature'] });
        }
        return;
      case 'creature':
        for (let n = 0; n < o.count; n++) {
          const t = this.enter(a.card, true, { sick: !o.haste, haste: o.haste, types: o.artifact ? ['artifact', 'creature'] : ['creature'], pt: o.pt });
          this.lastTokens.push(t.id);
          // The first token is passed on as fodder when the next step sacrifices it; the rest are spare.
          if (!(n === 0 && output.res === 'body')) this.spareTokens.add(t.id);
        }
        return;
      case 'copy': {
        const target = o.target === 'host' ? (host ?? output.object ?? a.card) : (output.object ?? a.card);
        // Only a legal target: Mishra copying "target noncreature artifact" cannot copy the creature that attacks next.
        // (With Helm of the Host the copies are not legendary, so Kiki-Jiki's token can target itself.)
        const nonlegendary = this.plan.helpers.some((h) => h.kind === 'nonlegendary');
        const spec = o.target !== 'host' && nonlegendary ? { ...o.target, nonlegendary: false } : o.target;
        if (spec !== 'host' && !matchesTarget(spec, this.cardOf(target), a.card)) throw new LoopFails(`${a.card} cannot copy ${target}`);
        if (!this.find(target) && this.problem(`${target} must be on the battlefield to be copied`)) this.enter(target, false, { sick: false });
        const t = this.enter(target, true, { sick: !o.haste, haste: o.haste, types: this.typesOf(target) });
        this.lastTokens.push(t.id);
        return;
      }
      case 'recur':
        if (!this.takeFrom(this.graveyard, a.card)) this.problem(`${a.card} starts in your graveyard`);
        this.leaveIfPresent(a.card);
        this.enter(a.card, false);
        return;
      case 'blink': {
        const targets: string[] = [];
        if (o.target === 'self') targets.push(a.card);
        else if (o.target === 'host') targets.push(host ?? output.object ?? a.card);
        else if (output.object) targets.push(output.object);
        for (const h of this.plan.helpers) if (h.kind === 'blinkTarget' && targets.length < o.count) targets.push(h.card);
        for (const name of targets) {
          const p = this.require(name, `to be flickered by ${a.card}`);
          this.leave(p);
          const back = this.enter(name, false);
          back.haste = p.haste;
          // The second flicker target's enter ability (e.g. Peregrine Drake untapping lands).
          const helper = this.plan.helpers.find((h): h is Extract<Helper, { kind: 'blinkTarget' }> => h.kind === 'blinkTarget' && h.card === name);
          if (helper) for (const out of helper.ability.outputs) this.resolve(i, helper.ability, out, input, { res: 'free' }, {});
        }
        return;
      }
      case 'returnExiled': {
        const linked = this.exile.find((e) => e.by === a.card);
        if (linked) {
          this.exile = this.exile.filter((e) => e !== linked);
          this.enter(linked.card, false);
        } else if (this.problem(`${a.card} must have exiled a card`)) {
          const target = this.plan.exiles[a.card];
          if (target) this.enter(target, false);
        }
        return;
      }
      case 'reanimate': {
        const target = this.plan.reanimates[i];
        if (!target) return;
        if (!this.takeFrom(this.graveyard, target) && this.problem(`${target} starts in your graveyard`)) this.leaveIfPresent(target);
        this.enter(target, false);
        return;
      }
      case 'untap': {
        if (o.all) {
          const spec = typeof o.target === 'string' ? null : o.target;
          const self = this.perms.filter((p) => p.card === a.card);
          for (const p of this.perms) {
            if (spec?.nonland && p.types.includes('land')) continue;
            if (spec && !spec.types.includes('permanent') && !spec.types.some((t) => p.types.includes(t))) continue;
            if (o.attacking && !this.attackers.has(p.id)) continue;
            // "all other creatures": not the creature whose ability this is (the newest object, if several).
            if (o.other && p === self.sort((x, y) => y.id - x.id)[0]) continue;
            p.tapped = false;
          }
          return;
        }
        const name =
          o.target === 'self'
            ? a.card
            : o.target === 'host'
              ? (this.plan.hosts[i] ?? output.object ?? null)
              : output.res === 'untap' || output.res === 'reset'
                ? output.object!
                : this.firstTapped(o.target, a.card);
        const p = name ? this.find(name) : undefined;
        if (p) p.tapped = false;
        return;
      }
      case 'toHand': {
        const card = output.res === 'hand' ? output.object! : undefined;
        if (!card) return;
        if (!this.takeFrom(this.graveyard, card) && this.problem(`${card} starts in your graveyard`)) this.leaveIfPresent(card);
        this.hand.push(card);
        return;
      }
      case 'lifegain': {
        // "you gain that much life" (Exquisite Blood) uses the life just lost.
        const amount = o.amount === 0 ? (this.lastAmount('drain') ?? 1) : o.amount;
        this.life += amount;
        this.events.push({ type: 'lifegain', amount });
        return;
      }
      case 'drain': {
        const self = this.find(a.card);
        const power = (this.cardOf(a.card).power ?? 0) + (self ? self.plus - self.minus + this.anthem(self) : 0);
        const amount = o.amount === 0 ? (this.lastAmount('lifegain') ?? 1) : o.amount === -1 ? power : o.amount;
        if (opts.damageSelf) {
          if (self) self.damage += amount;
        } else {
          this.opponentLife -= amount;
          this.events.push({ type: 'drain', amount });
        }
        const lifelink = output.lifelinkFrom || input.lifelinkFrom || this.cardOf(a.card).keywords.includes('lifelink');
        if (o.damage && lifelink) {
          this.life += amount;
          this.events.push({ type: 'lifegain', amount });
        }
        return;
      }
      case 'toTop': {
        const self = this.find(a.card);
        if (self) this.leave(self);
        this.library.unshift(a.card);
        return;
      }
      case 'bounce': {
        const target = output.res === 'hand' ? output.object : null;
        const p = target ? this.find(target) : undefined;
        if (!p) return;
        this.leave(p);
        this.hand.push(p.card);
        return;
      }
      case 'massReanimate': {
        // Living Death: exile creature cards from the graveyard, sacrifice all creatures, return the exiled cards.
        const returning = this.graveyard.filter((c) => this.cardOf(c).typeLine.includes('Creature'));
        this.graveyard = this.graveyard.filter((c) => !returning.includes(c));
        for (const p of [...this.perms]) if (p.types.includes('creature')) this.die(p);
        for (const c of returning) this.enter(c, false);
        return;
      }
      case 'selfLifeLoss':
        this.life -= o.amount;
        return;
      case 'minusCounter': {
        // On a 1-toughness token the loop made (it dies: Blowfly), or else on an opponent's creature.
        if (output.res === 'death' && output.hadMinus) {
          const victim = [...this.perms].reverse().find((p) => p.token && p.types.includes('creature') && this.toughness(p) <= 1);
          if (victim) this.addCounters(victim, 0, 1);
          else this.problem(`${a.card} needs a 1/1 token to put the -1/-1 counter on`);
        }
        this.events.push({ type: 'minus' });
        return;
      }
      case 'spellCopy':
        return;
      case 'mill': {
        // "that player mills that many cards" (Mindcrank): as many as the life just lost.
        const amount = o.amount === 0 ? (this.lastAmount('drain') ?? 1) : o.amount;
        this.opponentMilled += amount;
        this.events.push({ type: 'mill', amount });
        return;
      }
      case 'dredge':
        // Replaces the draw: the card comes back from the graveyard, and you mill instead.
        if (!this.takeFrom(this.graveyard, a.card) && this.problem(`${a.card} starts in your graveyard`)) this.leaveIfPresent(a.card);
        this.hand.push(a.card);
        this.selfMilled += o.amount;
        return;
      case 'extraCombat':
        this.addCombat(o.withMain);
        return;
      case 'counter': {
        const amount = o.amount === 0 ? (this.lastLifegain() ?? 1) : (o.amount ?? 1);
        if (o.bolster) {
          // Bolster: the creature you control with the least toughness.
          const creatures = this.perms.filter((p) => p.types.includes('creature'));
          const least = creatures.sort((x, y) => this.toughness(x) - this.toughness(y))[0];
          if (least) this.addCounters(least, amount, 0);
          return;
        }
        if (o.each) {
          for (const p of this.perms) if (p.types.includes('creature')) this.addCounters(p, amount, 0);
          return;
        }
        const name = o.target === 'self' ? a.card : o.target === 'host' ? (host ?? output.object) : output.res === 'counter' ? output.object : null;
        const p = name ? this.find(name) : undefined;
        if (p) this.addCounters(p, amount, 0);
        return;
      }
      case 'draw': {
        // A draw that the next step replaces with dredge is not a draw.
        const next = this.plan.cycle[(i + 1) % this.plan.cycle.length]!;
        if (!(output.res === 'draw' && has(next, 'dredge'))) this.events.push({ type: 'draw', amount: o.amount });
        return;
      }
      default:
        return;
    }
  }

  private lastAmount(type: 'drain' | 'lifegain'): number | undefined {
    return [...this.events].reverse().find((e) => e.type === type)?.amount;
  }

  private lastLifegain(): number | undefined {
    return [...this.events].reverse().find((e) => e.type === 'lifegain')?.amount;
  }

  private firstTapped(spec: Exclude<Extract<Output, { type: 'untap' }>['target'], 'self' | 'host'>, source: string): string | null {
    const p = this.perms.find((x) => x.tapped && !x.token && matchesTarget(spec, this.cardOf(x.card), source));
    return p?.card ?? null;
  }

  /** Helper triggers (a Treasure per death, life per death, a Thopter per artifact cast) fire on each event. */
  private fireRiders(from: number) {
    const riders = this.plan.helpers.filter((h): h is Extract<Helper, { kind: 'rider' }> => h.kind === 'rider');
    // Events whose riders already fired (combat damage resolved mid-step) are not fired twice.
    const start = Math.max(from, this.firedUpTo);
    this.firedUpTo = this.events.length;
    if (!riders.length) return;
    const fresh = this.events.slice(start);
    const deathDoubled = this.plan.helpers.some((h) => h.kind === 'deathDoubler');
    for (const { ability } of riders) {
      for (const e of fresh) {
        if (!riderMatches(ability, e)) continue;
        const times = e.type === 'death' && deathDoubled ? 2 : 1;
        for (let n = 0; n < times; n++)
        for (const o of ability.outputs) {
          if (o.type === 'mana') for (const k of [...COLORS, 'any'] as const) this.pool[k] += o.mana[k] * (o.variable && o.fromLands ? (this.plan.variableX ?? 1) : 1);
          if (o.type === 'lifegain') this.life += o.amount;
          if (o.type === 'selfLifeLoss') this.life -= o.amount;
          if (o.type === 'drain') this.opponentLife -= o.amount;
          // Cathars' Crusade (+1/+1 on each creature) and Anafenza (bolster) cancel a persist creature's -1/-1.
          if (o.type === 'counter' && o.each) for (const p of this.perms) if (p.types.includes('creature')) this.addCounters(p, o.amount ?? 1, 0);
          if (o.type === 'counter' && o.bolster) {
            const least = this.perms.filter((p) => p.types.includes('creature')).sort((x, y) => this.toughness(x) - this.toughness(y))[0];
            if (least) this.addCounters(least, o.amount ?? 1, 0);
          }
          if (o.type === 'creature') {
            for (let n = 0; n < o.count; n++) {
              this.spareTokens.add(this.enter(ability.card, true, { types: o.artifact ? ['artifact', 'creature'] : ['creature'], pt: o.pt }).id);
            }
          }
        }
      }
    }
  }

  /** Leftover tokens go to a free sacrifice outlet for mana (Ashnod's Altar, Krark-Clan Ironworks). */
  private sacrificeSpareTokens() {
    // Cards the loop also has to kill each pass (Reveillark's partner), sacrificed to any free outlet.
    for (const name of this.plan.extraSacrifices ?? []) {
      const p = this.find(name);
      if (!p) continue;
      const outlet = this.plan.cycle.find((a) => a.kind === 'activated' && a.cost.sacrifice && !a.cost.tap && totalMana(a.cost.mana) === 0);
      if (!outlet) continue;
      const before = this.events.length;
      this.die(p);
      const mana = has(outlet, 'mana');
      if (mana) for (const k of [...COLORS, 'any'] as const) this.pool[k] += mana.mana[k];
      this.fireRiders(before);
    }
    const outlets = [
      ...this.plan.cycle.filter(isFreeOutlet),
      ...this.plan.helpers.flatMap((h) => (h.kind === 'outlet' ? [h.ability] : [])),
    ];
    if (!outlets.length) return;
    for (const id of [...this.spareTokens]) {
      // Tokens, or creature cards a mass reanimation returned (they must die again before the next one).
      const token = this.perms.find((p) => p.id === id);
      if (!token) continue;
      const outlet = outlets.find((o) => o.cost.sacrifice!.what === 'permanent' || token.types.includes(o.cost.sacrifice!.what));
      if (!outlet) continue;
      const before = this.events.length;
      this.die(token);
      const mana = has(outlet, 'mana');
      if (mana) for (const k of [...COLORS, 'any'] as const) this.pool[k] += mana.mana[k];
      this.fireRiders(before);
    }
    this.spareTokens.clear();
  }

  snapshot() {
    const nontoken = this.perms.filter((p) => !p.token).sort((a, b) => a.card.localeCompare(b.card) || a.id - b.id);
    // +1/+1 counters may grow from loop to loop (that is a payoff); everything else must repeat exactly.
    const perms = nontoken.map((p) => `${p.card}|${p.tapped ? 'T' : ''}|-${p.minus}|d${p.damage}|${p.loyaltyUsed ? 'L' : ''}`);
    return {
      state: JSON.stringify({
        perms,
        graveyard: [...this.graveyard].sort(),
        hand: [...this.hand].sort(),
        library: this.library,
        exile: this.exile.map((e) => e.card).sort(),
      }),
      plus: nontoken.map((p) => p.plus),
      tokens: this.perms.filter((p) => p.token).length,
      pool: { ...this.pool },
      life: this.life,
      opponentLife: this.opponentLife,
      events: [...this.events],
      combats: this.combatsStarted,
      milled: this.opponentMilled,
      selfMilled: this.selfMilled,
    };
  }
}

/** Stand-in for the generic "other creatures" a mass reanimation needs. */
function fillerCard(name: string): Card {
  return {
    name,
    quantity: 1,
    typeLine: 'Creature',
    oracleText: '',
    text: '',
    keywords: [],
    colorIdentity: [],
    manaCost: '',
    cmc: 0,
    power: 1,
    toughness: 1,
    creatureTypes: [],
  };
}

function reducerApplies(what: string, casts: string[]): boolean {
  if (what === 'any' || what === 'chosen') return true;
  if (what === 'noncreature') return !casts.includes('creature');
  if (what === 'instant and sorcery') return casts.includes('instant') || casts.includes('sorcery');
  return casts.includes(what);
}

const isFreeOutlet = (a: Ability) =>
  a.kind === 'activated' && Boolean(a.cost.sacrifice) && !a.cost.tap && totalMana(a.cost.mana) === 0 && a.cost.life === 0 && Boolean(has(a, 'mana'));

function riderMatches(r: Ability, e: Event): boolean {
  const t = r.trigger;
  if (!t) return false;
  switch (t.type) {
    case 'death':
      return e.type === 'death' && (e.types ?? []).includes(t.what) && !(t.nontoken && e.token) && !(t.another && e.card === r.card) && (!t.self || e.card === r.card);
    case 'etb':
      return e.type === 'etb' && (e.types ?? []).includes('creature') && !(t.nontoken && e.token) && !(t.another && e.card === r.card);
    case 'cast':
      return e.type === 'cast' && (t.what === 'any' || (t.what === 'artifact' ? (e.casts ?? []).includes('artifact') : (e.casts ?? []).some((c) => c === 'instant' || c === 'sorcery')));
    case 'lifegain':
      return e.type === 'lifegain';
    case 'drain':
      return e.type === 'drain';
    case 'draw':
      return e.type === 'draw';
    case 'selfEtb':
      return e.type === 'etb' && e.card === r.card;
    case 'minus':
      return e.type === 'minus';
    case 'attack':
      return e.type === 'attack' && (t.source === 'self' ? e.card === r.card : Boolean(e.first));
    case 'combatDamage':
      return e.type === 'combatDamage' && (t.source === 'self' ? e.card === r.card : true);
    case 'beginCombat':
      return e.type === 'beginCombat';
    case 'mill':
      return e.type === 'mill';
    default:
      return false;
  }
}

function describeCost(c: ManaCost): string {
  const parts: string[] = [];
  if (c.generic) parts.push(`{${c.generic}}`);
  for (const k of COLORS) for (let n = 0; n < c[k]; n++) parts.push(`{${k}}`);
  return parts.join('');
}

const PASSES = 3;

/**
 * Play the loop out. Tries every starting step (the loop can be entered anywhere)
 * and keeps the start that needs the least setup.
 */
export function verifyLoop(plan: LoopPlan, ctx: Context): Verification {
  const k = plan.cycle.length;
  let best: Verification | null = null;
  for (let start = 0; start < k; start++) {
    const rotated = rotate(plan, start);
    const result = runFrom(rotated, ctx);
    if (result.ok && (!best || !best.ok || result.startup.length < best.startup.length)) best = result;
    if (!best) best = result;
  }
  return best!;
}

function rotate(plan: LoopPlan, start: number): LoopPlan {
  const k = plan.cycle.length;
  const order = Array.from({ length: k }, (_, i) => (i + start) % k);
  const remap = (rec: Record<number, string>) => Object.fromEntries(order.flatMap((old, i) => (rec[old] !== undefined ? [[i, rec[old]!]] : [])));
  return {
    ...plan,
    cycle: order.map((i) => plan.cycle[i]!),
    bindings: order.map((i) => plan.bindings[i]!),
    hosts: remap(plan.hosts),
    reanimates: remap(plan.reanimates),
  };
}

function runFrom(plan: LoopPlan, ctx: Context): Verification {
  const sim = new Simulation(plan, ctx);
  const cards = new Set([
    ...plan.cycle.flatMap((a) => (a.with ? [a.card, a.with] : [a.card])),
    ...plan.helpers.map((h) => h.card),
    ...Object.values(plan.hosts).filter((h) => h === ANY_CREATURE),
  ]);
  // Everything starts where it usually is: permanents on the battlefield (not summoning sick), spells in hand.
  for (const name of [...cards].sort()) {
    const card = ctx.cardByName.get(name) ?? fillerCard(name);
    if (/\b(Instant|Sorcery)\b/.test(card.typeLine)) {
      if (!plan.cycle.some((a) => a.with === name)) sim.hand.push(name);
    } else {
      const p = sim.enter(name, false, { sick: false });
      // A 0-toughness creature that "enters with X +1/+1 counters" (Walking Ballista) must be cast with X >= 1.
      if (/~ enters with x \+1\/\+1 counters/.test(card.text) && (card.toughness ?? 0) === 0 && p.plus === 0) {
        p.plus = 1;
        sim.startup.add(`${name} cast with X ≥ 1`);
      }
    }
  }
  for (let n = 1; n <= (plan.extraCreatures ?? 0); n++) sim.enter(`Other creature ${n}`, false, { sick: false });
  for (const [by, target] of Object.entries(plan.exiles)) {
    const p = sim.perms.find((x) => x.card === target);
    if (p) {
      sim.perms = sim.perms.filter((x) => x !== p);
      sim.exile.push({ card: target, by });
    }
  }
  sim.events = [];

  const empty: PerLoop = { mana: emptyProduction(), life: 0, opponentLife: 0, deaths: 0, etbs: 0, draws: 0, tokens: 0, casts: 0, combats: 0, milled: 0, selfMilled: 0 };
  try {
    // Two setup passes: some loops need priming before they repeat (Blowfly Infestation needs an Insect from the
    // first pass to kill in the second). Problems found here become startup requirements.
    sim.runPass();
    sim.runPass();
    sim.setup = false;
    const snaps = [];
    for (let n = 0; n < PASSES; n++) {
      sim.runPass();
      snaps.push(sim.snapshot());
    }
    const [, prev, last] = snaps as [unknown, ReturnType<Simulation['snapshot']>, ReturnType<Simulation['snapshot']>];
    if (last.state !== prev.state) return { ok: false, reason: 'the board does not return to the same state each loop', startup: [...sim.startup], perLoop: empty };
    if (last.plus.some((n, i) => n < prev.plus[i]!)) return { ok: false, reason: '+1/+1 counters run out', startup: [...sim.startup], perLoop: empty };
    if (last.tokens < prev.tokens) return { ok: false, reason: 'tokens run out', startup: [...sim.startup], perLoop: empty };
    const mana = emptyProduction();
    for (const key of [...COLORS, 'any'] as const) {
      mana[key] = last.pool[key] - prev.pool[key];
      if (mana[key] < 0 && key !== 'any') return { ok: false, reason: `loses ${key} mana each loop`, startup: [...sim.startup], perLoop: empty };
    }
    if (COLORS.reduce((n, c) => n + mana[c], 0) + mana.any < 0) return { ok: false, reason: 'loses mana each loop', startup: [...sim.startup], perLoop: empty };
    const lifeDelta = last.life - prev.life;
    if (lifeDelta < 0) return { ok: false, reason: `costs ${-lifeDelta} life each loop`, startup: [...sim.startup], perLoop: empty };
    const ev = last.events;
    return {
      ok: true,
      startup: [...sim.startup],
      perLoop: {
        mana,
        life: lifeDelta,
        opponentLife: last.opponentLife - prev.opponentLife,
        deaths: ev.filter((e) => e.type === 'death').length,
        etbs: ev.filter((e) => e.type === 'etb').length,
        draws: ev.filter((e) => e.type === 'draw').reduce((n, e) => n + (e.amount ?? 1), 0),
        tokens: last.tokens - prev.tokens,
        casts: ev.filter((e) => e.type === 'cast').length,
        combats: last.combats,
        milled: last.milled - prev.milled,
        selfMilled: last.selfMilled - prev.selfMilled,
      },
    };
  } catch (err) {
    if (err instanceof LoopFails) return { ok: false, reason: err.message, startup: [...sim.startup], perLoop: empty };
    throw err;
  }
}
