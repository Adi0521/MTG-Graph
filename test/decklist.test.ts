import { describe, expect, it } from 'vitest';
import { parseDecklist } from '../src/core/decklist.ts';

describe('parseDecklist', () => {
  it('parses quantities in several formats', () => {
    expect(parseDecklist('4 Lightning Bolt\n1x Sol Ring\nCounterspell')).toEqual([
      { name: 'Lightning Bolt', quantity: 4, section: 'main' },
      { name: 'Sol Ring', quantity: 1, section: 'main' },
      { name: 'Counterspell', quantity: 1, section: 'main' },
    ]);
  });

  it('strips set codes, collector numbers and foil markers', () => {
    expect(parseDecklist('2 Fable of the Mirror-Breaker (NEO) 141 *F*')).toEqual([
      { name: 'Fable of the Mirror-Breaker', quantity: 2, section: 'main' },
    ]);
  });

  it('uses the front face of double-faced cards', () => {
    expect(parseDecklist('1 Delver of Secrets // Insectile Aberration')[0]!.name).toBe('Delver of Secrets');
  });

  it('handles sections, comments and skips the maybeboard', () => {
    const entries = parseDecklist(
      ['// my deck', 'Commander:', '1 Krenko, Mob Boss', '', 'Deck', '3 Goblin Chieftain', 'Sideboard', '2 Rest in Peace', 'Maybeboard', '1 Sol Ring'].join('\n'),
    );
    expect(entries).toEqual([
      { name: 'Krenko, Mob Boss', quantity: 1, section: 'commander' },
      { name: 'Goblin Chieftain', quantity: 3, section: 'main' },
      { name: 'Rest in Peace', quantity: 2, section: 'sideboard' },
    ]);
  });

  it('merges duplicate lines', () => {
    expect(parseDecklist('2 Viscera Seer\n2 Viscera Seer')).toEqual([{ name: 'Viscera Seer', quantity: 4, section: 'main' }]);
  });
});
