import { describe, expect, it } from 'vitest';
import { findEngineCombos } from '../src/core/combo-engine.ts';
import { card } from './helpers.ts';

const run = (...names: string[]) => findEngineCombos(names.map((n) => card(n)));
const only = (...names: string[]) => {
  const { combos } = run(...names);
  expect(combos).toHaveLength(1);
  return combos[0]!;
};

describe('loop simulator', () => {
  it('reports exact per-loop results and what is needed to start', () => {
    const gc = only('Gravecrawler', 'Phyrexian Altar');
    expect(gc.verification.perLoop).toMatchObject({ deaths: 1, etbs: 1, life: 0, opponentLife: 0 });
    expect(gc.netMana).toBe('none');

    const basalt = only('Basalt Monolith', 'Power Artifact');
    expect(basalt.verification.perLoop.mana).toMatchObject({ C: 2 });
  });

  it('counts tokens that pile up (Kiki-Jiki copies)', () => {
    const kiki = only('Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts');
    expect(kiki.verification.perLoop.tokens).toBe(1);
  });

  describe('undying (Mikaeus, the Unhallowed)', () => {
    it('loops Walking Ballista, which must start with a counter', () => {
      const combo = only('Mikaeus, the Unhallowed', 'Walking Ballista');
      expect(combo.verification.startup).toEqual(['Walking Ballista cast with X ≥ 1']);
      // Ballista pings itself to death each time, so no damage reaches the opponent.
      expect(combo.verification.perLoop).toMatchObject({ deaths: 1, etbs: 1, opponentLife: 0 });
      expect(combo.produces).not.toContain('Infinite damage');
      expect(combo.produces).not.toContain('Infinite sacrifice triggers');
    });

    it('loops Triskelion for exactly 2 damage per loop', () => {
      // Returns with 3 + 1 counters as a 2/2 base: 2 pings to the opponent, 2 to finish itself.
      const combo = only('Mikaeus, the Unhallowed', 'Triskelion');
      expect(combo.verification.perLoop.opponentLife).toBe(-2);
      expect(combo.produces).toContain('Infinite damage');
    });

    it('loops Devoted Druid by piling -1/-1 counters until it dies', () => {
      const combo = only('Mikaeus, the Unhallowed', 'Devoted Druid');
      expect(combo.verification.perLoop.deaths).toBe(1);
    });

    it('rejects loops where the creature comes back with a +1/+1 counter', () => {
      // Looks infinite to the resource check, but undying only returns a creature once.
      const { combos, rejected } = run('Mikaeus, the Unhallowed', 'Viscera Seer', 'Griselbrand');
      expect(combos).toEqual([]);
      expect(rejected.map((r) => r.reason)).toContain('Griselbrand died with a +1/+1 counter, so undying does not return it');
    });
  });

  describe('zones, amounts and doubled triggers', () => {
    it('recasts Sensei\'s Divining Top from the library with Mystic Forge and a cost reducer', () => {
      expect(run("Sensei's Divining Top", 'Mystic Forge').combos).toEqual([]); // Top costs {1} each time
      const combo = only("Sensei's Divining Top", 'Mystic Forge', 'Etherium Sculptor');
      expect(combo.produces).toEqual(expect.arrayContaining(['Infinite card draw', 'Infinite spell casts']));
    });

    it('pays and regains exactly 50 life: Aetherflux Reservoir + Exquisite Blood', () => {
      const combo = only('Aetherflux Reservoir', 'Exquisite Blood');
      expect(combo.verification.startup).toEqual(['needs more than 50 life to start']);
      expect(combo.verification.perLoop).toMatchObject({ opponentLife: -50, life: 0 });
    });

    it('taps each arriving artifact for mana: Urza + Thopter Foundry + Sword of the Meek', () => {
      const combo = only('Urza, Lord High Artificer', 'Thopter Foundry', 'Sword of the Meek');
      expect(combo.netMana).toBe('{U}');
    });

    it('needs enough other creatures for Living Death to pay for itself', () => {
      const combo = only('Living Death', 'Eternal Witness', 'Phyrexian Altar');
      expect(combo.prerequisites).toContain('You have at least 4 other creature cards in your graveyard or on the battlefield');
      expect(combo.verification.perLoop).toMatchObject({ deaths: 5, etbs: 5, casts: 1 });
    });

    it('needs Panharmonicon for Venser to bounce both Peregrine Drake and itself', () => {
      expect(run('Peregrine Drake', 'Venser, Shaper Savant').combos).toEqual([]);
      const combo = only('Peregrine Drake', 'Venser, Shaper Savant', 'Panharmonicon');
      // Two Drake triggers untap 10 lands; recasting both costs 9.
      expect(combo.netMana).toBe('{any}');
    });
  });
});
