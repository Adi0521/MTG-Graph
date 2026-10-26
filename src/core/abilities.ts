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
  /** "nonland permanents": excludes lands. */
  nonland?: boolean;
  /** "with power 2 or less" (Reveillark). */
  maxPower?: number;
}

export type Output =
  /** fromLands: "untap up to five lands" (Peregrine Drake); assumes the lands make the colors needed. */
  /**
   * `variable`: the mana is per unit of something on the board ("for each Elf on the battlefield", Priest of
   * Titania); the engine finds how many units the loop needs and states it as a prerequisite.
   */
  | { type: 'mana'; mana: ManaProduction; fromLands?: boolean; variable?: string }
  /** Mana from a created token sacrificing itself (Eldrazi Spawn). Only usable if the token is not also sacrificed elsewhere. */
  | { type: 'tokenMana'; mana: ManaProduction }
  | { type: 'creature'; token: boolean; count: number; haste: boolean; artifact: boolean; pt: string | null }
  | { type: 'copy'; target: TargetSpec | 'host'; haste: boolean }
  | { type: 'recur' }
  /** Exile and return right away. 'self'/'host' = "exile ~, then return it" (Deadeye Navigator). */
  | { type: 'blink'; target: TargetSpec | 'self' | 'host'; count: number }
  /** "exile another target creature" with the return on leaving (Fiend Hunter). */
  | { type: 'exile'; target: TargetSpec }
  /** "return the exiled card to the battlefield" (Fiend Hunter leaving). */
  | { type: 'returnExiled' }
  /** "return target creature card from your graveyard to the battlefield" (Karmic Guide). */
  | { type: 'reanimate'; target: TargetSpec }
  /** 'self' = "untap ~"; `all` = "untap all nonland permanents you control". */
  | { type: 'untap'; target: TargetSpec | 'self' | 'host'; all: boolean }
  /** Nim Deathmantle: "return that card to the battlefield" (the creature that just died). */
  | { type: 'recurDied' }
  /** "return target artifact card from your graveyard to your hand" (lesserMv: Scrap Trawler). */
  | { type: 'toHand'; target: TargetSpec; lesserMv: boolean }
  /** amount 0 = "that much" (the amount of the triggering event). */
  | { type: 'lifegain'; amount: number }
  | { type: 'drain'; amount: number; damage: boolean }
  /** "put ~ on top of its owner's library" (Sensei's Divining Top). */
  | { type: 'toTop' }
  /** "return target spell or permanent to its owner's hand" (Venser). */
  | { type: 'bounce'; target: TargetSpec | 'self' }
  /** Living Death: every creature dies, then all creature cards from the graveyard return. */
  | { type: 'massReanimate' }
  /** "put a -1/-1 counter on target creature" (Blowfly Infestation, Yawgmoth). */
  | { type: 'minusCounter'; target: TargetSpec }
  /** Dualcaster Mage: "copy target instant or sorcery spell". */
  | { type: 'spellCopy' }
  /** 'host' = the creature an aura or soulbond grants this to. */
  /** each: "on each creature you control" (Archangel of Thune); amount 0 = "that many" (the life gained). */
  /** bolster: on the creature you control with the least toughness (Anafenza). */
  | { type: 'counter'; target: TargetSpec | 'self' | 'host'; each?: boolean; amount?: number; bolster?: boolean }
  | { type: 'draw'; amount: number }
  | { type: 'selfLifeLoss'; amount: number };

export type Trigger =
  /** hadMinus: "if it had a -1/-1 counter on it" (Blowfly Infestation). */
  | { type: 'death'; self: boolean; another: boolean; nontoken: boolean; what: 'creature' | 'artifact'; hadMinus?: boolean }
  | { type: 'selfEtb' }
  | { type: 'etb'; another: boolean; nontoken: boolean; pt: string | null }
  | { type: 'cast'; what: 'artifact' | 'instant or sorcery' | 'any' }
  /** "When ~ leaves the battlefield" */
  | { type: 'leave' }
  /** "whenever you put one or more -1/-1 counters on a creature" (Nest of Scarabs, Hapatra). */
  | { type: 'minus' }
  /** A copy of this instant or sorcery resolving (copied by Dualcaster Mage). */
  | { type: 'spellCopy' }
  | { type: 'lifegain' }
  | { type: 'drain' }
  | { type: 'draw' }
  /** "Whenever ~/enchanted creature deals damage to an opponent" (not combat-only). */
  | { type: 'damage'; source: 'self' | 'host' };

export interface Ability {
  id: string;
  card: string;
  /** The oracle line it came from, for display. */
  text: string;
  /**
   * activated: paid costs; triggered: fires on an event; recast: cast/return this card from the graveyard;
   * cast: cast this card from hand (added by the engine for cards something can return to hand).
   */
  kind: 'activated' | 'triggered' | 'recast' | 'cast';
  trigger?: Trigger;
  cost: {
    mana: ManaCost;
    tap: boolean;
    /** Sacrifice a permanent as a cost. "another" excludes this card. */
    sacrifice: null | { another: boolean; what: 'creature' | 'artifact' | 'permanent'; nontoken: boolean };
    life: number;
    removeCounter: boolean;
    /** Ghave: "remove a +1/+1 counter from a creature you control" (any creature, not just itself). */
    removeCounterFromAny?: boolean;
    /** Planeswalker loyalty ability: usable once per turn per object, so a loop must blink the planeswalker. */
    loyalty: boolean;
    /** "Put a -1/-1 counter on ~" (Devoted Druid): only repeatable if something prevents the counter. */
    minusCounter?: boolean;
  };
  /**
   * The ability acts through another creature (its "host"): an aura's enchanted creature,
   * an equipment's equipped creature, or a soulbond partner.
   */
  host: boolean;
  hostVia?: 'attached' | 'paired';
  /** Spell types this ability casts (a cast-from-hand ability, or Isochron Scepter casting its imprint). */
  casts?: string[];
  /** Another card this ability needs, e.g. the instant imprinted on Isochron Scepter. */
  with?: string;
  /** For cast abilities: where the card is cast from. */
  from?: 'hand' | 'library';
  outputs: Output[];
  oncePerTurn: boolean;
  /** "as long as ..." / "if you control ..." clauses, shown as prerequisites. */
  conditions: string[];
  /** The cost includes something not modeled (e.g. "Sacrifice a Food"), so the ability is never used in a loop. */
  unmodeledCost: boolean;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  x: 0,
  that: 1,
};
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

/** Mana that scales with the board: Priest of Titania, Marwyn, Selvala, Bloom Tender, Dockside Extortionist. */
function parseVariableMana(effect: string): Extract<Output, { type: 'mana' }> | null {
  const one = (sym: string) => {
    const m = emptyProduction();
    m[sym.toUpperCase() as Color]++;
    return m;
  };
  const perEach = /\badd \{([wubrgc])\} for each ([^.]+)/.exec(effect);
  if (perEach) return { type: 'mana', mana: one(perEach[1]!), variable: `for each ${perEach[2]}` };
  const amount = /\badd an amount of \{([wubrgc])\} equal to ([^.]+)/.exec(effect);
  if (amount) return { type: 'mana', mana: one(amount[1]!), variable: `equal to ${amount[2]}` };
  const x = /\badd x mana in any combination of colors, where x is ([^.]+)/.exec(effect);
  if (x) return { type: 'mana', mana: { ...emptyProduction(), any: 1 }, variable: x[1]! };
  if (/for each color among permanents you control, add one mana of that color/.test(effect)) {
    return { type: 'mana', mana: { ...emptyProduction(), any: 1 }, variable: 'one per color among your permanents' };
  }
  const treasures = /\bcreate (?:a|x) treasure tokens? for each ([^.]+)|\bcreate x treasure tokens, where x is ([^.]+)/.exec(effect);
  if (treasures) return { type: 'mana', mana: { ...emptyProduction(), any: 1 }, variable: treasures[1] ? `a Treasure for each ${treasures[1]}` : `X Treasures, X = ${treasures[2]}` };
  return null;
}

function parseTargetSpec(phrase: string, another = false): TargetSpec {
  const types = [...phrase.matchAll(/\b(permanent|creature|artifact|enchantment|land|planeswalker|instant|sorcery|card)s?\b/g)]
    .map((m) => m[1]!)
    .filter((t, _, all) => t !== 'card' || all.length === 1);
  return {
    types: types.length ? [...new Set(types)] : ['permanent'],
    nonland: /\bnonland\b/.test(phrase),
    maxPower: /with power (\d+) or less/.exec(phrase) ? Number(/with power (\d+) or less/.exec(phrase)![1]) : undefined,
    nonlegendary: /\bnonlegendary\b/.test(phrase),
    excluded: [...phrase.matchAll(/\bnon-(\w+)/g)].map((m) => m[1]!),
    another: another || /\banother\b/.test(phrase),
  };
}

const CAPITALIZE = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function matchesTarget(spec: TargetSpec, target: Card, source: string): boolean {
  if (spec.another && target.name === source) return false;
  if (spec.nonlegendary && /\bLegendary\b/.test(target.typeLine)) return false;
  if (spec.nonland && /\bLand\b/.test(target.typeLine)) return false;
  if (spec.maxPower !== undefined && (target.power ?? 0) > spec.maxPower) return false;
  for (const ex of spec.excluded) if (new RegExp(`\\b${CAPITALIZE(ex)}\\b`).test(target.typeLine)) return false;
  return spec.types.some((t) =>
    t === 'card'
      ? true
      : t === 'permanent'
        ? !/\b(Instant|Sorcery)\b/.test(target.typeLine)
        : new RegExp(`\\b${CAPITALIZE(t)}\\b`).test(target.typeLine),
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
  const variable = parseVariableMana(effect);
  const mana = variable ? null : parseManaProduction(effect);
  if (variable) outputs.push(variable);
  if (mana) outputs.push({ type: 'mana', mana });

  const copy =
    /create a token that's a copy of (target [^,.]*?creature[^,.]*?|~)(?:,|\.|$)/.exec(effect) ??
    /(target creatures? you control)\. for each of them, create a token that's a copy of that creature/.exec(effect);
  if (copy) {
    outputs.push({ type: 'copy', target: copy[1] === '~' || host ? 'host' : parseTargetSpec(copy[1]!), haste: /has haste|gains haste/.test(effect) });
  } else {
    const tokens = /create (a|an|one|two|three|four|five|x|\d+|that many) [^.]*?\b(\d+\/\d+)[^.]*?creature tokens?|create (a|an|one|two|three|four|five|x|\d+|that many) [^.]*?creature tokens?/.exec(effect);
    if (tokens) {
      outputs.push({
        type: 'creature',
        token: true,
        // "create a 3/3 ... token with deathtouch and a 3/3 ... token with lifelink" (Wurmcoil Engine) makes two.
        count: toNumber(tokens[1] ?? tokens[3]) + (/tokens? with [^.]* and a \d+\/\d+ [^.]*tokens?/.test(effect) ? 1 : 0),
        haste: /with haste|gains? haste/.test(effect),
        artifact: /artifact creature tokens?/.test(tokens[0]),
        pt: tokens[2] ?? null,
      });
    }
  }

  if (/return ~ from your graveyard to the battlefield/.test(effect)) outputs.push({ type: 'recur' });

  const blink = /exile (another target|target|up to one target|two target|up to two target) ([^.]*?(?:creature|permanent|artifact)s?[^.]*?)(?:,|\.)? (?:then )?return (?:it|them|that card|those cards|the exiled cards?)[^.]*to the battlefield/.exec(effect);
  // A delayed return ("... at the beginning of the next end step", Flickerwisp) happens once per turn, not in a loop.
  const delayed = blink && /^[^.]*\b(?:at the beginning of|end step)/.test(effect.slice(blink.index + blink[0].length));
  if (blink && !delayed) {
    outputs.push({ type: 'blink', target: parseTargetSpec(blink[2]!, blink[1] === 'another target'), count: /two/.test(blink[1]!) ? 2 : 1 });
  } else if (/exile ~, then return it to the battlefield/.test(effect)) {
    outputs.push({ type: 'blink', target: host ? 'host' : 'self', count: 1 });
  } else {
    const exile = /exile (another target|target) ([^.]*?creature[^.]*?)\./.exec(effect);
    if (exile && !delayed) outputs.push({ type: 'exile', target: parseTargetSpec(exile[2]!, exile[1] === 'another target') });
  }
  if (/return the exiled card to the battlefield/.test(effect)) outputs.push({ type: 'returnExiled' });
  const reanimate = /return (?:up to \w+ )?target ([^.]*?creature cards?[^.]*?) from your graveyard to the battlefield/.exec(effect);
  if (reanimate) outputs.push({ type: 'reanimate', target: parseTargetSpec(reanimate[1]!) });
  // Nim Deathmantle's "return that card to the battlefield" (not a blink's "exile ..., then return that card").
  if (/return that card to the battlefield/.test(effect) && !/\bexile\b/.test(effect)) outputs.push({ type: 'recurDied' });
  const landUntap = /untap up to (\w+) lands/.exec(effect);
  if (landUntap) outputs.push({ type: 'mana', mana: { ...emptyProduction(), any: toNumber(landUntap[1]) }, fromLands: true });

  // Sword of the Paruns / Pemmin's Aura: "untap equipped creature", "untap enchanted creature".
  const untapHost = /\b(?:tap or )?untap (?:equipped|enchanted) creature/.test(effect);
  const untapAll = /\buntap all (nonland )?permanents you control/.exec(effect);
  const untap = /\b(?:tap or )?untap (target [^.,]*?|another target [^.,]*?|that \w+|it|~)(?:[.,]|$| and)/.exec(effect.replace(/untap up to \w+ lands/, ''));
  if (untapHost) {
    outputs.push({ type: 'untap', target: 'host', all: false });
  } else if (untapAll) {
    outputs.push({ type: 'untap', target: { ...parseTargetSpec('permanent'), nonland: Boolean(untapAll[1]) }, all: true });
  } else if (untap && !/doesn't untap/.test(effect)) {
    let phrase = untap[1]!;
    // "gain control of target permanent ... Untap that permanent."
    if (/^(that|it)/.test(phrase)) phrase = /target ([^.,]*)/.exec(effect)?.[0] ?? 'permanent';
    outputs.push({ type: 'untap', target: phrase === '~' ? 'self' : parseTargetSpec(phrase), all: false });
  }

  // "return another target artifact card from your graveyard to your hand" (Myr Retriever),
  // "return to your hand target artifact card in your graveyard with lesser mana value" (Scrap Trawler).
  const toHand = /return (?:to your hand )?(another )?target ([^.]*?) (?:in|from) your graveyard( with lesser mana value)?(?: to your hand)?/.exec(effect);
  if (toHand && /\bhand\b/.test(toHand[0])) {
    outputs.push({ type: 'toHand', target: parseTargetSpec(toHand[2]!, Boolean(toHand[1])), lesserMv: Boolean(toHand[3]) });
  }

  const gain = /\byou gain (\d+|x|that much) life/.exec(effect);
  if (gain) outputs.push({ type: 'lifegain', amount: gain[1] === 'that much' ? 0 : toNumber(gain[1]) });

  const lose = /(?:target player|target opponent|each opponent|that player) loses? (\d+|x|that much) life/.exec(effect);
  if (lose) outputs.push({ type: 'drain', amount: lose[1] === 'that much' ? 0 : toNumber(lose[1]), damage: false });
  const damage = /deals? (\d+|x) damage to (?:any target|each opponent|target player|target opponent|any other target)/.exec(effect);
  if (damage) outputs.push({ type: 'drain', amount: toNumber(damage[1]), damage: true });
  // "deals damage equal to its power to any target" (Murderous Redcap): amount -1 means "its power".
  else if (/deals? damage equal to (?:its|~'s) power to any target/.test(effect)) outputs.push({ type: 'drain', amount: -1, damage: true });
  const selfDamage = /deals? (\d+) damage to you|you lose (\d+) life/.exec(effect);
  if (selfDamage) outputs.push({ type: 'selfLifeLoss', amount: toNumber(selfDamage[1] ?? selfDamage[2]) });

  const counter = /put (a|one|two|three|that many|\w+) \+1\/\+1 counters? on (~|target [^.]*?|each (?:other )?creature you control)(?:\.|,| and|$)/.exec(effect);
  if (counter) {
    // Inside a granted ability, "~" ("this creature") is the host, not the card granting it.
    const target = counter[2] === '~' ? (host ? 'host' : 'self') : parseTargetSpec(counter[2]!.replace(/^each /, ''));
    outputs.push({ type: 'counter', target, each: counter[2]!.startsWith('each'), amount: counter[1] === 'that many' ? 0 : toNumber(counter[1]) });
  }

  if (/put ~ on top of its owner's library/.test(effect)) outputs.push({ type: 'toTop' });
  const minus = /put (?:a|one) -1\/-1 counter on (?:up to one )?(target creature[^.]*?)(?:\.|,| and|$)/.exec(effect);
  if (minus) outputs.push({ type: 'minusCounter', target: parseTargetSpec(minus[1]!) });
  if (/\bcopy target instant or sorcery spell\b/.test(effect)) outputs.push({ type: 'spellCopy' });
  const bolster = /\bbolster (\d+|\w+)/.exec(effect);
  if (bolster) outputs.push({ type: 'counter', target: parseTargetSpec('creature'), bolster: true, amount: toNumber(bolster[1]) });
  // "return target creature", "return another creature you control", "return a nonland permanent you control" (Ancestral Statue).
  const bounce = /return (target|another|a) ((?:spell or )?(?:nonland )?(?:permanent|creature|artifact))(?: you control)? to its owner's hand/.exec(effect);
  if (bounce) outputs.push({ type: 'bounce', target: parseTargetSpec(bounce[2]!.replace('spell or ', ''), bounce[1] === 'another') });
  else if (/return ~ to its owner's hand/.test(effect)) outputs.push({ type: 'bounce', target: 'self' });
  if (/sacrifices? all creatures they control, then puts? all cards they exiled this way onto the battlefield/.test(effect)) outputs.push({ type: 'massReanimate' });

  const draw = /\bdraws? (a|two|three|x|\d+) cards?/.exec(effect);
  if (draw && !/opponent draws|each player draws/.test(effect)) outputs.push({ type: 'draw', amount: toNumber(draw[1]) });

  return outputs;
}

function parseTrigger(condition: string, granted: boolean): Trigger | null {
  if (/^whenever you draw a card/.test(condition)) return { type: 'draw' };
  if (/^when ~ leaves the battlefield/.test(condition)) return { type: 'leave' };
  if (/^whenever (?:you put one or more -1\/-1 counters on a creature|a -1\/-1 counter is put on a creature)/.test(condition)) return { type: 'minus' };
  const cast = /^whenever (?:you cast|a player casts) (an artifact|an instant or sorcery|a) spell/.exec(condition);
  if (cast) return { type: 'cast', what: cast[1] === 'an artifact' ? 'artifact' : cast[1] === 'a' ? 'any' : 'instant or sorcery' };
  const artifactDeath = /^whenever (~ dies or |~ or )?(another |an |one or more )?(nontoken )?artifacts?(?: you control)? (?:is|are) put into a graveyard from the battlefield/.exec(condition);
  if (artifactDeath) {
    return { type: 'death', self: false, another: !artifactDeath[1] && artifactDeath[2] === 'another ', nontoken: Boolean(artifactDeath[3]), what: 'artifact' };
  }
  const damage = /^whenever (~|enchanted creature|equipped creature) deals damage to an opponent/.exec(condition);
  if (damage) return { type: 'damage', source: damage[1] === '~' && !granted ? 'self' : 'host' };
  const death = /^when(?:ever)? (~ or )?(another |a |one or more )?(other )?(nontoken )?creatures?(?: or planeswalkers?)?(?: you control)? (?:dies|die)\b/.exec(condition);
  if (death) {
    // "~ or another creature" includes the card itself, so it is not an "another" restriction.
    const another = !death[1] && Boolean(death[2]?.startsWith('another') || death[3]);
    return { type: 'death', self: false, another, nontoken: Boolean(death[4]), what: 'creature' };
  }
  const creatureToGraveyard = /^whenever (a|another) (nontoken )?creature is put into your graveyard from the battlefield/.exec(condition);
  if (creatureToGraveyard) return { type: 'death', self: false, another: creatureToGraveyard[1] === 'another', nontoken: Boolean(creatureToGraveyard[2]), what: 'creature' };
  if (/^whenever you sacrifice (?:a|another) (?:creature|permanent)/.test(condition)) {
    return { type: 'death', self: false, another: false, nontoken: false, what: 'creature' };
  }
  if (/^when(?:ever)? ~ (?:enters|dies)/.test(condition)) {
    return /^when(?:ever)? ~ enters/.test(condition)
      ? { type: 'selfEtb' }
      : { type: 'death', self: true, another: false, nontoken: false, what: 'creature' };
  }
  const etb = /^whenever (another |a |one or more )(other )?(nontoken )?(\d+\/\d+ )?creatures?(?: tokens?)?(?: you control)? enters?/.exec(condition);
  if (etb) return { type: 'etb', another: etb[1]!.startsWith('another') || Boolean(etb[2]), nontoken: Boolean(etb[3]), pt: etb[4]?.trim() ?? null };
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

/** Wordings that limit an ability to once per turn. */
const ONCE_PER_TURN =
  /only once each turn|activate only once|for the first time (?:during )?each (?:of your )?turns?|activate only during your turn and only once|no more than once each turn|the (?:first|second|third) time this ability has resolved this turn/;

/**
 * Conditions the engine cannot track. An ability whose text has one of these is never used as a loop
 * step: ignoring the condition would invent combos (the discovery audit found each of these).
 */
const UNTRACKED_CONDITIONS: [RegExp, string][] = [
  [/\b(?:you may )?sacrifice (?:this enchantment|this artifact|~)\. if you do\b/, 'sacrifices itself (one-shot)'],
  // A delayed *return* (Avacyn, Angel of Horror). Delayed cleanup ("sacrifice it at the beginning of the next end
  // step" on Kiki-Jiki's token) is fine.
  [/return[^.]*at the beginning of (?:the )?next (?:end step|upkeep|turn)|at the beginning of (?:the )?next (?:end step|upkeep)[^.]*return/, 'delayed until a later step'],
  [/\bif (?:it|~) was (?:kicked|cast|bargained)|\bif you cast it\b|\bif it entered from your hand\b|\bif ~ entered\b/, 'needs it to have been cast'],
  [/\bif there are (?:\w+) or more\b|\b(?:\w+) or more [a-z]+ counters on\b/, 'needs a counter threshold'],
  [/target card (?:from|in) a graveyard|target [a-z ]*card from an opponent's graveyard/, 'uses up cards in graveyards'],
  [/\battacking creature\b|\bblocking creature\b|\bduring combat\b/, 'only in combat'],
  [/\bremove (?:that many|\w+) [a-z]+ counters from (?:this creature|this artifact|this enchantment|~)/, 'uses up its own counters'],
  [/\bif it had a \+1\/\+1 counter on it\b/, 'needs a counter on the dying creature'],
  [/\bif (?:a|an) [a-z]+ was sacrificed this way\b/, 'depends on what was sacrificed'],
  // ("~" is not a word character, so these end with (?!\w) rather than \b.)
  [/\b(?:convert|transform) (?:it|~|this creature)(?!\w)/, 'transforms after one use'],
  [/\bexiled with (?:this artifact|this creature|this enchantment|~)(?!\w)/, 'uses up cards it exiled'],
];

export function untrackedCondition(text: string): string | null {
  for (const [re, why] of UNTRACKED_CONDITIONS) if (re.test(text)) return why;
  return null;
}

function makeAbility(card: Card, line: number, text: string, partial: Partial<Ability> & Pick<Ability, 'kind' | 'outputs'>): Ability {
  return {
    id: `${card.name}#${line}`,
    card: card.name,
    text,
    cost: { mana: emptyCost(), tap: false, sacrifice: null, life: 0, removeCounter: false, loyalty: false },
    host: false,
    oncePerTurn: ONCE_PER_TURN.test(text.toLowerCase()),
    unmodeledCost: false,
    conditions: conditionsOf(text.toLowerCase()),
    ...partial,
  };
}

/** Mark abilities whose text has a condition the engine can't track as unusable in loops. */
function guard(ability: Ability | null, lineText: string): Ability | null {
  if (ability && untrackedCondition(lineText)) ability.unmodeledCost = true;
  return ability;
}

function parseActivated(card: Card, lineNo: number, display: string, line: string, host: boolean): Ability | null {
  const split = costSplit(line);
  if (split === -1) return null;
  const costText = line.slice(0, split);
  const effect = line.slice(split + 1).trim();
  // Loyalty costs like "-2" are modeled; bracketed and keyword costs are not.
  const loyalty = /^[+\-−]?\d+$/.test(costText.trim());
  if (/^\[/.test(costText.trim())) return null;
  const outputs = parseOutputs(effect, host);
  const sac = /sacrifice (another|a|an) (nontoken )?(creature|artifact|permanent)\b/.exec(costText);
  // Whatever is left after removing the cost parts we understand must be empty.
  const leftover = costText
    .replace(/\{[^}]+\}/g, '')
    .replace(/sacrifice (?:another|a|an) (?:nontoken )?(?:creature|artifact|permanent)\b/, '')
    .replace(/pay \d+ life/, '')
    .replace(/remove (?:a|one) \+1\/\+1 counter from (?:~|a creature you control)/, '')
    .replace(/^[+\-−]?\d+$/, '')
    .replace(/put a -1\/-1 counter on ~/, '')
    .replace(/[,\s]|\band\b/g, '');
  const ability = makeAbility(card, lineNo, display, {
    kind: /return ~ from your graveyard to the battlefield/.test(effect) ? 'recast' : 'activated',
    host,
    outputs,
    cost: {
      mana: parseManaCost(costText),
      tap: /\{t\}/.test(costText),
      sacrifice: sac ? { another: sac[1] === 'another', what: sac[3] as 'creature' | 'artifact' | 'permanent', nontoken: Boolean(sac[2]) } : null,
      life: toNumber(/pay (\d+) life/.exec(costText)?.[1], 0),
      removeCounter: /remove (?:a|one) \+1\/\+1 counter from (?:~|a creature you control)/.test(costText),
      removeCounterFromAny: /remove (?:a|one) \+1\/\+1 counter from a creature you control/.test(costText),
      loyalty,
      minusCounter: /put a -1\/-1 counter on ~/.test(costText),
    },
  });
  ability.unmodeledCost = leftover.length > 0;
  // {Q} (the untap symbol, Umbral Mantle): activating untaps the creature that has the ability.
  if (/\{q\}/.test(costText) && !ability.outputs.some((o) => o.type === 'untap')) {
    ability.outputs.push({ type: 'untap', target: host ? 'host' : 'self', all: false });
  }
  // "untap equipped/enchanted creature" acts through the creature it is attached to.
  if (ability.outputs.some((o) => o.type === 'untap' && o.target === 'host')) {
    ability.host = true;
    ability.hostVia = 'attached';
  }
  if (ability.kind === 'recast') {
    ability.outputs = ability.outputs.filter((o) => o.type !== 'recur');
    return ability;
  }
  return ability.outputs.length || ability.cost.sacrifice ? ability : null;
}

function parseTriggered(card: Card, lineNo: number, display: string, line: string, granted: boolean): Ability | null {
  const comma = line.indexOf(',');
  const condition = comma === -1 ? line : line.slice(0, comma);
  const trigger = parseTrigger(condition, granted);
  if (!trigger) return null;
  let effect = comma === -1 ? '' : line.slice(comma + 1);
  // Blowfly Infestation: "whenever a creature dies, if it had a -1/-1 counter on it, ..." is tracked (the
  // simulator knows counters), unlike the +1/+1 version.
  if (/^\s*if it had a -1\/-1 counter on it,/.test(effect) && trigger.type === 'death') {
    trigger.hadMinus = true;
    effect = effect.replace(/^\s*if it had a -1\/-1 counter on it,/, '');
  }
  // "you may pay {4}. If you do, return that card..." (Nim Deathmantle): the payment is the trigger's cost.
  const payment = /you may pay ((?:\{[^}]+\})+)\. if you do, (.*)/.exec(effect);
  if (/you may pay/.test(effect) && !payment) return null;
  if (payment) effect = payment[2]!;
  // Any other intervening "if ..." condition ("if an Aura you controlled was attached to it", "if it was kicked")
  // is about state the engine does not track, so the trigger is not used in loops.
  const intervening = /^\s*if\b/.test(effect);
  const host = granted || (trigger.type === 'damage' && trigger.source === 'host');
  const outputs = parseOutputs(effect, host);
  if (!outputs.length) return null;
  const ability = makeAbility(card, lineNo, display, { kind: 'triggered', trigger, outputs, host, hostVia: host && !granted ? 'attached' : undefined });
  if (payment) ability.cost.mana = parseManaCost(payment[1]!);
  if (intervening) ability.unmodeledCost = true;
  return ability;
}

const parsedCache = new WeakMap<Card, Ability[]>();

/** Parse the loop-relevant abilities of a card. Ability ids are "<card>#<oracle line>". Cached per card object. */
export function parseAbilities(card: Card): Ability[] {
  const cached = parsedCache.get(card);
  if (cached) return cached;
  const result = parseAbilitiesUncached(card);
  parsedCache.set(card, result);
  return result;
}

function parseAbilitiesUncached(card: Card): Ability[] {
  const abilities: Ability[] = [];
  const lines = card.text.split('\n');
  const displayLines = card.oracleText.split('\n');
  // Modal abilities ("When ~ enters, choose one — • Untap target permanent you control. • ..."): each mode becomes
  // its own line with the same trigger, so a loop can use whichever mode it needs.
  for (let i = 0; i < lines.length; i++) {
    const head = /^(.*?),? choose one(?: or both| or more)? —$/.exec(lines[i]!);
    if (!head) continue;
    const modes: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j]!.startsWith('• '); j++) modes.push(lines[j]!.slice(2));
    if (!modes.length) continue;
    lines.splice(i, modes.length + 1, ...modes.map((m) => `${head[1]}, ${m}`));
    displayLines.splice(i, modes.length + 1, ...modes.map((m) => `${(displayLines[i] ?? '').replace(/,? choose one.*$/i, '')}, ${m}`));
    i += modes.length - 1;
  }

  lines.forEach((rawLine, i) => {
    // Ability words ("Vivid —", "Landfall —") are labels, not costs.
    const line = rawLine.replace(/^[a-z' ]+ — (?=\{|when|whenever|at )/, '');
    const display = (displayLines[i] ?? rawLine).replace(/ ?\([^)]*\)/g, '');

    // Granted abilities: 'Enchanted creature has "{T}: ..."', soulbond's 'each of those creatures has "..."'.
    const granted = /(enchanted creature|equipped creature|each of those creatures) has "([^"]+)"/.exec(line);
    if (granted) {
      const hostVia = granted[1] === 'each of those creatures' ? 'paired' : 'attached';
      const inner = granted[2]!;
      const a = guard(/^when/.test(inner) ? parseTriggered(card, i, display, inner, true) : parseActivated(card, i, display, inner, true), inner);
      // The pairing/attachment itself is reported from hostVia, so drop "as long as ~ is paired ..." here.
      const conditions = conditionsOf(line.slice(0, granted.index)).filter((c) => !/paired|attached|enchant/.test(c));
      if (a) abilities.push({ ...a, hostVia, conditions });
      return;
    }

    const recast = /you may cast ~ from your graveyard/.exec(line);
    if (recast) {
      abilities.push(
        makeAbility(card, i, display, {
          kind: 'recast',
          outputs: [],
          cost: { mana: parseManaCost(card.manaCost), tap: false, sacrifice: null, life: 0, removeCounter: false, loyalty: false },
        }),
      );
      return;
    }

    if (/^when|^whenever/.test(line)) {
      const a = guard(parseTriggered(card, i, display, line, false), line);
      if (a) abilities.push(a);
      return;
    }

    const activated = guard(parseActivated(card, i, display, line, false), line);
    if (activated) abilities.push(activated);
  });
  return abilities;
}

/** "Artifact spells you cast cost {1} less to cast." */
export interface CostReducer {
  card: string;
  /** Spell type reduced, "any", or "chosen" (Cloud Key: whichever type the loop casts). */
  what: string;
  amount: number;
  /** Animar: the reduction is X, a board-dependent amount the loop chooses (described here). */
  variable?: string;
  /** Aluren: only spells with this mana value or less (and then they are free). */
  maxMv?: number;
}

export function costReducers(card: Card): CostReducer[] {
  const out: CostReducer[] = [...card.text.matchAll(/(?:^|\n)(artifact |creature |noncreature |instant and sorcery )?spells (?:you cast )?cost \{(\d+)\} less to cast(?! for each)/g)].map((m) => ({
    card: card.name,
    what: m[1]?.trim() ?? 'any',
    amount: Number(m[2]),
  }));
  // Cloud Key / Semblance Anvil: a chosen or imprinted type. Any type can be chosen, so it applies to all, with a prerequisite.
  const chosen = /spells you cast (?:of the chosen type|that share a card type with the exiled card) cost \{(\d+)\} less to cast/.exec(card.text);
  if (chosen) out.push({ card: card.name, what: 'chosen', amount: Number(chosen[1]) });
  // Animar: "{1} less to cast for each +1/+1 counter on ~": scales with the board, like variable mana.
  const perCounter = /(creature )?spells you cast cost \{1\} less to cast for each \+1\/\+1 counter on ~/.exec(card.text);
  if (perCounter) out.push({ card: card.name, what: perCounter[1] ? 'creature' : 'any', amount: 0, variable: `${card.name} has at least X +1/+1 counters` });
  // Aluren: "cast creature spells with mana value 3 or less without paying their mana cost".
  const free = /cast creature spells with mana value (\d+) or less without paying their mana cost/.exec(card.text);
  if (free) out.push({ card: card.name, what: 'creature', amount: 99, maxMv: Number(free[1]) });
  return out;
}

/** Vizier of Remedies: "-1/-1 counters ... that many minus one are put on it instead", so one-counter costs become free. */
export function preventsMinusCounter(card: Card): boolean {
  return /if one or more -1\/-1 counters would be put on a creature you control, that many -1\/-1 counters minus one/.test(card.text);
}

/** Mystic Forge: "You may cast artifact spells and colorless spells from the top of your library." */
export function castFromTopEnabler(card: Card): { card: string; what: 'artifact or colorless' | 'any' } | null {
  if (/you may cast artifact spells and colorless spells from the top of your library/.test(card.text)) return { card: card.name, what: 'artifact or colorless' };
  if (/you may (?:cast spells|play lands and cast spells) from the top of your library/.test(card.text)) return { card: card.name, what: 'any' };
  return null;
}

/** Panharmonicon: an artifact or creature entering makes your triggered abilities trigger an additional time. */
export function etbDoubler(card: Card): boolean {
  return /if an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time/.test(card.text);
}

/** Urza, Lord High Artificer: "Tap an untapped artifact you control: Add {U}." */
export function artifactTapper(card: Card): { card: string; mana: ManaProduction } | null {
  const m = /(?:^|\n)tap an untapped artifact you control: add \{([wubrgc])\}/.exec(card.text);
  if (!m) return null;
  const mana = emptyProduction();
  mana[m[1]!.toUpperCase() as Color]++;
  return { card: card.name, mana };
}

/** Melira: "Creatures you control can't have -1/-1 counters put on them." */
export function blocksMinusCounters(card: Card): boolean {
  return /creatures you control can't have -1\/-1 counters put on them/.test(card.text);
}

/** Solemnity: "Counters can't be put on artifacts, creatures, enchantments, or lands." */
export function blocksCounters(card: Card): boolean {
  return /counters can't be put on artifacts, creatures/.test(card.text);
}

/** Teysa Karlov: a creature dying makes your triggered abilities trigger an additional time. */
export function deathDoubler(card: Card): boolean {
  return /if a creature dying causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time/.test(card.text);
}

/** High Tide: "whenever a player taps an Island for mana, that player adds an additional {U}". */
export function landAmplifier(card: Card): boolean {
  return /whenever a player taps an island for mana, that player adds an additional \{u\}/.test(card.text);
}

/** Kinnan, Bonder Prodigy: "whenever you tap a nonland permanent for mana, add one additional mana". */
export function manaAmplifier(card: Card): boolean {
  return /whenever you tap a nonland permanent for mana, add one (?:additional )?mana/.test(card.text);
}

/** Power Artifact: "Enchanted artifact's activated abilities cost {2} less ... can't reduce ... to less than one mana." */
export function activationReducer(card: Card): { card: string; amount: number } | null {
  const m = /enchanted artifact's activated abilities cost \{(\d+)\} less to activate/.exec(card.text);
  return m ? { card: card.name, amount: Number(m[1]) } : null;
}

/** Rings of Brighthearth: "Whenever you activate an ability, if it isn't a mana ability, you may pay {2}. If you do, copy that ability." */
export function abilityCopier(card: Card): { card: string; cost: number } | null {
  const m = /whenever you activate an ability, if it isn't a mana ability, you may pay \{(\d+)\}\. if you do, copy that ability/.exec(card.text);
  return m ? { card: card.name, cost: Number(m[1]) } : null;
}

/**
 * Isochron Scepter: one ability per instant it could imprint, which casts a copy of that instant.
 * The copy's effect comes from the instant's own text.
 */
export function imprintAbilities(scepter: Card, instants: Card[]): Ability[] {
  const imprint = /imprint — when ~ enters, you may exile an instant card with mana value (\d+) or less from your hand/.exec(scepter.text);
  const activate = /(?:^|\n)([^:\n]*\{t\}[^:\n]*): you may copy the exiled card\. if you do, you may cast the copy without paying its mana cost/.exec(scepter.text);
  if (!imprint || !activate) return [];
  const eligible = instants.filter((i) => /\bInstant\b/.test(i.typeLine) && i.cmc <= Number(imprint[1]));
  if (eligible.length === 0) return [];
  const cost = { mana: parseManaCost(activate[1]!), tap: true, sacrifice: null, life: 0, removeCounter: false, loyalty: false };
  // Casting any imprinted instant is itself a spell cast (Paradox Engine untaps on it), whatever the instant does.
  const anyInstant = makeAbility(scepter, 1000, `${activate[0].trim()} (copying any imprinted instant)`, {
    kind: 'activated',
    outputs: [],
    cost,
    casts: ['instant'],
    conditions: [`An instant with mana value ${imprint[1]} or less (e.g. ${eligible.map((i) => i.name).join(', ')}) is imprinted on ${scepter.name}`],
    id: `${scepter.name}#imprint:any`,
  });
  return [anyInstant, ...eligible
    .map((instant) =>
      makeAbility(scepter, 1000, `${activate[0].trim()} (copying ${instant.name})`, {
        kind: 'activated',
        outputs: parseOutputs(instant.text, false),
        cost,
        casts: ['instant'],
        with: instant.name,
        conditions: [`${instant.name} is imprinted on ${scepter.name}`],
        id: `${scepter.name}#imprint:${instant.name}`,
      }),
    )];
}

/** The implicit "cast this card from hand" (or from the top of the library) ability, for cards a loop can get there. */
export function castFromHand(card: Card, from: 'hand' | 'library' = 'hand', enabler?: string): Ability {
  const types = card.typeLine.toLowerCase().split(/[\s—/]+/).filter((t) => ['artifact', 'creature', 'enchantment', 'instant', 'sorcery', 'planeswalker'].includes(t));
  const isSpellOnly = /\b(Instant|Sorcery)\b/.test(card.typeLine);
  return makeAbility(card, 2000, from === 'library' ? `Cast ${card.name} from the top of your library (${enabler})` : `Cast ${card.name}`, {
    kind: 'cast',
    outputs: isSpellOnly ? parseOutputs(card.text, false) : [],
    cost: { mana: parseManaCost(card.manaCost), tap: false, sacrifice: null, life: 0, removeCounter: false, loyalty: false },
    casts: types,
    id: from === 'library' ? `${card.name}#castTop` : `${card.name}#cast`,
    from,
    with: enabler,
  });
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

/** A copy of an instant or sorcery resolving (Dualcaster Mage copying Twinflame or Ghostly Flicker). */
export function copiedSpellAbility(card: Card): Ability | null {
  const outputs = parseOutputs(card.text, false);
  if (!outputs.length) return null;
  return makeAbility(card, 3000, `A copy of ${card.name} resolves`, {
    kind: 'triggered',
    trigger: { type: 'spellCopy' },
    outputs,
    id: `${card.name}#copied`,
    conditions: [`Cast ${card.name}, then copy it while it is on the stack`],
  });
}

/** Cards in the deck that can give another creature lifelink, by name. */
export function lifelinkGranters(cards: Card[]): string[] {
  return cards.filter((c) => /(?:another target|target) creature (?:you control )?gains lifelink|creatures you control have lifelink/.test(c.text)).map((c) => c.name);
}
