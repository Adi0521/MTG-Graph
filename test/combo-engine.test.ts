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

  it('finds blink loops through any permanent, including planeswalker loyalty resets', () => {
    expect(sets('Restoration Angel', 'Felidar Guardian')).toEqual([['Felidar Guardian', 'Restoration Angel']]);
    const [saheeli] = combosOf('Saheeli Rai', 'Felidar Guardian');
    expect(saheeli!.cards.sort()).toEqual(['Felidar Guardian', 'Saheeli Rai']);
    expect(saheeli!.steps.map((s) => s.then).join(' ')).toContain('blinks Saheeli Rai');
  });

  it('does not treat delayed returns as blink loops', () => {
    // Flickerwisp returns the card at the next end step, so nothing repeats this turn.
    expect(combosOf('Flickerwisp', 'Restoration Angel')).toEqual([]);
  });

  it('finds draw/damage loops through auras and soulbond', () => {
    const [curiosity] = combosOf('Niv-Mizzet, Parun', 'Curiosity');
    expect(curiosity!.prerequisites).toEqual(['Curiosity is attached to Niv-Mizzet, Parun']);
    expect(curiosity!.produces).toEqual(expect.arrayContaining(['Infinite damage', 'Infinite card draw']));
    const [lookout] = combosOf('Niv-Mizzet, Parun', 'Tandem Lookout');
    expect(lookout!.prerequisites).toEqual(['Tandem Lookout is paired with Niv-Mizzet, Parun']);
  });

  it('finds lifegain/counter loops with "each creature" and aura-granted triggers', () => {
    expect(sets('Spike Feeder', 'Archangel of Thune')).toEqual([['Archangel of Thune', 'Spike Feeder']]);
    const [sunbond] = combosOf('Spike Feeder', 'Sunbond');
    expect(sunbond!.prerequisites).toEqual(['Sunbond is attached to Spike Feeder']);
  });

  describe('artifact loops', () => {
    it('needs a reason to untap Basalt Monolith profitably', () => {
      // Tapping for {C}{C}{C} and paying {3} to untap breaks even and produces nothing.
      expect(combosOf('Basalt Monolith')).toEqual([]);
      const [power] = combosOf('Basalt Monolith', 'Power Artifact');
      expect(power).toMatchObject({ helpers: ['Power Artifact'], netMana: '{C}{C}' });
      expect(power!.prerequisites).toContain('Power Artifact is attached to Basalt Monolith');
      const [rings] = combosOf('Basalt Monolith', 'Rings of Brighthearth');
      expect(rings).toMatchObject({ helpers: ['Rings of Brighthearth'], netMana: '{C}' });
    });

    it('finds Isochron Scepter + Dramatic Reversal with enough mana rocks', () => {
      // Sol Ring's {C}{C} pays for the Scepter, and Dramatic Reversal untaps both.
      const [combo] = combosOf('Isochron Scepter', 'Dramatic Reversal', 'Sol Ring');
      expect(combo!.loop.sort()).toEqual(['Dramatic Reversal', 'Isochron Scepter']);
      expect(combo!.helpers).toEqual(['Sol Ring']);
      expect(combo!.produces).toContain('Infinite spell casts');
      // Without a mana rock the Scepter cannot pay for itself.
      expect(combosOf('Isochron Scepter', 'Dramatic Reversal')).toEqual([]);
    });

    it('finds Paradox Engine + Isochron Scepter with any imprinted instant', () => {
      const combos = combosOf('Paradox Engine', 'Isochron Scepter', 'Brainstorm', 'Sol Ring');
      expect(combos.map((c) => c.loop.sort())).toContainEqual(['Isochron Scepter', 'Paradox Engine']);
    });

    it('turns spare tokens into mana: Thopter Foundry + Sword of the Meek', () => {
      expect(combosOf('Thopter Foundry', 'Sword of the Meek')).toEqual([]);
      const [combo] = combosOf('Thopter Foundry', 'Sword of the Meek', "Ashnod's Altar", 'Krark-Clan Ironworks');
      expect(combo!.loop.sort()).toEqual(['Sword of the Meek', 'Thopter Foundry']);
      expect(combo!.helpers).toEqual(["Ashnod's Altar"]);
      expect(combo!.helperAlternatives).toEqual({ "Ashnod's Altar": ['Krark-Clan Ironworks'] });
    });

    it('loops cards through graveyard and hand: Krark-Clan Ironworks + Scrap Trawler + Myr Retriever', () => {
      // Two sacrifices make {C}{C}{C}{C}, recasting both costs 5: short by one without a cost reducer.
      expect(combosOf('Krark-Clan Ironworks', 'Scrap Trawler', 'Myr Retriever')).toEqual([]);
      const [combo] = combosOf('Krark-Clan Ironworks', 'Scrap Trawler', 'Myr Retriever', 'Etherium Sculptor');
      expect(combo!.loop.sort()).toEqual(['Krark-Clan Ironworks', 'Myr Retriever', 'Scrap Trawler']);
      expect(combo).toMatchObject({ helpers: ['Etherium Sculptor'], netMana: '{C}' });
      expect(combo!.steps.map((s) => s.then)).toEqual(expect.arrayContaining(['this returns Myr Retriever to your hand', 'this returns Scrap Trawler to your hand']));
    });
  });

  describe('blink and leave-the-battlefield loops', () => {
    it('loops Fiend Hunter and Karmic Guide through a sacrifice outlet', () => {
      expect(combosOf('Fiend Hunter', 'Karmic Guide')).toEqual([]);
      const [combo] = combosOf('Fiend Hunter', 'Karmic Guide', 'Viscera Seer');
      expect(combo!.cards.sort()).toEqual(['Fiend Hunter', 'Karmic Guide', 'Viscera Seer']);
      expect(combo!.prerequisites).toContain("Fiend Hunter's enter ability exiles Karmic Guide each time");
      expect(combo!.steps.map((s) => s.then)).toContain('Fiend Hunter leaving the battlefield triggers Fiend Hunter');
    });

    it('flickers Peregrine Drake with a soulbond partner for net mana', () => {
      const [combo] = combosOf('Peregrine Drake', 'Deadeye Navigator');
      expect(combo!.prerequisites).toEqual(
        expect.arrayContaining(['Deadeye Navigator is paired with Peregrine Drake', 'Peregrine Drake: assumes the lands it untaps make the colors you need']),
      );
      expect(combo!.produces).toContain('Infinite mana of any color');
    });

    it('recasts Ghostly Flicker with Archaeomancer, paid for by Peregrine Drake as the second target', () => {
      expect(combosOf('Ghostly Flicker', 'Archaeomancer')).toEqual([]);
      const [combo] = combosOf('Ghostly Flicker', 'Archaeomancer', 'Peregrine Drake');
      expect(combo).toMatchObject({ loop: expect.arrayContaining(['Ghostly Flicker', 'Archaeomancer']), helpers: ['Peregrine Drake'] });
    });

    it('needs Vizier of Remedies to make Devoted Druid repeatable', () => {
      expect(combosOf('Devoted Druid')).toEqual([]);
      const [combo] = combosOf('Devoted Druid', 'Vizier of Remedies');
      expect(combo).toMatchObject({ loop: ['Devoted Druid'], helpers: ['Vizier of Remedies'] });
      expect(combo!.produces).toContain('Infinite green mana');
    });
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

  it('loops -1/-1 counters: Blowfly Infestation kills the Insects Nest of Scarabs makes', () => {
    for (const enabler of ['Nest of Scarabs', 'Hapatra, Vizier of Poisons']) {
      const [c] = combosOf('Blowfly Infestation', enabler);
      expect(c!.produces).toEqual(expect.arrayContaining(['Infinite death triggers']));
    }
    expect(combosOf('Blowfly Infestation')).toEqual([]);
  });

  it('returns persist creatures every time with Melira, Vizier of Remedies, Cathars\' Crusade or bolster', () => {
    expect(combosOf('Kitchen Finks', 'Viscera Seer')).toEqual([]);
    for (const fixer of ['Melira, Sylvok Outcast', 'Vizier of Remedies', "Cathars' Crusade"]) {
      const [c] = combosOf('Kitchen Finks', 'Viscera Seer', fixer);
      expect(c!.helpers).toContain(fixer);
    }
    expect(sets('Murderous Redcap', 'Viscera Seer', 'Anafenza, Kin-Tree Spirit')).toContainEqual(['Anafenza, Kin-Tree Spirit', 'Murderous Redcap']);
  });

  it('applies cost reducers without "you cast", chosen types, Animar and Aluren', () => {
    expect(combosOf("Sensei's Divining Top", 'Mystic Forge', 'Helm of Awakening')).toHaveLength(1);
    const [key] = combosOf("Sensei's Divining Top", 'Mystic Forge', 'Cloud Key');
    expect(key!.prerequisites).toContain('Cloud Key names artifact');
    const [animar] = combosOf('Ancestral Statue', 'Animar, Soul of Elements');
    expect(animar!.prerequisites).toContain('Animar, Soul of Elements has at least 4 +1/+1 counters');
    expect(combosOf('Kor Skyfisher', 'Aluren')).toHaveLength(1);
    expect(combosOf('Peregrine Drake', 'Shrieking Drake')).toEqual([]);
    expect(combosOf('Peregrine Drake', 'Shrieking Drake', 'Panharmonicon')).toHaveLength(1);
  });

  it('copies spells (Dualcaster Mage) and reads modal ETBs (Deceiver Exarch)', () => {
    expect(combosOf('Dualcaster Mage', 'Twinflame')[0]!.produces).toContain('Infinite hasty creature tokens');
    expect(combosOf('Dualcaster Mage', 'Ghostly Flicker')).toHaveLength(1);
    expect(sets('Kiki-Jiki, Mirror Breaker', 'Deceiver Exarch')).toEqual([['Deceiver Exarch', 'Kiki-Jiki, Mirror Breaker']]);
  });

  it('is deterministic', () => {
    const deck = parseDecklist(SAMPLE_COMMANDER_DECK).map((e) => card(e.name, e.quantity));
    expect(findEngineCombos([...deck].reverse())).toEqual(findEngineCombos(deck));
  });
});
