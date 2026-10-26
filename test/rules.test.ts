import { describe, expect, it } from 'vitest';
import { tagCard, type ThemeId } from '../src/core/rules.ts';
import { card } from './helpers.ts';

/** [card, themes it should provide, themes it should want] — checked against real oracle text. */
const EXPECTED: [string, ThemeId[], ThemeId[]][] = [
  ['Viscera Seer', ['creature_dies'], ['sac_fodder']],
  ['Village Rites', ['creature_dies', 'instant_sorcery'], ['sac_fodder']],
  ['Blood Artist', ['lifegain'], ['creature_dies']],
  ['Zulaport Cutthroat', ['lifegain'], ['creature_dies']],
  ['Cruel Celebrant', ['lifegain'], ['creature_dies']],
  ['Mayhem Devil', [], ['creature_dies']],
  ['Bitterblossom', ['tokens', 'sac_fodder', 'enchantments'], []],
  ['Young Pyromancer', ['tokens', 'sac_fodder'], ['instant_sorcery']],
  ['Gravecrawler', ['sac_fodder', 'creature_enters'], ['mana']],
  ['Skullclamp', ['artifacts'], ['creature_dies']],
  ['Wrath of God', ['creature_dies'], []],
  ['Restoration Angel', ['etb'], ['etb']],
  ['Ephemerate', ['etb'], []],
  ['Kiki-Jiki, Mirror Breaker', ['etb'], []],
  ['Thraben Inspector', ['artifacts'], ['etb']],
  ['Mulldrifter', ['draw'], ['etb']],
  ['Hardened Scales', ['enchantments'], ['counters']],
  ['Walking Ballista', ['counters'], []],
  ['Heliod, Sun-Crowned', ['counters'], ['lifegain']],
  ['Ajani\'s Pridemate', [], ['lifegain']],
  ['Monastery Swiftspear', [], ['noncreature']],
  ['Guttersnipe', [], ['instant_sorcery']],
  ['Satyr Wayfinder', ['graveyard'], []],
  ['Gurmag Angler', [], ['graveyard']],
  ['Cranial Plating', ['artifacts'], ['artifacts']],
  ['Thought Monitor', ['artifacts'], ['artifacts']],
  ['Pitiless Plunderer', ['artifacts'], ['creature_dies']],
  ['Sythis, Harvest\'s Hand', [], ['enchantments']],
  ['Bloodstained Mire', ['landfall'], []],
  ['Lotus Cobra', [], ['landfall']],
  ['Soul Warden', ['lifegain'], ['creature_enters']],
  ['Phyrexian Altar', ['mana', 'creature_dies'], ['sac_fodder']],
  ['Pestermite', ['untap'], ['etb']],
  ['Zealous Conscripts', ['untap'], ['etb']],
  ['Kiki-Jiki, Mirror Breaker', ['etb'], ['untap']],
  ['Splinter Twin', ['etb'], ['untap']],
  ['Restoration Angel', ['untap'], []],
  ['Sanguine Bond', ['drain'], ['lifegain']],
  ['Exquisite Blood', ['lifegain'], ['drain']],
  ['Animate Dead', ['creature_enters'], ['graveyard']],
  ['Walking Ballista', ['drain'], ['mana']],
  ['Ghalta, Primal Hunger', ['power'], ['power']],
  ['Steel Leaf Champion', ['power', 'evolve'], []],
  ['Experiment One', [], ['evolve']],
  ['Sram, Senior Edificer', [], ['equipment']],
  ['Sword of Fire and Ice', ['equipment'], []],
  ['Reanimate', [], ['reanimation']],
  ['Griselbrand', ['reanimation'], []],
  ['Reveillark', [], ['leaves']],
  ['Fabled Passage', ['land_sacrifice'], []],
  ['Ramunap Excavator', [], ['land_sacrifice']],
  ['Azusa, Lost but Seeking', ['landfall'], []],
  ['Winding Constrictor', [], ['counters']],
  ['Glimpse of Nature', [], ['creature_spells']],
  ['Coat of Arms', [], ['tokens']],
  ['Brago, King Eternal', ['etb'], []],
];

describe('tagCard', () => {
  it.each(EXPECTED)('%s', (name, provides, wants) => {
    const tags = tagCard(card(name));
    for (const t of provides) expect([...tags.provides.keys()], `${name} should provide ${t}`).toContain(t);
    for (const t of wants) expect([...tags.wants.keys()], `${name} should want ${t}`).toContain(t);
  });

  it('does not treat typed lords as generic anthems', () => {
    expect(tagCard(card('Goblin Chieftain')).wants.has('tokens')).toBe(false);
  });

  it('does not treat self-recursion as a graveyard payoff', () => {
    expect(tagCard(card('Gravecrawler')).wants.has('graveyard')).toBe(false);
  });

  it('does not read "whenever you gain life" as gaining life', () => {
    for (const name of ['Sanguine Bond', "Ajani's Pridemate", 'Heliod, Sun-Crowned']) {
      expect(tagCard(card(name)).provides.has('lifegain'), name).toBe(false);
    }
  });

  it('does not count drawbacks or removal as synergy', () => {
    // Necromancy's leave trigger sacrifices your creature; Elspeth destroys big creatures.
    expect(tagCard(card('Necromancy')).wants.has('leaves')).toBe(false);
    expect(tagCard(card("Elspeth, Sun's Champion")).wants.has('power')).toBe(false);
  });

  it('ignores mana abilities a card grants to something else', () => {
    // Old-Growth Troll's mana ability belongs to the Forest it enchants after dying.
    expect(tagCard(card('Old-Growth Troll')).provides.has('ramp')).toBe(false);
  });

  it('only counts fetch lands, not self-sacrificing creatures, as land sacrifice', () => {
    expect(tagCard(card('Sakura-Tribe Elder')).provides.has('land_sacrifice')).toBe(false);
  });

  it('does not treat lands as mana enablers', () => {
    expect(tagCard(card('Mountain')).provides.has('mana')).toBe(false);
  });

  it('does not treat opponent draws as a draw payoff', () => {
    expect(tagCard(card('Faerie Mastermind')).wants.has('draw')).toBe(false);
  });

  it('tags lands only for what they do', () => {
    const tags = tagCard(card('Mountain'));
    expect(tags.provides.size + tags.wants.size).toBe(0);
  });
});
