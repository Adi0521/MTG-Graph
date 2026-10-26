import { describe, expect, it } from 'vitest';
import { untrackedCondition } from '../src/core/abilities.ts';
import { makeNoveltyCheck, makeVariantCheck, VariantSplitter, type SpellbookIndex } from '../src/discovery/spellbook-index.ts';

describe('untracked conditions (found by the discovery audit)', () => {
  it.each([
    ['whenever you sacrifice another permanent, you gain 2 life if this is the first time this ability has resolved this turn.', null],
    ['you may sacrifice this enchantment. if you do, create a 4/4 white avatar creature token with flying.', 'sacrifices itself (one-shot)'],
    ['whenever ~ or another nontoken creature you control dies, return that card to the battlefield under your control at the beginning of the next end step.', 'delayed until a later step'],
    ['when ~ enters, if it was kicked, create a token that\'s a copy of target creature you control.', 'needs it to have been cast'],
    ['you may remove that many reprieve counters from this creature. if you do, return that card to the battlefield.', 'uses up its own counters'],
    ['whenever this creature or another creature you control dies, if it had a +1/+1 counter on it, create a 2/2 white knight creature token.', 'needs a counter on the dying creature'],
    ['{t}: put a card exiled with ~ into its owner\'s graveyard.', 'uses up cards it exiled'],
    ['{0}: remove target attacking creature you control from combat and untap it.', 'only in combat'],
  ])('%s', (text, expected) => {
    expect(untrackedCondition(text)).toBe(expected);
  });

  it('allows delayed cleanup of a token (Kiki-Jiki)', () => {
    expect(untrackedCondition("create a token that's a copy of target nonlegendary creature you control, except it has haste. sacrifice it at the beginning of the next end step.")).toBeNull();
  });
});

describe('VariantSplitter', () => {
  it('extracts each variant object across arbitrary chunk boundaries', () => {
    const json = JSON.stringify({
      timestamp: 't1',
      variants: [
        { id: 'a', uses: [{ card: { name: 'X {weird} "quoted" \\\\ name' } }] },
        { id: 'b', uses: [{ card: { name: 'Y' } }, { card: { name: 'Z' } }] },
      ],
    });
    for (const size of [1, 3, 7, 50, json.length]) {
      const splitter = new VariantSplitter();
      const ids: string[] = [];
      for (let i = 0; i < json.length; i += size) splitter.push(json.slice(i, i + size), (obj) => ids.push((JSON.parse(obj) as { id: string }).id));
      expect(ids).toEqual(['a', 'b']);
      expect(splitter.timestamp).toBe('t1');
    }
  });
});

describe('novelty checks', () => {
  const index: SpellbookIndex = {
    timestamp: 't',
    combos: [
      { id: '1', cards: ['Solemnity', 'Viscera Seer'], requires: 1 },
      { id: '2', cards: ['Gravecrawler', 'Phyrexian Altar'], requires: 0 },
    ],
  };
  const isKnown = makeNoveltyCheck(index);
  const variantOf = makeVariantCheck(index);

  it('knows exact matches and extra cards that fill a generic requirement', () => {
    expect(isKnown(['Gravecrawler', 'Phyrexian Altar'], ['Gravecrawler', 'Phyrexian Altar'])?.id).toBe('2');
    expect(isKnown(['Solemnity', 'Viscera Seer', 'Kitchen Finks'], ['Viscera Seer', 'Kitchen Finks'])?.id).toBe('1');
    expect(isKnown(['Squee, the Immortal', "Ashnod's Altar", 'Pitiless Plunderer'], ['Squee, the Immortal', "Ashnod's Altar"])).toBeNull();
  });

  it('recognises one-card variants', () => {
    expect(variantOf(['Gravecrawler', 'Carrion Feeder'])).toMatchObject({ combo: { id: '2' }, ours: ['Carrion Feeder'], theirs: ['Phyrexian Altar'] });
    expect(variantOf(['Squee, the Immortal', "Ashnod's Altar"])).toBeNull();
  });
});
