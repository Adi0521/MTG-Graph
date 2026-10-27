import type { EngineCombo } from './combo-engine.ts';
import { emptyProduction } from './abilities.ts';
import type { Card } from './types.ts';

/**
 * One-shot mill finishers: combinations that empty an opponent's library at once rather than by looping
 * (Bruvac + Traumatize, Phenax + Consuming Aberration + Fleet Swallower, Painter's Servant + Grindstone).
 *
 * Each card contributes a mill effect or a modifier, read from its rules text. A set of up to three cards is
 * played out against every opponent library size from 1 to MAX_LIBRARY (graveyard starting empty), trying
 * every order of its mill effects, each used once. It is a finisher if the library always ends empty (or, for
 * "half, rounded down" effects, with at most one card left, which is noted). Deterministic, like the rest.
 */

type MillAmount =
  /** "mills half their library, rounded up/down" */
  | { kind: 'half'; round: 'up' | 'down' }
  /** Phenax: "{T}: each opponent mills X cards, where X is this creature's toughness" (on a creature of the set). */
  | { kind: 'toughness' }
  /** Grindstone: mills two, again as long as both share a color (forever, with Painter's Servant). */
  | { kind: 'repeatColor' }
  | { kind: 'fixed'; n: number };

interface MillSource {
  card: string;
  text: string;
  amount: MillAmount;
  conditions: string[];
}

interface Pieces {
  sources: MillSource[];
  /** Bruvac the Grandiloquent: opponents mill twice as many. */
  doubler: boolean;
  /** Painter's Servant: every card shares the chosen color. */
  colorizer: boolean;
  /** Consuming Aberration, Sewer Nemesis: toughness equal to the cards in an opponent's graveyard. */
  graveyardToughness: boolean;
}

const MAX_LIBRARY = 120;
const NUMBER: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function piecesOf(card: Card): Pieces {
  const t = card.text;
  const sources: MillSource[] = [];
  const line = (re: RegExp) => card.oracleText.split('\n').find((l) => re.test(l.toLowerCase().replace(new RegExp(card.name.toLowerCase(), 'g'), '~'))) ?? card.oracleText;
  const half = /(?:target player|target opponent|each opponent) mills half their library, rounded (up|down)/.exec(t);
  if (half) {
    const conditions: string[] = [];
    if (/if (?:this spell|~) was kicked, instead/.test(t)) conditions.push(`${card.name} is kicked`);
    if (/^whenever ~ attacks/m.test(t)) conditions.push(`${card.name} attacks`);
    sources.push({ card: card.name, text: line(/half their library/), amount: { kind: 'half', round: half[1] as 'up' | 'down' }, conditions });
  }
  if (/creatures you control have "\{t\}: (?:target player|each opponent) mills x cards, where x is (?:this creature's|~'s) toughness/.test(t)) {
    sources.push({ card: card.name, text: line(/toughness/), amount: { kind: 'toughness' }, conditions: [] });
  }
  // Older and current Oracle wordings of Grindstone.
  if (/target player mills two cards\. (?:repeat this process as long as two cards milled this way share a color|if two cards that share a color were milled this way, repeat this process)/.test(t)) {
    sources.push({ card: card.name, text: line(/repeat this process/), amount: { kind: 'repeatColor' }, conditions: [] });
  }
  const fixed = /(?:target player|target opponent|each opponent) mills (a|one|two|three|four|five|six|seven|eight|nine|ten|\d+) cards?/.exec(t);
  if (fixed && !half && !sources.some((s) => s.amount.kind === 'repeatColor')) {
    sources.push({ card: card.name, text: line(/mills/), amount: { kind: 'fixed', n: NUMBER[fixed[1]!] ?? Number(fixed[1]) }, conditions: [] });
  }
  return {
    sources,
    doubler: /if an opponent would mill one or more cards, they mill twice that many cards instead/.test(t),
    colorizer: /all cards that aren't on the battlefield, spells, and permanents are the chosen color/.test(t),
    graveyardToughness:
      /\bCreature\b/.test(card.typeLine) && /power and toughness are each equal to the number of cards in (?:your opponents'|the chosen player's|target opponent's) graveyards?/.test(t),
  };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));
}

/** Cards left in a library of `size` after the set's mill effects in the best order, or null if some effect cannot be used. */
function leftAfter(size: number, sources: MillSource[], set: Map<string, Pieces>): number | null {
  const all = [...set.values()];
  const doubler = all.some((p) => p.doubler);
  const colorizer = all.some((p) => p.colorizer);
  const toughnessCreature = all.some((p) => p.graveyardToughness);
  let best: number | null = null;
  for (const order of permutations(sources)) {
    let library = size;
    let graveyard = 0;
    let usable = true;
    for (const s of order) {
      let n: number;
      if (s.amount.kind === 'half') n = s.amount.round === 'up' ? Math.ceil(library / 2) : Math.floor(library / 2);
      else if (s.amount.kind === 'toughness') {
        if (!toughnessCreature) usable = false;
        n = graveyard;
      } else if (s.amount.kind === 'repeatColor') n = colorizer ? library : 2;
      else n = s.amount.n;
      if (doubler) n *= 2;
      n = Math.min(n, library);
      library -= n;
      graveyard += n;
    }
    if (usable && (best === null || library < best)) best = library;
  }
  return best;
}

/** Does this set finish every library? Returns the worst leftover (0 or 1), or null. */
function finishes(set: Map<string, Pieces>): number | null {
  const sources = [...set.values()].flatMap((p) => p.sources);
  if (!sources.length) return null;
  let worst = 0;
  for (let size = 1; size <= MAX_LIBRARY; size++) {
    const left = leftAfter(size, sources, set);
    if (left === null || left > 1) return null;
    worst = Math.max(worst, left);
  }
  return worst;
}

export function findMillFinishers(cards: Card[]): EngineCombo[] {
  const relevant = [...cards]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => [c, piecesOf(c)] as const)
    .filter(([, p]) => p.sources.length || p.doubler || p.colorizer || p.graveyardToughness);
  const found: Map<string, Pieces>[] = [];
  const n = relevant.length;
  const sets: (readonly [Card, Pieces])[][] = [];
  for (let a = 0; a < n; a++) {
    sets.push([relevant[a]!]);
    for (let b = a + 1; b < n; b++) {
      sets.push([relevant[a]!, relevant[b]!]);
      for (let c = b + 1; c < n; c++) sets.push([relevant[a]!, relevant[b]!, relevant[c]!]);
    }
  }
  const results: EngineCombo[] = [];
  for (const entries of sets) {
    const set = new Map(entries.map(([c, p]) => [c.name, p]));
    // Minimal only: no smaller finisher inside it, and a single card is a deck's own win condition, not a combo.
    if (set.size < 2 || found.some((f) => [...f.keys()].every((k) => set.has(k)))) continue;
    const worst = finishes(set);
    if (worst === null) continue;
    // Every card must matter.
    if ([...set.keys()].some((k) => finishes(new Map([...set].filter(([name]) => name !== k))) !== null)) continue;
    found.push(set);
    const sources = [...set.values()].flatMap((p) => p.sources);
    const modifiers = [...set.entries()].filter(([, p]) => p.doubler || p.colorizer || p.graveyardToughness);
    const prerequisites = sources.flatMap((s) => s.conditions);
    if (sources.some((s) => s.amount.kind === 'toughness')) prerequisites.push('the creature with the granted ability is untapped and not summoning sick');
    for (const [name, p] of set) if (p.graveyardToughness && cards.find((c) => c.name === name)!.text.includes("the chosen player's graveyard")) prerequisites.push(`${name} chose that opponent`);
    if (worst > 0) prerequisites.push('an opponent with an odd number of cards in their library keeps one');
    results.push({
      cards: [...set.keys()],
      loop: [...set.keys()],
      helpers: [],
      helperAlternatives: {},
      steps: [
        ...modifiers.map(([name, p]) => ({
          card: name,
          ability: p.doubler ? 'Opponents mill twice as many cards' : p.colorizer ? 'Every card is the chosen color' : "Toughness equals the cards in an opponent's graveyard",
          then: 'this changes how much the next effects mill',
        })),
        ...sources.map((s) => ({ card: s.card, ability: s.text, then: 'the opponent mills' })),
      ],
      produces: ['Opponents mill their whole library'],
      prerequisites,
      // An odd library keeping one card depends on the opponent; the rest (kicker, attacking) is setup.
      conditions: prerequisites.filter((p) => p.startsWith('an opponent with an odd number')),
      payoffs: [],
      warnings: [],
      netMana: 'none',
      verification: {
        startup: [],
        perLoop: { mana: emptyProduction(), life: 0, opponentLife: 0, deaths: 0, etbs: 0, draws: 0, tokens: 0, casts: 0, combats: 0, milled: MAX_LIBRARY, selfMilled: 0 },
      },
    });
  }
  return results;
}
