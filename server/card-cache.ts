import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CardCache } from '../src/core/scryfall.ts';
import type { ScryfallCard } from '../src/core/types.ts';

/** Scryfall card cache kept in memory and persisted to one JSON file. */
export class FileCardCache implements CardCache {
  private cards = new Map<string, ScryfallCard>();
  private dirty = false;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ScryfallCard>;
      for (const [name, card] of Object.entries(data)) this.cards.set(name, card);
    } catch {
      // No cache yet, or unreadable: start empty.
    }
  }

  get(name: string) {
    return this.cards.get(name.toLowerCase());
  }

  set(name: string, card: ScryfallCard) {
    this.cards.set(name.toLowerCase(), card);
    this.dirty = true;
  }

  get size() {
    return this.cards.size;
  }

  /** Write the cache to disk if it changed. Writes to a temp file first so a crash cannot corrupt it. */
  flush() {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.cards)));
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}
