import { describe, expect, it } from 'vitest';
import { matchesTarget, parseAbilities, parseManaCost } from '../src/core/abilities.ts';
import { toCard } from '../src/core/card.ts';
import { card, FIXTURES } from './helpers.ts';

const abilities = (name: string) => parseAbilities(card(name));

describe('parseManaCost', () => {
  it('counts generic and colored symbols', () => {
    expect(parseManaCost('{2}{B}{B}')).toMatchObject({ generic: 2, B: 2, W: 0 });
    expect(parseManaCost('{x}{t}{c}')).toMatchObject({ generic: 0, C: 1 });
  });
});

describe('parseAbilities', () => {
  it('parses sacrifice outlets and their mana', () => {
    const [phyrexian] = abilities('Phyrexian Altar');
    expect(phyrexian).toMatchObject({ kind: 'activated', cost: { sacrifice: { another: false }, tap: false } });
    expect(phyrexian!.outputs).toEqual([{ type: 'mana', mana: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, any: 1 } }]);
    expect(abilities("Ashnod's Altar")[0]!.outputs[0]).toMatchObject({ type: 'mana', mana: { C: 2 } });
  });

  it('parses graveyard recursion with its mana cost and condition', () => {
    const recast = abilities('Gravecrawler').find((a) => a.kind === 'recast')!;
    expect(recast.cost.mana).toMatchObject({ B: 1, generic: 0 });
    expect(recast.conditions).toEqual(['as long as you control a zombie']);
    expect(abilities('Reassembling Skeleton')[0]).toMatchObject({ kind: 'recast', cost: { mana: { B: 1, generic: 1 } } });
  });

  it('marks costs it does not understand instead of treating them as free', () => {
    // "Sacrifice a Food" is modeled now (paid from the Food a loop makes); an unknown cost is not.
    const familiar = abilities('Cauldron Familiar').find((a) => a.kind === 'recast')!;
    expect(familiar.cost.food).toBe(1);
    expect(familiar.unmodeledCost).toBe(false);
    const odd = toCard({ ...FIXTURES['Blood Artist']!, name: 'Test Clue', oracle_text: 'Sacrifice a Clue: Return this card from your graveyard to the battlefield.' });
    expect(parseAbilities(odd)[0]!.unmodeledCost).toBe(true);
  });

  it('parses copy, untap and blink effects with their targets', () => {
    const kiki = abilities('Kiki-Jiki, Mirror Breaker')[0]!;
    expect(kiki.cost.tap).toBe(true);
    expect(kiki.outputs[0]).toMatchObject({ type: 'copy', haste: true, target: { types: ['creature'], nonlegendary: true } });
    expect(abilities('Zealous Conscripts')[0]!.outputs).toEqual([
      { type: 'untap', target: { types: ['permanent'], nonlegendary: false, excluded: [], another: false, nonland: false }, all: false },
    ]);
    expect(abilities('Restoration Angel')[0]!.outputs[0]).toMatchObject({ type: 'blink', target: { types: ['creature'], excluded: ['angel'] } });
  });

  it('parses abilities granted by auras as host abilities', () => {
    expect(abilities('Splinter Twin')[0]).toMatchObject({ host: true, cost: { tap: true }, outputs: [{ type: 'copy', target: 'host' }] });
  });

  it('keeps token self-sacrifice mana separate from the card\'s own mana', () => {
    // Pawn's Eldrazi Spawn can sacrifice itself for {C}; that is not mana Pawn makes directly.
    expect(abilities('Pawn of Ulamog')[0]!.outputs).toEqual([
      { type: 'tokenMana', mana: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 1, any: 0 } },
      { type: 'creature', token: true, count: 1, haste: false, artifact: false, pt: '0/1', subtype: 'spawn' },
    ]);
  });

  it('parses death triggers including the nontoken restriction', () => {
    expect(abilities('Blood Artist')[0]!.trigger).toEqual({ type: 'death', self: false, another: false, nontoken: false, what: 'creature' });
    expect(abilities('Grim Haruspex')[0]!.trigger).toMatchObject({ type: 'death', nontoken: true, another: true });
  });
});

describe('matchesTarget', () => {
  it('honors nonlegendary and non-<type> restrictions', () => {
    const spec = { types: ['creature'], nonlegendary: true, excluded: ['angel'], another: false };
    expect(matchesTarget(spec, card('Zealous Conscripts'), 'x')).toBe(true);
    expect(matchesTarget(spec, card('Krenko, Mob Boss'), 'x')).toBe(false);
    expect(matchesTarget(spec, card('Restoration Angel'), 'x')).toBe(false);
  });
});

describe('intervening "if" conditions', () => {
  it('refuses untracked conditions but tracks Blowfly Infestation\'s -1/-1 check', () => {
    const fake = toCard({ ...FIXTURES['Blood Artist']!, name: 'Test Evangel', oracle_text: 'Whenever a creature dies, if an Aura you controlled was attached to it, you gain 1 life.' });
    expect(parseAbilities(fake).every((a) => a.unmodeledCost)).toBe(true);
    const [blowfly] = abilities('Blowfly Infestation');
    expect(blowfly!.trigger).toMatchObject({ type: 'death', hadMinus: true });
    expect(blowfly!.unmodeledCost).toBeFalsy();
  });
});
