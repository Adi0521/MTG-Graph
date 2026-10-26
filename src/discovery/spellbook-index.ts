import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CACHE_DIR } from './pool.ts';

/**
 * Compact index of every combo in Commander Spellbook's full export, for checking whether a
 * discovered combo is already known. The export is ~700 MB of JSON, more than one string can
 * hold, so it is stream-parsed: each variant object is cut out by brace depth and parsed alone.
 */

const INDEX_FILE = `${CACHE_DIR}/spellbook-index.json`;
const EXPORT_URL = 'https://json.commanderspellbook.com/variants.json';

export interface KnownCombo {
  id: string;
  cards: string[];
  /** Generic pieces ("a sacrifice outlet") the combo needs on top of its cards. */
  requires: number;
}

export interface SpellbookIndex {
  timestamp: string;
  combos: KnownCombo[];
}

interface RawVariant {
  id: string;
  status?: string;
  uses?: { card?: { name?: string } }[];
  requires?: unknown[];
}

/** Incremental splitter: feed text chunks, get back each complete top-level object inside "variants": [...]. */
export class VariantSplitter {
  private buffer = '';
  /** Next unscanned position in `buffer`; scanning state below carries over between chunks. */
  private pos = 0;
  private inArray = false;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private start = -1;
  timestamp = '';

  push(chunk: string, emit: (json: string) => void) {
    this.buffer += chunk;
    if (!this.inArray) {
      const ts = /"timestamp":\s*"([^"]+)"/.exec(this.buffer);
      if (ts) this.timestamp = ts[1]!;
      const at = this.buffer.indexOf('"variants"');
      if (at === -1) return;
      const bracket = this.buffer.indexOf('[', at);
      if (bracket === -1) return;
      this.inArray = true;
      this.pos = bracket + 1;
    }
    const buf = this.buffer;
    let i = this.pos;
    for (; i < buf.length; i++) {
      const ch = buf.charCodeAt(i);
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === 92 /* \\ */) this.escaped = true;
        else if (ch === 34 /* " */) this.inString = false;
        continue;
      }
      if (ch === 34) this.inString = true;
      else if (ch === 123 /* { */) {
        if (this.depth === 0) this.start = i;
        this.depth++;
      } else if (ch === 125 /* } */) {
        this.depth--;
        if (this.depth === 0 && this.start !== -1) {
          emit(buf.slice(this.start, i + 1));
          this.start = -1;
        }
      }
    }
    // Drop everything before the unfinished object (if any); resume scanning where we stopped.
    const keepFrom = this.start === -1 ? i : this.start;
    this.buffer = buf.slice(keepFrom);
    this.pos = i - keepFrom;
    if (this.start !== -1) this.start = 0;
  }
}

async function build(): Promise<SpellbookIndex> {
  const res = await fetch(EXPORT_URL, { headers: { 'User-Agent': 'mtg-graph-discovery/0.1' } });
  if (!res.ok || !res.body) throw new Error(`Spellbook export download failed: ${res.status}`);
  const splitter = new VariantSplitter();
  const combos: KnownCombo[] = [];
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    splitter.push(decoder.decode(value, { stream: true }), (json) => {
      const v = JSON.parse(json) as RawVariant;
      if (v.status && v.status !== 'OK') return;
      const cards = (v.uses ?? []).flatMap((u) => (u.card?.name ? [u.card.name] : []));
      if (cards.length) combos.push({ id: v.id, cards, requires: (v.requires ?? []).length });
    });
  }
  return { timestamp: splitter.timestamp, combos };
}

export async function loadSpellbookIndex({ refresh = false } = {}): Promise<SpellbookIndex> {
  if (!refresh && existsSync(INDEX_FILE)) return JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as SpellbookIndex;
  const index = await build();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(index));
  return index;
}

const frontFace = (name: string) => name.split(' // ')[0]!.toLowerCase();

/**
 * The closest known combo that differs by at most one card swapped or added (same idea, one interchangeable
 * piece changed: a different sacrifice outlet, a different Treasure maker...). Null if nothing is that close.
 */
export function makeVariantCheck(index: SpellbookIndex) {
  const byCard = new Map<string, KnownCombo[]>();
  for (const combo of index.combos) {
    for (const c of combo.cards) {
      const key = frontFace(c);
      const list = byCard.get(key) ?? [];
      list.push(combo);
      byCard.set(key, list);
    }
  }
  return (cards: string[]): { combo: KnownCombo; ours: string[]; theirs: string[] } | null => {
    const set = new Set(cards.map(frontFace));
    let best: { combo: KnownCombo; ours: string[]; theirs: string[] } | null = null;
    for (const combo of new Set(cards.flatMap((c) => byCard.get(frontFace(c)) ?? []))) {
      const theirs = combo.cards.filter((c) => !set.has(frontFace(c)));
      const comboSet = new Set(combo.cards.map(frontFace));
      const ours = cards.filter((c) => !comboSet.has(frontFace(c)));
      if (theirs.length > 1 || ours.length > 1 || combo.cards.length < 2) continue;
      const score = theirs.length + ours.length;
      if (!best || score < best.theirs.length + best.ours.length) best = { combo, ours, theirs };
    }
    return best;
  };
}

/**
 * Is a discovered card set already known? Known if some Spellbook combo uses only cards from the set
 * (the set may add a card for a generic requirement), or the set's loop cards are all in a combo
 * that names extra pieces generically.
 */
export function makeNoveltyCheck(index: SpellbookIndex) {
  const byCard = new Map<string, KnownCombo[]>();
  for (const combo of index.combos) {
    for (const c of combo.cards) {
      const key = frontFace(c);
      const list = byCard.get(key) ?? [];
      list.push(combo);
      byCard.set(key, list);
    }
  }
  return (cards: string[], loop: string[]): KnownCombo | null => {
    const set = new Set(cards.map(frontFace));
    const loopSet = new Set(loop.map(frontFace));
    const candidates = new Set(cards.flatMap((c) => byCard.get(frontFace(c)) ?? []));
    for (const combo of candidates) {
      const comboSet = combo.cards.map(frontFace);
      // Every Spellbook card is among ours, and anything we add beyond it fills one of its generic requirements.
      const extra = [...set].filter((c) => !comboSet.includes(c)).length;
      if (comboSet.every((c) => set.has(c)) && extra <= combo.requires) return combo;
      // Our loop is covered by the combo, and our extra pieces are its generic requirements.
      if ([...loopSet].every((c) => comboSet.includes(c)) && comboSet.every((c) => set.has(c))) return combo;
    }
    return null;
  };
}
