import type { DeckEntry } from './types.ts';

const SECTION_HEADERS: Record<string, DeckEntry['section'] | null> = {
  deck: 'main',
  main: 'main',
  maindeck: 'main',
  mainboard: 'main',
  commander: 'commander',
  commanders: 'commander',
  sideboard: 'sideboard',
  maybeboard: null,
  companion: 'sideboard',
};

/**
 * Parse common decklist formats (plain text, MTGA/MTGO exports, Moxfield):
 *   4 Lightning Bolt
 *   1x Sol Ring
 *   2 Fable of the Mirror-Breaker (NEO) 141
 *   Delver of Secrets // Insectile Aberration
 * Section headers ("Sideboard", "Commander:") switch the current section.
 * Lines starting with "//" or "#" are comments. Maybeboard cards are skipped.
 * Duplicate lines are merged.
 */
export function parseDecklist(input: string): DeckEntry[] {
  const entries = new Map<string, DeckEntry>();
  let section: DeckEntry['section'] | null = 'main';

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;

    const header = line.toLowerCase().replace(/[:\s]+$/, '');
    if (Object.hasOwn(SECTION_HEADERS, header)) {
      section = SECTION_HEADERS[header]!;
      continue;
    }
    if (section === null) continue;

    const match = /^(?:(\d+)\s*x?\s+)?(.+?)(?:\s+\([A-Za-z0-9]+\)(?:\s+\S+)?)?(?:\s+\*[A-Z]+\*)?$/.exec(line);
    if (!match) continue;
    const quantity = match[1] ? Number(match[1]) : 1;
    const name = match[2]!.split(' // ')[0]!.trim();
    if (!name || quantity <= 0) continue;

    const key = `${section}:${name.toLowerCase()}`;
    const existing = entries.get(key);
    if (existing) existing.quantity += quantity;
    else entries.set(key, { name, quantity, section });
  }
  return [...entries.values()];
}
