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
}

export type Output =
  /** fromLands: "untap up to five lands" (Peregrine Drake); assumes the lands make the colors needed. */
  | { type: 'mana'; mana: ManaProduction; fromLands?: boolean }
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
  | { type: 'untap'; target: TargetSpec | 'self'; all: boolean }
  /** "return target artifact card from your graveyard to your hand" (lesserMv: Scrap Trawler). */
  | { type: 'toHand'; target: TargetSpec; lesserMv: boolean }
  /** amount 0 = "that much" (the amount of the triggering event). */
  | { type: 'lifegain'; amount: number }
  | { type: 'drain'; amount: number; damage: boolean }
  /** "put ~ on top of its owner's library" (Sensei's Divining Top). */
  | { type: 'toTop' }
  /** "return target spell or permanent to its owner's hand" (Venser). */
  | { type: 'bounce'; target: TargetSpec }
  /** Living Death: every creature dies, then all creature cards from the graveyard return. */
  | { type: 'massReanimate' }
  /** 'host' = the creature an aura or soulbond grants this to. */
  /** each: "on each creature you control" (Archangel of Thune); amount 0 = "that many" (the life gained). */
  | { type: 'counter'; target: TargetSpec | 'self' | 'host'; each?: boolean; amount?: number }
  | { type: 'draw'; amount: number }
  | { type: 'selfLifeLoss'; amount: number };

export type Trigger =
  | { type: 'death'; self: boolean; another: boolean; nontoken: boolean; what: 'creature' | 'artifact' }
  | { type: 'selfEtb' }
  | { type: 'etb'; another: boolean; nontoken: boolean; pt: string | null }
  | { type: 'cast'; what: 'artifact' | 'instant or sorcery' | 'any' }
  /** "When ~ leaves the battlefield" */
  | { type: 'leave' }
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
  const types = [...phrase.matchAll(/\b(permanent|creature|artifact|enchantment|land|planeswalker|instant|sorcery|card)s?\b/g)]
    .map((m) => m[1]!)
    .filter((t, _, all) => t !== 'card' || all.length === 1);
  return {
    types: types.length ? [...new Set(types)] : ['permanent'],
    nonland: /\bnonland\b/.test(phrase),
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
  const mana = parseManaProduction(effect);
  if (mana) outputs.push({ type: 'mana', mana });

  const copy = /create a token that's a copy of (target [^,.]*?creature[^,.]*?|~)(?:,|\.|$)/.exec(effect);
  if (copy) {
    outputs.push({ type: 'copy', target: copy[1] === '~' || host ? 'host' : parseTargetSpec(copy[1]!), haste: /has haste|gains haste/.test(effect) });
  } else {
    const tokens = /create (a|an|one|two|three|four|five|x|\d+) [^.]*?\b(\d+\/\d+)[^.]*?creature tokens?|create (a|an|one|two|three|four|five|x|\d+) [^.]*?creature tokens?/.exec(effect);
    if (tokens) {
      outputs.push({
        type: 'creature',
        token: true,
        count: toNumber(tokens[1] ?? tokens[3]),
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
  const reanimate = /return target ([^.]*?creature card) from your graveyard to the battlefield/.exec(effect);
  if (reanimate) outputs.push({ type: 'reanimate', target: parseTargetSpec(reanimate[1]!) });
  const landUntap = /untap up to (\w+) lands/.exec(effect);
  if (landUntap) outputs.push({ type: 'mana', mana: { ...emptyProduction(), any: toNumber(landUntap[1]) }, fromLands: true });

  const untapAll = /\buntap all (nonland )?permanents you control/.exec(effect);
  const untap = /\b(?:tap or )?untap (target [^.,]*?|another target [^.,]*?|that \w+|it|~)(?:[.,]|$| and)/.exec(effect.replace(/untap up to \w+ lands/, ''));
  if (untapAll) {
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
  const selfDamage = /deals? (\d+) damage to you|you lose (\d+) life/.exec(effect);
  if (selfDamage) outputs.push({ type: 'selfLifeLoss', amount: toNumber(selfDamage[1] ?? selfDamage[2]) });

  const counter = /put (a|one|two|three|that many|\w+) \+1\/\+1 counters? on (~|target [^.]*?|each (?:other )?creature you control)(?:\.|,| and|$)/.exec(effect);
  if (counter) {
    // Inside a granted ability, "~" ("this creature") is the host, not the card granting it.
    const target = counter[2] === '~' ? (host ? 'host' : 'self') : parseTargetSpec(counter[2]!.replace(/^each /, ''));
    outputs.push({ type: 'counter', target, each: counter[2]!.startsWith('each'), amount: counter[1] === 'that many' ? 0 : toNumber(counter[1]) });
  }

  if (/put ~ on top of its owner's library/.test(effect)) outputs.push({ type: 'toTop' });
  const bounce = /return target ((?:spell or )?(?:nonland )?(?:permanent|creature|artifact)) to its owner's hand/.exec(effect);
  if (bounce) outputs.push({ type: 'bounce', target: parseTargetSpec(bounce[1]!.replace('spell or ', '')) });
  if (/sacrifices? all creatures they control, then puts? all cards they exiled this way onto the battlefield/.test(effect)) outputs.push({ type: 'massReanimate' });

  const draw = /\bdraws? (a|two|three|x|\d+) cards?/.exec(effect);
  if (draw && !/opponent draws|each player draws/.test(effect)) outputs.push({ type: 'draw', amount: toNumber(draw[1]) });

  return outputs;
}

function parseTrigger(condition: string, granted: boolean): Trigger | null {
  if (/^whenever you draw a card/.test(condition)) return { type: 'draw' };
  if (/^when ~ leaves the battlefield/.test(condition)) return { type: 'leave' };
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

function makeAbility(card: Card, line: number, text: string, partial: Partial<Ability> & Pick<Ability, 'kind' | 'outputs'>): Ability {
  return {
    id: `${card.name}#${line}`,
    card: card.name,
    text,
    cost: { mana: emptyCost(), tap: false, sacrifice: null, life: 0, removeCounter: false, loyalty: false },
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
    .replace(/remove (?:a|one) \+1\/\+1 counter from ~/, '')
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
      removeCounter: /remove (?:a|one) \+1\/\+1 counter from ~/.test(costText),
      loyalty,
      minusCounter: /put a -1\/-1 counter on ~/.test(costText),
    },
  });
  ability.unmodeledCost = leftover.length > 0;
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
  const effect = comma === -1 ? '' : line.slice(comma + 1);
  // "you may pay {1}. If you do, ..." costs mana per trigger; treat it as unmodeled.
  if (/you may pay \{/.test(effect)) return null;
  const host = granted || (trigger.type === 'damage' && trigger.source === 'host');
  const outputs = parseOutputs(effect, host);
  if (!outputs.length) return null;
  return makeAbility(card, lineNo, display, { kind: 'triggered', trigger, outputs, host, hostVia: host && !granted ? 'attached' : undefined });
}

/** Parse the loop-relevant abilities of a card. Ability ids are "<card>#<oracle line>". */
export function parseAbilities(card: Card): Ability[] {
  const abilities: Ability[] = [];
  const lines = card.text.split('\n');
  const displayLines = card.oracleText.split('\n');

  lines.forEach((line, i) => {
    const display = (displayLines[i] ?? line).replace(/ ?\([^)]*\)/g, '');

    // Granted abilities: 'Enchanted creature has "{T}: ..."', soulbond's 'each of those creatures has "..."'.
    const granted = /(enchanted creature|equipped creature|each of those creatures) has "([^"]+)"/.exec(line);
    if (granted) {
      const hostVia = granted[1] === 'each of those creatures' ? 'paired' : 'attached';
      const inner = granted[2]!;
      const a = /^when/.test(inner) ? parseTriggered(card, i, display, inner, true) : parseActivated(card, i, display, inner, true);
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
      const a = parseTriggered(card, i, display, line, false);
      if (a) abilities.push(a);
      return;
    }

    const activated = parseActivated(card, i, display, line, false);
    if (activated) abilities.push(activated);
  });
  return abilities;
}

/** "Artifact spells you cast cost {1} less to cast." */
export interface CostReducer {
  card: string;
  /** Spell type reduced, or "any". */
  what: string;
  amount: number;
}

export function costReducers(card: Card): CostReducer[] {
  return [...card.text.matchAll(/(?:^|\n)(artifact |creature |noncreature |instant and sorcery )?spells you cast cost \{(\d+)\} less to cast/g)].map((m) => ({
    card: card.name,
    what: m[1]?.trim() ?? 'any',
    amount: Number(m[2]),
  }));
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

/** Cards in the deck that can give another creature lifelink, by name. */
export function lifelinkGranters(cards: Card[]): string[] {
  return cards.filter((c) => /(?:another target|target) creature (?:you control )?gains lifelink|creatures you control have lifelink/.test(c.text)).map((c) => c.name);
}
