import type { Card } from './types.ts';

/**
 * Structured abilities parsed from oracle text, for combo detection. This covers
 * the costs and effects that make loops (sacrifice, mana, untap, copy, blink,
 * recursion, life, counters). Anything else is ignored rather than guessed at.
 */

export type Color = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';
export const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G', 'C'];

/** Mana produced: specific symbols plus mana of any color. */
export interface ManaProduction {
  W: number;
  U: number;
  B: number;
  R: number;
  G: number;
  C: number;
  any: number;
}

/** Mana required: specific symbols plus generic. */
export interface ManaCost {
  W: number;
  U: number;
  B: number;
  R: number;
  G: number;
  C: number;
  generic: number;
}

export const emptyProduction = (): ManaProduction => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, any: 0 });
export const emptyCost = (): ManaCost => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, generic: 0 });

/** What a target-taking effect may target. */
export interface TargetSpec {
  /** Card types allowed ("permanent" means any permanent). */
  types: string[];
  nonlegendary: boolean;
  /** Subtypes excluded, from "non-Angel". */
  excluded: string[];
  /** "another target": may not target the source card. */
  another: boolean;
}

export type Output =
  | { type: 'mana'; mana: ManaProduction }
  /** Mana from a created token sacrificing itself (Eldrazi Spawn). Only usable if the token is not also sacrificed elsewhere. */
  | { type: 'tokenMana'; mana: ManaProduction }
  | { type: 'creature'; token: boolean; count: number; haste: boolean }
  | { type: 'copy'; target: TargetSpec | 'host'; haste: boolean }
  | { type: 'recur' }
  | { type: 'blink'; target: TargetSpec }
  | { type: 'untap'; target: TargetSpec }
  | { type: 'lifegain'; amount: number }
  | { type: 'drain'; amount: number; damage: boolean }
  | { type: 'counter'; target: TargetSpec | 'self' }
  | { type: 'draw'; amount: number }
  | { type: 'selfLifeLoss'; amount: number };

export type Trigger =
  | { type: 'death'; self: boolean; another: boolean; nontoken: boolean }
  | { type: 'selfEtb' }
  | { type: 'etb'; another: boolean; nontoken: boolean }
  | { type: 'lifegain' }
  | { type: 'drain' };

export interface Ability {
  id: string;
  card: string;
  /** The oracle line it came from, for display. */
  text: string;
  /** activated: paid costs; triggered: fires on an event; recast: cast/return this card from the graveyard. */
  kind: 'activated' | 'triggered' | 'recast';
  trigger?: Trigger;
  cost: {
    mana: ManaCost;
    tap: boolean;
    /** Sacrifice a creature as a cost. "another" excludes this card. */
    sacrifice: null | { another: boolean };
    life: number;
    removeCounter: boolean;
  };
  /** Granted to "enchanted creature": the tap and copy apply to the creature it is attached to. */
  host: boolean;
  outputs: Output[];
  oncePerTurn: boolean;
  /** "as long as ..." / "if you control ..." clauses, shown as prerequisites. */
  conditions: string[];
  /** The cost includes something not modeled (e.g. "Sacrifice a Food"), so the ability is never used in a loop. */
  unmodeledCost: boolean;
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, x: 0, that: 1 };
const toNumber = (w: string | undefined, fallback = 1) => (w === undefined ? fallback : /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w] ?? fallback);

/** Parse "{2}{B}{B}"-style symbols (lowercase or uppercase). Hybrid and Phyrexian symbols count as their first color. */
export function parseManaCost(symbols: string): ManaCost {
  const cost = emptyCost();
  for (const [, raw] of symbols.matchAll(/\{([^}]+)\}/g)) {
    const sym = raw!.toUpperCase();
    if (/^\d+$/.test(sym)) cost.generic += Number(sym);
    else if (sym === 'X' || sym === 'T' || sym === 'Q') continue;
    else {
      const first = sym.split('/')[0]! as Color;
      if (COLORS.includes(first)) cost[first]++;
      else if (/^\d+$/.test(first)) cost.generic += Number(first);
    }
  }
  return cost;
}

function parseManaProduction(effect: string): ManaProduction | null {
  const prod = emptyProduction();
  const add = /\badd ((?:\{[wubrgc]\})+)/.exec(effect);
  if (add) {
    for (const [, sym] of add[1]!.matchAll(/\{([wubrgc])\}/g)) prod[sym!.toUpperCase() as Color]++;
    // "Add {R}, {G}, or {B}" is a choice of one, not all three.
    if (/\badd \{[wubrgc]\}(?:, \{[wubrgc]\})*,? or \{[wubrgc]\}/.test(effect)) return { ...emptyProduction(), any: 1 };
    return prod;
  }
  const anyColor = /\badd (one|two|three) mana of any (?:one )?color/.exec(effect);
  if (anyColor) return { ...prod, any: toNumber(anyColor[1]) };
  const treasure = /\bcreate (a|an|one|two|three|\d+) treasure tokens?(?! for each)/.exec(effect);
  if (treasure) return { ...prod, any: toNumber(treasure[1]) };
  return null;
}

function parseTargetSpec(phrase: string, another = false): TargetSpec {
  const types = [...phrase.matchAll(/\b(permanent|creature|artifact|enchantment|land|planeswalker)s?\b/g)].map((m) => m[1]!);
  return {
    types: types.length ? [...new Set(types)] : ['permanent'],
    nonlegendary: /\bnonlegendary\b/.test(phrase),
    excluded: [...phrase.matchAll(/\bnon-(\w+)/g)].map((m) => m[1]!),
    another: another || /\banother\b/.test(phrase),
  };
}

const CAPITALIZE = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function matchesTarget(spec: TargetSpec, target: Card, source: string): boolean {
  if (spec.another && target.name === source) return false;
  if (spec.nonlegendary && /\bLegendary\b/.test(target.typeLine)) return false;
  for (const ex of spec.excluded) if (new RegExp(`\\b${CAPITALIZE(ex)}\\b`).test(target.typeLine)) return false;
  return spec.types.some((t) =>
    t === 'permanent' ? !/\b(Instant|Sorcery)\b/.test(target.typeLine) : new RegExp(`\\b${CAPITALIZE(t)}\\b`).test(target.typeLine),
  );
}

function parseOutputs(rawEffect: string, host: boolean): Output[] {
  // Quoted text is an ability granted to something else (e.g. a token's "Sacrifice this token: Add {C}").
  const effect = rawEffect.replace(/"[^"]*"/g, '');
  const outputs: Output[] = [];
  // Self-references were normalized, so "Sacrifice this token" reads "sacrifice ~".
  const tokenMana = /creature tokens?[^"]*"sacrifice (?:~|this (?:token|creature)): (add [^"]*)"/.exec(rawEffect);
  const tokenProduction = tokenMana ? parseManaProduction(tokenMana[1]!) : null;
  if (tokenProduction) outputs.push({ type: 'tokenMana', mana: tokenProduction });
  const mana = parseManaProduction(effect);
  if (mana) outputs.push({ type: 'mana', mana });

  const copy = /create a token that's a copy of (target [^,.]*?creature[^,.]*?|~)(?:,|\.|$)/.exec(effect);
  if (copy) {
    outputs.push({ type: 'copy', target: copy[1] === '~' || host ? 'host' : parseTargetSpec(copy[1]!), haste: /has haste|gains haste/.test(effect) });
  } else {
    const tokens = /create (a|an|one|two|three|four|five|x|\d+) [^.]*?\b(\d+\/\d+)[^.]*?creature tokens?|create (a|an|one|two|three|four|five|x|\d+) [^.]*?creature tokens?/.exec(effect);
    if (tokens) outputs.push({ type: 'creature', token: true, count: toNumber(tokens[1] ?? tokens[3]), haste: /with haste|gains? haste/.test(effect) });
  }

  if (/return ~ from your graveyard to the battlefield/.test(effect)) outputs.push({ type: 'recur' });

  const blink = /exile (another target|target|up to one target) ([^.,]*?creature[^.,]*?)(?:,|\.)? (?:then )?return (?:it|that card|the exiled card)[^.]*to the battlefield/.exec(effect);
  if (blink) outputs.push({ type: 'blink', target: parseTargetSpec(blink[2]!, blink[1] === 'another target') });

  const untap = /\b(?:tap or )?untap (target [^.,]*?|another target [^.,]*?|that \w+|it)(?:[.,]|$| and)/.exec(effect);
  if (untap && !/doesn't untap/.test(effect)) {
    let phrase = untap[1]!;
    // "gain control of target permanent ... Untap that permanent."
    if (/^(that|it)/.test(phrase)) phrase = /target ([^.,]*)/.exec(effect)?.[0] ?? 'permanent';
    outputs.push({ type: 'untap', target: parseTargetSpec(phrase) });
  }

  const gain = /\byou gain (\d+|x|that much) life/.exec(effect);
  if (gain) outputs.push({ type: 'lifegain', amount: gain[1] === 'that much' ? 1 : toNumber(gain[1]) });

  const lose = /(?:target player|target opponent|each opponent|that player) loses? (\d+|x|that much) life/.exec(effect);
  if (lose) outputs.push({ type: 'drain', amount: lose[1] === 'that much' ? 1 : toNumber(lose[1]), damage: false });
  const damage = /deals? (\d+|x) damage to (?:any target|each opponent|target player|target opponent|any other target)/.exec(effect);
  if (damage) outputs.push({ type: 'drain', amount: toNumber(damage[1]), damage: true });
  const selfDamage = /deals? (\d+) damage to you|you lose (\d+) life/.exec(effect);
  if (selfDamage) outputs.push({ type: 'selfLifeLoss', amount: toNumber(selfDamage[1] ?? selfDamage[2]) });

  const counter = /put (?:a|one|two|\w+) \+1\/\+1 counters? on (~|target [^.]*?)(?:\.|,| and|$)/.exec(effect);
  if (counter) outputs.push({ type: 'counter', target: counter[1] === '~' ? 'self' : parseTargetSpec(counter[1]!) });

  const draw = /\bdraws? (a|two|three|x|\d+) cards?/.exec(effect);
  if (draw && !/opponent draws|each player draws/.test(effect)) outputs.push({ type: 'draw', amount: toNumber(draw[1]) });

  return outputs;
}

function parseTrigger(condition: string): Trigger | null {
  const death = /^when(?:ever)? (~ or )?(another |a |one or more )?(other )?(nontoken )?creatures?(?: or planeswalkers?)?(?: you control)? (?:dies|die)\b/.exec(condition);
  if (death) {
    // "~ or another creature" includes the card itself, so it is not an "another" restriction.
    const another = !death[1] && Boolean(death[2]?.startsWith('another') || death[3]);
    return { type: 'death', self: false, another, nontoken: Boolean(death[4]) };
  }
  if (/^whenever you sacrifice (?:a|another) (?:creature|permanent)/.test(condition)) return { type: 'death', self: false, another: false, nontoken: false };
  if (/^when(?:ever)? ~ (?:enters|dies)/.test(condition)) {
    return /^when(?:ever)? ~ enters/.test(condition) ? { type: 'selfEtb' } : { type: 'death', self: true, another: false, nontoken: false };
  }
  const etb = /^whenever (another |a |one or more )(other )?(nontoken )?creatures?(?: you control)? enters?/.exec(condition);
  if (etb) return { type: 'etb', another: etb[1]!.startsWith('another') || Boolean(etb[2]), nontoken: Boolean(etb[3]) };
  if (/^whenever you gain life/.test(condition)) return { type: 'lifegain' };
  if (/^whenever (?:an opponent|a player|one or more opponents) loses? life/.test(condition)) return { type: 'drain' };
  return null;
}

function conditionsOf(text: string): string[] {
  return [...text.matchAll(/\b(as long as [^.]*|if you control [^.,]*)/g)].map((m) => m[1]!);
}

/** First ":" that is not inside a quoted granted ability. */
function costSplit(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) return i;
  }
  return -1;
}

function makeAbility(card: Card, line: number, text: string, partial: Partial<Ability> & Pick<Ability, 'kind' | 'outputs'>): Ability {
  return {
    id: `${card.name}#${line}`,
    card: card.name,
    text,
    cost: { mana: emptyCost(), tap: false, sacrifice: null, life: 0, removeCounter: false },
    host: false,
    oncePerTurn: /only once each turn|activate only once/.test(text.toLowerCase()),
    unmodeledCost: false,
    conditions: conditionsOf(text.toLowerCase()),
    ...partial,
  };
}

function parseActivated(card: Card, lineNo: number, display: string, line: string, host: boolean): Ability | null {
  const split = costSplit(line);
  if (split === -1) return null;
  const costText = line.slice(0, split);
  const effect = line.slice(split + 1).trim();
  // Loyalty abilities and keyword costs ("Equip {2}") are not loop pieces.
  if (/^[+-−]?\d+$|^\[/.test(costText.trim())) return null;
  const outputs = parseOutputs(effect, host);
  const sac = /sacrifice (another|a|an) (?:nontoken )?creature/.exec(costText);
  // Whatever is left after removing the cost parts we understand must be empty.
  const leftover = costText
    .replace(/\{[^}]+\}/g, '')
    .replace(/sacrifice (?:another|a|an) (?:nontoken )?creature/, '')
    .replace(/pay \d+ life/, '')
    .replace(/remove (?:a|one) \+1\/\+1 counter from ~/, '')
    .replace(/[,\s]|\band\b/g, '');
  const ability = makeAbility(card, lineNo, display, {
    kind: /return ~ from your graveyard to the battlefield/.test(effect) ? 'recast' : 'activated',
    host,
    outputs,
    cost: {
      mana: parseManaCost(costText),
      tap: /\{t\}/.test(costText),
      sacrifice: sac ? { another: sac[1] === 'another' } : null,
      life: toNumber(/pay (\d+) life/.exec(costText)?.[1], 0),
      removeCounter: /remove (?:a|one) \+1\/\+1 counter from ~/.test(costText),
    },
  });
  ability.unmodeledCost = leftover.length > 0;
  if (ability.kind === 'recast') {
    ability.outputs = ability.outputs.filter((o) => o.type !== 'recur');
    return ability;
  }
  return ability.outputs.length || ability.cost.sacrifice ? ability : null;
}

/** Parse the loop-relevant abilities of a card. Ability ids are "<card>#<oracle line>". */
export function parseAbilities(card: Card): Ability[] {
  const abilities: Ability[] = [];
  const lines = card.text.split('\n');
  const displayLines = card.oracleText.split('\n');

  lines.forEach((line, i) => {
    const display = (displayLines[i] ?? line).replace(/ ?\([^)]*\)/g, '');

    // Granted to the enchanted creature: 'Enchanted creature has "{T}: ..."'.
    const granted = /enchanted creature has "([^"]+)"/.exec(line);
    if (granted) {
      const a = parseActivated(card, i, display, granted[1]!, true);
      if (a) abilities.push(a);
      return;
    }

    const recast = /you may cast ~ from your graveyard/.exec(line);
    if (recast) {
      abilities.push(
        makeAbility(card, i, display, {
          kind: 'recast',
          outputs: [],
          cost: { mana: parseManaCost(card.manaCost), tap: false, sacrifice: null, life: 0, removeCounter: false },
        }),
      );
      return;
    }

    if (/^when|^whenever/.test(line)) {
      const comma = line.indexOf(',');
      const condition = comma === -1 ? line : line.slice(0, comma);
      const trigger = parseTrigger(condition);
      if (!trigger) return;
      const effect = comma === -1 ? '' : line.slice(comma + 1);
      // "you may pay {1}. If you do, ..." costs mana per trigger; treat it as unmodeled.
      if (/you may pay \{/.test(effect)) return;
      const outputs = parseOutputs(effect, false);
      if (outputs.length) abilities.push(makeAbility(card, i, display, { kind: 'triggered', trigger, outputs }));
      return;
    }

    const activated = parseActivated(card, i, display, line, false);
    if (activated) abilities.push(activated);
  });
  return abilities;
}

/** Cards in the deck that can give another creature lifelink, by name. */
export function lifelinkGranters(cards: Card[]): string[] {
  return cards.filter((c) => /(?:another target|target) creature (?:you control )?gains lifelink|creatures you control have lifelink/.test(c.text)).map((c) => c.name);
}
