import type { Card } from './types.ts';

/**
 * A synergy theme links cards that *provide* a resource to cards that *want* it.
 * Every matcher is a plain predicate over the card's normalized text, type line
 * or keyword list, so the same deck always yields the same tags.
 */
export type ThemeId =
  | 'tokens'
  | 'sac_fodder'
  | 'creature_dies'
  | 'etb'
  | 'counters'
  | 'instant_sorcery'
  | 'noncreature'
  | 'lifegain'
  | 'graveyard'
  | 'artifacts'
  | 'enchantments'
  | 'landfall'
  | 'draw'
  | 'creature_enters'
  | 'mana'
  | 'untap'
  | 'drain';

export interface Matcher {
  /** Human-readable reason shown in the UI, e.g. "creates creature tokens". */
  why: string;
  test: (card: Card) => boolean;
}

export interface Theme {
  id: ThemeId;
  label: string;
  color: string;
  /** Edge weight contributed by one provides→wants match of this theme. */
  weight: number;
  provides: Matcher[];
  wants: Matcher[];
}

const text = (why: string, re: RegExp): Matcher => ({ why, test: (c) => re.test(c.text) });
const type = (why: string, re: RegExp): Matcher => ({ why, test: (c) => re.test(c.typeLine) });
const keyword = (why: string, ...kws: string[]): Matcher => ({
  why,
  test: (c) => kws.some((k) => c.keywords.includes(k)),
});
const all = (why: string, ...ms: Matcher[]): Matcher => ({ why, test: (c) => ms.every((m) => m.test(c)) });
const not = (m: Matcher): Matcher => ({ why: `not ${m.why}`, test: (c) => !m.test(c) });

const isCreature = type('is a creature', /\bCreature\b/);
const notLand: Matcher = { why: 'is not a land', test: (c) => !/\bLand\b/.test(c.typeLine) };
const isLand = type('is a land', /\bLand\b/);

const BLINK = /exile (?:up to \w+ )?(?:another )?(?:target )?[^.]*creatures?[^.]*(?:\.|,)? (?:then )?return (?:it|them|that card|those cards|the exiled cards?)[^.]*to the battlefield/;
const COPY_CREATURE = /create[^.]*token that's a copy of[^.]*creature/;
const CREATURE_TOKENS = /create[^.]*creature tokens?|create[^.]*\d+\/\d+[^.]*tokens?/;
/** Splinter Twin-style auras: 'Enchanted creature has "{T}: Create a token that's a copy of this creature..."'. */
const GRANTED_COPY = /has "[^"]*create a token that's a copy of ~/;
const SELF_RECURSION = /return ~ from your graveyard to the battlefield|you may cast ~ from your graveyard/;

/**
 * An activated ability whose cost includes mana: a line whose text before the
 * colon contains a mana symbol, e.g. "{4}: Put a +1/+1 counter on ~."
 */
const MANA_ABILITY_COST = /^[^:\n"]*\{(?:\d+|x|[wubrgc](?:\/[wubrgp])?)\}[^:\n"]*:/m;

/** "Sacrifice a creature:"-style activated costs and additional costs. */
const SAC_COST = String.raw`(?:sacrifice (?:a|an|another|one or more|x|two|three)(?: other)? (?:nontoken )?(?:creatures?|artifacts?|permanents?)[^.:]*:|as an additional cost to cast (?:this spell|~), sacrifice (?:a|an|one or more) (?:creature|artifact|permanent))`;

export const THEMES: Theme[] = [
  {
    id: 'tokens',
    label: 'Tokens / go wide',
    color: '#4e79a7',
    weight: 2,
    provides: [
      text('creates creature tokens', CREATURE_TOKENS),
      text('copies creatures', COPY_CREATURE),
      keyword('has populate/amass/fabricate', 'populate', 'amass', 'fabricate', 'myriad', 'afterlife'),
    ],
    wants: [
      // Untyped anthems only; "Other Goblin creatures you control" is handled by tribal rules.
      text('pumps your team', /(?:^|[\n.,:]\s*|\bother )creatures you control get \+/m),
      text('scales with creature count', /for each creature you control|number of creatures you control|tokens you control/),
      keyword('has convoke', 'convoke'),
    ],
  },
  {
    id: 'sac_fodder',
    label: 'Sacrifice fodder',
    color: '#e15759',
    weight: 3,
    provides: [
      text('creates creature tokens', CREATURE_TOKENS),
      all('has a death trigger of its own', isCreature, text('', /when(?:ever)? ~ dies/)),
      text('can return from the graveyard', SELF_RECURSION),
      keyword('has afterlife/persist/undying', 'afterlife', 'persist', 'undying'),
    ],
    wants: [text('is a sacrifice outlet', new RegExp(SAC_COST))],
  },
  {
    id: 'creature_dies',
    label: 'Death triggers',
    color: '#b07aa1',
    weight: 3,
    provides: [
      text('is a sacrifice outlet', new RegExp(SAC_COST)),
      text('kills creatures en masse', /destroy all creatures|each player sacrifices|all creatures get -\d+\/-\d+/),
      text('makes opponents sacrifice', /each (?:other player|opponent) sacrifices/),
    ],
    wants: [
      text('pays off when creatures die', /whenever (?:~ or )?(?:a|another|one or more)(?: other)?(?: nontoken)? creatures?(?: or planeswalkers?)?(?: you control| an opponent controls)? (?:dies|die)\b|whenever [^.]*creature[^.]* is put into a graveyard from the battlefield/),
      text('pays off when you sacrifice', /whenever (?:you|a player) sacrifices?/),
      text('pays off when the equipped creature dies', /whenever equipped creature dies/),
    ],
  },
  {
    id: 'etb',
    label: 'Enter-the-battlefield',
    color: '#59a14f',
    weight: 3,
    provides: [
      text('blinks creatures', BLINK),
      text('copies creatures', COPY_CREATURE),
      text('grants a copy ability', GRANTED_COPY),
    ],
    wants: [all('has an enter-the-battlefield trigger', isCreature, text('', /when(?:ever)? ~ enters/))],
  },
  {
    id: 'counters',
    label: '+1/+1 counters',
    color: '#76b7b2',
    weight: 2,
    provides: [
      text('puts +1/+1 counters', /put[^.]*\+1\/\+1 counters?|enters? (?:the battlefield )?with[^.]*\+1\/\+1 counters?/),
      keyword('has a counter keyword', 'adapt', 'bolster', 'outlast', 'evolve', 'modular', 'mentor', 'training', 'support', 'graft', 'riot'),
    ],
    wants: [
      keyword('proliferates', 'proliferate'),
      text('rewards +1/+1 counters', /whenever one or more \+1\/\+1 counters|with (?:a|one or more) \+1\/\+1 counters? on (?:it|them)|if (?:one or more )?\+1\/\+1 counters? would be put|for each \+1\/\+1 counter|twice that many[^.]*counters/),
    ],
  },
  {
    id: 'instant_sorcery',
    label: 'Spellslinger',
    color: '#f28e2b',
    weight: 2,
    provides: [type('is an instant or sorcery', /\b(Instant|Sorcery)\b/)],
    wants: [
      keyword('has magecraft', 'magecraft'),
      text('triggers on instants and sorceries', /whenever you (?:cast|copy) (?:an|your first|your second)? ?instant or sorcery|instant and sorcery spells you cast|instant or sorcery card from your graveyard/),
    ],
  },
  {
    id: 'noncreature',
    label: 'Noncreature spells',
    color: '#ff9da7',
    weight: 1,
    provides: [all('is a noncreature spell', not(isCreature), not(isLand))],
    wants: [
      keyword('has prowess', 'prowess'),
      text('triggers on noncreature spells', /whenever you cast a noncreature spell/),
    ],
  },
  {
    id: 'lifegain',
    label: 'Lifegain',
    color: '#edc948',
    weight: 2,
    provides: [
      keyword('has lifelink', 'lifelink'),
      // The lookbehind skips trigger conditions such as "whenever you gain life".
      text('gains life', /(?<!whenever |if |would )\byou gain (?:\d+|x|that much|life equal)|gains? \d+ life/),
    ],
    wants: [text('pays off when you gain life', /whenever you gain life|if you would gain life|you've gained \d+ or more life|for each 1 life you gained/)],
  },
  {
    id: 'graveyard',
    label: 'Graveyard',
    color: '#9c755f',
    weight: 2,
    provides: [
      keyword('mills/surveils', 'mill', 'surveil', 'connive', 'dredge'),
      text('fills your graveyard', /\bmills? (?:\w+ )?cards?|\bdiscard (?:a|an|one|two|three|x|your hand|that card|up to)|put [^.]*into your graveyard/),
    ],
    wants: [
      keyword('casts from the graveyard', 'flashback', 'escape', 'delve', 'unearth', 'embalm', 'eternalize', 'disturb', 'jump-start', 'retrace'),
      // "Cast ~ from your graveyard" is self-recursion, not a payoff for filling the graveyard.
      text('uses cards in your graveyard', /(?<!~ )from your graveyard|cards? in (?:your|a) graveyard|threshold/),
    ],
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    color: '#bab0ac',
    weight: 2,
    provides: [
      type('is an artifact', /\bArtifact\b/),
      text('creates artifact tokens', /create[^.]*\b(?:treasure|food|clue|blood|map|powerstone|gold|artifact)\b[^.]*tokens?/),
      // Keyword actions whose tokens are only described in (stripped) reminder text.
      keyword('makes artifact tokens', 'investigate', 'fabricate', 'incubate', 'clue', 'food', 'treasure'),
    ],
    wants: [
      text('triggers on artifacts entering', /whenever (?:an|another|one or more)(?: nontoken)? artifacts?(?: you control)? enters?|whenever you cast an artifact spell/),
      text('scales with artifacts', /for each artifact you control|artifacts you control|three or more artifacts|affinity for artifacts/),
      text('sacrifices artifacts', /sacrifice (?:a|an|another) (?:artifact|food|treasure|clue)/),
      keyword('has improvise', 'improvise', 'metalcraft'),
    ],
  },
  {
    id: 'enchantments',
    label: 'Enchantments',
    color: '#d4a6c8',
    weight: 2,
    provides: [type('is an enchantment', /\bEnchantment\b/)],
    wants: [
      keyword('has constellation', 'constellation'),
      text('cares about enchantments', /whenever (?:an|another) enchantment(?: you control)? enters|whenever you cast an enchantment spell|for each enchantment you control|enchantments you control|enchantment spells? you cast/),
    ],
  },
  {
    id: 'landfall',
    label: 'Landfall',
    color: '#8cd17d',
    weight: 2,
    provides: [
      text('puts extra lands onto the battlefield', /search your library for [^.]*\b(?:lands?|plains|island|swamp|mountain|forest)\b[^.]*onto the battlefield|put (?:a|up to \w+) land cards?[^.]*onto the battlefield|play (?:an )?additional lands?|play lands from your graveyard/),
    ],
    wants: [
      keyword('has landfall', 'landfall'),
      text('triggers when lands enter', /whenever a land(?: you control)? enters/),
    ],
  },
  {
    id: 'draw',
    label: 'Card draw',
    color: '#86bcb6',
    weight: 1,
    provides: [text('draws cards', /\bdraws? (?:a|an|two|three|four|x|that many) cards?/)],
    wants: [text('triggers when you draw', /whenever you draw (?:a|your second)/)],
  },
  {
    id: 'creature_enters',
    label: 'Creatures entering',
    color: '#2f8f83',
    weight: 2,
    provides: [
      text('creates creature tokens', CREATURE_TOKENS),
      text('copies creatures', COPY_CREATURE),
      text('blinks creatures', BLINK),
      text('returns itself from the graveyard', SELF_RECURSION),
      text('reanimates creatures', /return [^.]*creature cards?[^.]*to the battlefield/),
    ],
    wants: [
      text('triggers when other creatures enter', /whenever (?:a|another|one or more)(?: other)?(?: nontoken)? creatures?(?: you control)? enters?(?: the battlefield)?(?: under your control)?/),
    ],
  },
  {
    id: 'mana',
    label: 'Mana',
    color: '#5f6b7a',
    weight: 2,
    provides: [
      // Lands are left out: every deck has them, so they would link to every mana sink.
      all('produces mana', notLand, text('', /\badd (?:\{|one mana|two mana|three mana|x mana|that much mana|an amount of)/)),
      text('creates Treasure', /create[^.]*\btreasure\b/),
    ],
    wants: [
      text('has a repeatable mana sink', MANA_ABILITY_COST),
      text('can be recast from the graveyard', /(?:cast|play) ~ from your graveyard/),
    ],
  },
  {
    id: 'untap',
    label: 'Untap',
    color: '#c46bd6',
    weight: 3,
    provides: [
      text('untaps permanents', /(?<!doesn't )\buntap (?:target|another target|up to \w+ target|that|all|each|it\b|those)/),
      text('blinks creatures (they return untapped)', BLINK),
    ],
    wants: [
      all('has a tap ability', notLand, text('', /^[^:\n"]*\{t\}[^:\n"]*:/m)),
      text('grants a tap ability', /(?:enchanted|equipped) creature has "[^"]*\{t\}[^"]*:/),
    ],
  },
  {
    id: 'drain',
    label: 'Life drain',
    color: '#8e2c48',
    weight: 2,
    provides: [
      text('makes opponents lose life', /(?:opponent|player)s? loses? (?:\d+|x|that much|half)[^.]* life|each opponent loses/),
      text('deals damage to players', /deals? (?:\d+|x|that much) damage to (?:any target|each opponent|target player|target opponent|that player|each player)/),
    ],
    wants: [text('pays off when opponents lose life', /whenever (?:an|a|one or more) (?:opponents?|players?) loses? life|whenever an opponent is dealt damage/)],
  },
];

export const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export interface CardTags {
  provides: Map<ThemeId, string[]>;
  wants: Map<ThemeId, string[]>;
}

export function tagCard(card: Card): CardTags {
  const provides = new Map<ThemeId, string[]>();
  const wants = new Map<ThemeId, string[]>();
  for (const theme of THEMES) {
    const p = theme.provides.filter((m) => m.test(card)).map((m) => m.why);
    const w = theme.wants.filter((m) => m.test(card)).map((m) => m.why);
    if (p.length) provides.set(theme.id, p);
    if (w.length) wants.set(theme.id, w);
  }
  return { provides, wants };
}
