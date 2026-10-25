import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KnownComboSource } from '../src/core/analyze.ts';
import { fetchSpellbook, type SpellbookResult } from '../src/core/spellbook.ts';
import type { DeckEntry } from '../src/core/types.ts';

interface Entry {
  fetchedAt: string;
  result: SpellbookResult;
}

/**
 * Commander Spellbook results cached per deck (by card list), on disk. Within the
 * TTL the same deck always gets the same combos; after it, the data refreshes.
 */
export function cachedSpellbook({ path, ttlHours, fetchImpl }: { path: string; ttlHours: number; fetchImpl?: typeof fetch }): KnownComboSource {
  let cache: Record<string, Entry> = {};
  try {
    cache = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Entry>;
  } catch {
    // No cache yet.
  }

  const save = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(cache));
    renameSync(`${path}.tmp`, path);
  };

  return async (entries: DeckEntry[]) => {
    const key = deckKey(entries);
    const hit = cache[key];
    if (hit && Date.now() - Date.parse(hit.fetchedAt) < ttlHours * 3_600_000) return hit;
    const entry = { fetchedAt: new Date().toISOString(), result: await fetchSpellbook(entries, { fetchImpl }) };
    cache[key] = entry;
    save();
    return entry;
  };
}

export function deckKey(entries: DeckEntry[]): string {
  const lines = entries.map((e) => `${e.section}:${e.name.toLowerCase()}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
