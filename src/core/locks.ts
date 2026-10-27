import type { EngineCombo } from './combo-engine.ts';
import { emptyProduction } from './abilities.ts';
import type { Card } from './types.ts';

/**
 * Turn-by-turn locks: a protective land that would normally fall away, kept on the battlefield every turn
 * (Glacial Chasm + Crucible of Worlds + Azusa). Unlike a combo loop, which repeats within a turn, a lock repeats
 * once per turn, so it is checked here with its own small turn model.
 *
 * The lock piece is a land with cumulative upkeep paid in life and a lock effect ("Prevent all damage that would
 * be dealt to you"), usually with "When ~ enters, sacrifice a land". Other cards contribute what they do with
 * lands: play them from the graveyard, extra land drops, an upkeep land sacrifice (The Gitrog Monster), land
 * sacrifice for life (Zuran Orb), lands back to hand each turn (Life from the Loam, dredged every draw step).
 *
 * Every plan for one or two turns is tried (each upkeep and main-phase choice). A set is a lock if some plan keeps
 * the lock piece on the battlefield at the end of every turn and comes back to where it started without losing
 * lands or life. Deterministic: choices are tried in a fixed order.
 */

interface Features {
  card: string;
  recursion: boolean;
  extraDrops: number;
  /** The Gitrog Monster: "At the beginning of your upkeep, sacrifice ~ unless you sacrifice a land." */
  upkeepLandSacrifice: boolean;
  /** Zuran Orb: "Sacrifice a land: You gain 2 life." */
  landForLife: number;
  /** Life from the Loam: lands from the graveyard to hand, reusable through dredge. */
  returnsLands: number;
  lock: null | { cumulativeLife: number; etbSacrifice: boolean; effect: string };
}

const NUMBER: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3 };

function featuresOf(card: Card): Features {
  const t = card.text;
  const drops = /you may play (an|one|two|three) additional lands? on each of your turns/.exec(t);
  const life = /sacrifice a land: you gain (\d+) life/.exec(t);
  const loam = /return up to (\w+) target land cards from your graveyard to your hand/.exec(t);
  const upkeep = /cumulative upkeep—pay (\d+) life/.exec(t);
  const effect = /prevent all damage that would be dealt to you/.exec(t);
  return {
    card: card.name,
    recursion: /you may play lands from your graveyard/.test(t),
    extraDrops: drops ? (NUMBER[drops[1]!] ?? 1) : 0,
    upkeepLandSacrifice: /at the beginning of your upkeep, sacrifice ~ unless you sacrifice a land/.test(t),
    landForLife: life ? Number(life[1]) : 0,
    // Only reusable every turn if it dredges back to hand.
    returnsLands: loam && /^dredge \d+$/m.test(t) ? (NUMBER[loam[1]!] ?? Number(loam[1])) : 0,
    lock:
      /\bLand\b/.test(card.typeLine) && upkeep && effect
        ? { cumulativeLife: Number(upkeep[1]), etbSacrifice: /when ~ enters, sacrifice a land/.test(t), effect: 'Prevent all damage that would be dealt to you' }
        : null,
  };
}

type Zone = 'battlefield' | 'graveyard' | 'hand';

interface State {
  lock: Zone;
  age: number;
  /** Your other lands, by zone. */
  lands: number;
  graveyard: number;
  hand: number;
  life: number;
  returner: 'graveyard' | 'hand';
  log: string[];
}

interface Rules {
  lock: string;
  cumulativeLife: number;
  etbSacrifice: boolean;
  recursion: string | null;
  drops: number;
  gitrog: string | null;
  orb: { card: string; life: number } | null;
  returner: { card: string; count: number } | null;
}

/** Every way to play out one turn from `s`, ending with the lock piece on the battlefield. */
function turns(s: State, r: Rules): State[] {
  const step = (x: State, entry: string, change: Partial<State>): State => ({ ...x, ...change, log: [...x.log, entry] });
  // Upkeep: The Gitrog Monster's land sacrifice, then cumulative upkeep.
  let states = [s];
  if (r.gitrog) {
    states = states.flatMap((x) => [
      ...(x.lock === 'battlefield' ? [step(x, `Upkeep: sacrifice ${r.lock} to ${r.gitrog}`, { lock: 'graveyard', age: 0, graveyard: x.graveyard })] : []),
      ...(x.lands > 0 ? [step(x, `Upkeep: sacrifice another land to ${r.gitrog}`, { lands: x.lands - 1, graveyard: x.graveyard + 1 })] : []),
    ]);
  }
  states = states.flatMap((x) => {
    if (x.lock !== 'battlefield') return [x];
    const cost = r.cumulativeLife * (x.age + 1);
    return [
      step(x, `Upkeep: pay ${cost} life for ${r.lock}'s cumulative upkeep`, { age: x.age + 1, life: x.life - cost }),
      step(x, `Upkeep: don't pay ${r.lock}'s cumulative upkeep, so it is sacrificed`, { lock: 'graveyard', age: 0 }),
      ...(r.orb ? [step(x, `Upkeep: in response, sacrifice ${r.lock} to ${r.orb.card} (gain ${r.orb.life} life)`, { lock: 'graveyard', age: 0, life: x.life + r.orb.life })] : []),
    ];
  });
  // Draw step: dredge Life from the Loam back instead of drawing.
  if (r.returner) {
    states = states.flatMap((x) => (x.returner === 'graveyard' ? [x, step(x, `Draw: dredge ${r.returner!.card} back to your hand`, { returner: 'hand' })] : [x]));
    // Main phase: cast it, returning the lock piece first, then other lands.
    states = states.flatMap((x) => {
      if (x.returner !== 'hand') return [x];
      const lockBack = x.lock === 'graveyard' ? 1 : 0;
      const others = Math.min(r.returner!.count - lockBack, x.graveyard);
      return [
        x,
        step(x, `Main: cast ${r.returner!.card}, returning ${[lockBack ? r.lock : '', others ? `${others} other land${others > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ')} to your hand`, {
          lock: lockBack ? 'hand' : x.lock,
          graveyard: x.graveyard - others,
          hand: x.hand + others,
          returner: 'graveyard',
        }),
      ];
    });
  }
  // Land drops.
  const play = (x: State, left: number): State[] => {
    const out: State[] = [x];
    if (left === 0) return out;
    const enterLock = (y: State, from: string): State[] => {
      const entered = step(y, `Play ${r.lock} from your ${from}`, { lock: 'battlefield', age: 0 });
      if (!r.etbSacrifice) return [entered];
      // "When ~ enters, sacrifice a land": another land (sacrificing itself would end the lock).
      return entered.lands > 0 ? [step(entered, `${r.lock} enters: sacrifice another land`, { lands: entered.lands - 1, graveyard: entered.graveyard + 1 })] : [];
    };
    if (x.lock === 'hand') for (const y of enterLock({ ...x, lock: 'battlefield' }, 'hand')) out.push(...play(y, left - 1));
    if (x.lock === 'graveyard' && r.recursion) for (const y of enterLock({ ...x, lock: 'battlefield' }, `graveyard (${r.recursion})`)) out.push(...play(y, left - 1));
    if (x.hand > 0) out.push(...play(step(x, 'Play a land from your hand', { hand: x.hand - 1, lands: x.lands + 1 }), left - 1));
    if (x.graveyard > 0 && r.recursion) out.push(...play(step(x, `Play a land from your graveyard (${r.recursion})`, { graveyard: x.graveyard - 1, lands: x.lands + 1 }), left - 1));
    return out;
  };
  return states.flatMap((x) => play(x, r.drops)).filter((x) => x.lock === 'battlefield');
}

/** A plan of one or two turns that returns to its starting state (or better), or null. */
function findCycle(r: Rules): string[][] | null {
  for (const lands of [1, 2]) {
    for (const graveyard of [0, 1]) {
      const start: State = { lock: 'battlefield', age: 0, lands, graveyard, hand: 0, life: 0, returner: 'graveyard', log: [] };
      for (const period of [1, 2]) {
        let frontier = [start];
        const logs: string[][] = [];
        for (let t = 0; t < period; t++) {
          frontier = frontier.flatMap((x) => turns({ ...x, log: [] }, r).map((y) => ({ ...y, log: [...x.log, `--- turn ${t + 1}`, ...y.log] })));
        }
        const back = frontier.find((x) => x.age === start.age && x.lands >= lands && x.life >= 0 && x.returner === start.returner);
        if (back) {
          for (const line of back.log) {
            if (line.startsWith('---')) logs.push([]);
            else logs.at(-1)!.push(line);
          }
          return logs;
        }
      }
    }
  }
  return null;
}

function rulesFor(set: Features[]): Rules | null {
  const lock = set.find((f) => f.lock);
  if (!lock) return null;
  const recursion = set.find((f) => f.recursion);
  const gitrog = set.find((f) => f.upkeepLandSacrifice);
  const orb = set.find((f) => f.landForLife > 0);
  const returner = set.find((f) => f.returnsLands > 0);
  return {
    lock: lock.card,
    cumulativeLife: lock.lock!.cumulativeLife,
    etbSacrifice: lock.lock!.etbSacrifice,
    recursion: recursion?.card ?? null,
    drops: 1 + set.reduce((n, f) => n + f.extraDrops, 0),
    gitrog: gitrog?.card ?? null,
    orb: orb ? { card: orb.card, life: orb.landForLife } : null,
    returner: returner ? { card: returner.card, count: returner.returnsLands } : null,
  };
}

export function findLocks(cards: Card[]): EngineCombo[] {
  const relevant = [...cards]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(featuresOf)
    .filter((f) => f.lock || f.recursion || f.extraDrops || f.upkeepLandSacrifice || f.landForLife || f.returnsLands);
  if (!relevant.some((f) => f.lock)) return [];
  const works = (set: Features[]) => {
    const rules = rulesFor(set);
    return rules ? findCycle(rules) : null;
  };
  const found: Features[][] = [];
  const results: EngineCombo[] = [];
  const n = relevant.length;
  const sets: Features[][] = [];
  for (let a = 0; a < n; a++) {
    sets.push([relevant[a]!]);
    for (let b = a + 1; b < n; b++) {
      sets.push([relevant[a]!, relevant[b]!]);
      for (let c = b + 1; c < n; c++) sets.push([relevant[a]!, relevant[b]!, relevant[c]!]);
    }
  }
  sets.sort((x, y) => x.length - y.length);
  for (const set of sets) {
    if (found.some((f) => f.every((x) => set.includes(x)))) continue;
    const plan = works(set);
    if (!plan) continue;
    // Every card must matter.
    if (set.some((x) => works(set.filter((y) => y !== x)) !== null)) continue;
    found.push(set);
    const rules = rulesFor(set)!;
    const lockCard = cards.find((c) => c.name === rules.lock)!;
    const prerequisites = ['You control another land'];
    if (rules.returner) prerequisites.push(`${rules.returner.card} is in your graveyard, and you can pay for it each turn`);
    if (plan.length > 1 || plan.flat().some((l) => l.includes('pay ') && l.includes('life'))) prerequisites.push(`Your life total is above ${rules.cumulativeLife}`);
    results.push({
      cards: set.map((f) => f.card),
      loop: set.map((f) => f.card),
      helpers: [],
      helperAlternatives: {},
      steps: plan.flatMap((turn, t) => turn.map((line) => ({ card: plan.length > 1 ? `Turn ${t + 1}` : 'Each turn', ability: line, then: '' }))),
      produces: [featuresOf(lockCard).lock!.effect, 'Lock'],
      prerequisites,
      conditions: [],
      payoffs: [],
      warnings: [],
      netMana: 'none',
      verification: {
        startup: [],
        perLoop: { mana: emptyProduction(), life: 0, opponentLife: 0, deaths: 0, etbs: 0, draws: 0, tokens: 0, casts: 0, combats: 0, milled: 0, selfMilled: 0 },
      },
    });
  }
  return results;
}
