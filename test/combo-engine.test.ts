import { describe, expect, it } from 'vitest';
import { findEngineCombos, payMana } from '../src/core/combo-engine.ts';
import { parseDecklist } from '../src/core/decklist.ts';
import { SAMPLE_COMMANDER_DECK } from '../src/core/sample-commander.ts';
import { card } from './helpers.ts';

const combosOf = (...names: string[]) => findEngineCombos(names.map((n) => card(n))).combos;
const sets = (...names: string[]) => combosOf(...names).map((c) => [...c.cards].sort());

describe('payMana', () => {
  const prod = (p: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C' | 'any', number>>) => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, any: 0, ...p });
  const cost = (c: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C' | 'generic', number>>) => ({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, generic: 0, ...c });
  it('pays colors with exact or any-color mana and generic with the rest', () => {
    expect(payMana(prod({ any: 1 }), cost({ B: 1 }))).toEqual(prod({}));
    expect(payMana(prod({ C: 2, any: 1 }), cost({ B: 1, generic: 1 }))).toEqual(prod({ C: 1 }));
  });
  it('refuses colorless mana for colored costs', () => {
    expect(payMana(prod({ C: 2 }), cost({ B: 1 }))).toBeNull();
  });
});

describe('findEngineCombos', () => {
  it('finds classic two-card infinites from rules alone', () => {
    expect(sets('Gravecrawler', 'Phyrexian Altar')).toEqual([['Gravecrawler', 'Phyrexian Altar']]);
    expect(sets('Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts')).toEqual([['Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts']]);
    expect(sets('Kiki-Jiki, Mirror Breaker', 'Restoration Angel')).toEqual([['Kiki-Jiki, Mirror Breaker', 'Restoration Angel']]);
    expect(sets('Kiki-Jiki, Mirror Breaker', 'Pestermite')).toEqual([['Kiki-Jiki, Mirror Breaker', 'Pestermite']]);
    expect(sets('Sanguine Bond', 'Exquisite Blood')).toEqual([['Exquisite Blood', 'Sanguine Bond']]);
  });

  it('explains what a combo produces and needs', () => {
    const [gc] = combosOf('Gravecrawler', 'Phyrexian Altar');
    expect(gc!.produces).toEqual(expect.arrayContaining(['Infinite death triggers', 'Infinite creature ETBs']));
    expect(gc!.prerequisites).toEqual(['Gravecrawler: as long as you control a zombie']);
    expect(gc!.netMana).toBe('none');
    expect(gc!.steps.map((s) => s.then)).toEqual(expect.arrayContaining(['Gravecrawler is sacrificed to Phyrexian Altar', 'its mana pays for Gravecrawler']));

    const [twin] = combosOf('Splinter Twin', 'Pestermite');
    expect(twin!.prerequisites).toEqual(['Splinter Twin is attached to Pestermite']);
    const [heliod] = combosOf('Heliod, Sun-Crowned', 'Walking Ballista');
    expect(heliod!.prerequisites).toEqual(['Heliod, Sun-Crowned gives Walking Ballista lifelink']);
    expect(heliod!.produces).toEqual(expect.arrayContaining(['Infinite damage', 'Infinite lifegain']));
  });

  it('checks mana colors: colorless mana cannot recast Gravecrawler alone', () => {
    expect(combosOf('Gravecrawler', "Ashnod's Altar")).toEqual([]);
  });

  it('adds a helper card when it closes the mana gap', () => {
    const [combo] = combosOf('Gravecrawler', "Ashnod's Altar", 'Pitiless Plunderer');
    expect(combo).toMatchObject({ helpers: ['Pitiless Plunderer'], netMana: '{C}{C}' });
    expect(combo!.produces).toContain('Infinite colorless mana');
  });

  it('requires every {T} to be untapped in the loop', () => {
    // Kiki-Jiki copying Mogg War Marshal makes tokens but never untaps Kiki-Jiki.
    expect(combosOf('Kiki-Jiki, Mirror Breaker', 'Mogg War Marshal')).toEqual([]);
    // Witch's Oven taps to sacrifice, so Cauldron Familiar loops only once per turn.
    expect(combosOf("Witch's Oven", 'Cauldron Familiar')).toEqual([]);
  });

  it('tracks tokens: Pawn of Ulamog only triggers on nontoken deaths', () => {
    expect(combosOf('Pawn of Ulamog', 'Viscera Seer')).toEqual([]);
  });

  it('uses mana from tokens that sacrifice themselves, but not twice', () => {
    // Skeleton dies to Phyrexian Altar ({any}), Pawn makes a Spawn that sacrifices itself ({C}): pays {1}{B}.
    expect(sets('Reassembling Skeleton', 'Phyrexian Altar', 'Pawn of Ulamog')).toEqual([['Pawn of Ulamog', 'Phyrexian Altar', 'Reassembling Skeleton']]);
    // Without a second mana source, the Spawn's {C} alone cannot recast Skeleton.
    expect(combosOf('Reassembling Skeleton', 'Pawn of Ulamog', 'Viscera Seer')).toEqual([]);
  });

  it('does not recur cards that did not die in the loop', () => {
    expect(combosOf('Reassembling Skeleton', 'Lotus Cobra')).toEqual([]);
  });

  it('lists payoffs, helper alternatives and warnings in a full deck', () => {
    const deck = parseDecklist(SAMPLE_COMMANDER_DECK).map((e) => card(e.name, e.quantity));
    const { combos, exhaustive } = findEngineCombos(deck);
    expect(exhaustive).toBe(true);
    const gc = combos.find((c) => c.cards.length === 2 && c.cards.includes('Gravecrawler') && c.cards.includes('Phyrexian Altar'))!;
    expect(gc.payoffs.map((p) => p.card)).toEqual(expect.arrayContaining(['Blood Artist', 'Zulaport Cutthroat', 'Pitiless Plunderer']));
    expect(gc.warnings.join(' ')).toContain('Midnight Reaper');
    const yawg = combos.find((c) => c.cards.includes('Yawgmoth, Thran Physician'))!;
    const lifeHelper = yawg.helpers[0]!;
    expect(yawg.helperAlternatives[lifeHelper]).toEqual(expect.arrayContaining(['Blood Artist', 'Zulaport Cutthroat']));
    // Minimal: no combo contains another combo's full card set.
    for (const c of combos) {
      for (const o of combos) if (o !== c && o.cards.length < c.cards.length) expect(o.cards.every((x) => c.cards.includes(x))).toBe(false);
    }
  });

  it('is deterministic', () => {
    const deck = parseDecklist(SAMPLE_COMMANDER_DECK).map((e) => card(e.name, e.quantity));
    expect(findEngineCombos([...deck].reverse())).toEqual(findEngineCombos(deck));
  });
});
