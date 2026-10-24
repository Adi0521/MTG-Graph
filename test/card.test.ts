import { describe, expect, it } from 'vitest';
import { creatureTypes, normalizeText } from '../src/core/card.ts';
import { card } from './helpers.ts';

describe('normalizeText', () => {
  it('replaces full and short legendary names with ~', () => {
    expect(normalizeText('Krenko, Mob Boss gets +1/+1. Krenko attacks.', ['Krenko, Mob Boss'])).toBe('~ gets +1/+1. ~ attacks.');
  });

  it('replaces modern self-reference templating', () => {
    expect(normalizeText('When this creature enters, draw a card.', ['Thing'])).toBe('when ~ enters, draw a card.');
  });
});

describe('creatureTypes', () => {
  it('reads subtypes of creatures only', () => {
    expect(creatureTypes('Legendary Creature — Goblin Warrior')).toEqual(['Goblin', 'Warrior']);
    expect(creatureTypes('Artifact — Equipment')).toEqual([]);
  });

  it('reads both faces', () => {
    expect(card('Delver of Secrets').creatureTypes).toEqual(['Human', 'Wizard', 'Insect']);
  });
});
