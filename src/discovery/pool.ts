import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { slim } from '../core/scryfall.ts';
import type { ScryfallCard } from '../core/types.ts';

/**
 * The discovery card pool: every paper, Commander-legal card, once each (Scryfall "oracle cards").
 * Downloaded once and cached as a slim JSON file.
 */

export const CACHE_DIR = '.cache/discovery';
const POOL_FILE = `${CACHE_DIR}/pool.json`;
const RAW_FILE = `${CACHE_DIR}/oracle-cards.jsonl.gz`;
const USER_AGENT = 'mtg-graph-discovery/0.1';

interface RawOracleCard extends ScryfallCard {
  layout?: string;
  set_type?: string;
  games?: string[];
  legalities?: Record<string, string>;
}

const EXCLUDED_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'scheme', 'planar', 'reversible_card']);

function keep(card: RawOracleCard): boolean {
  if (EXCLUDED_LAYOUTS.has(card.layout ?? '')) return false;
  if (card.set_type === 'funny' || card.set_type === 'memorabilia') return false;
  if (!(card.games ?? []).includes('paper')) return false;
  // Alchemy rebalanced cards ("A-Card Name") are digital-only.
  if (card.name.startsWith('A-')) return false;
  return card.legalities?.commander === 'legal';
}

async function download(): Promise<void> {
  const meta = (await (await fetch('https://api.scryfall.com/bulk-data', { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })).json()) as {
    data: { type: string; jsonl_download_uri: string }[];
  };
  const uri = meta.data.find((b) => b.type === 'oracle_cards')!.jsonl_download_uri;
  const res = await fetch(uri, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`Scryfall bulk download failed: ${res.status}`);
  mkdirSync(CACHE_DIR, { recursive: true });
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(RAW_FILE));
}

/** Load the pool, downloading and filtering Scryfall's bulk data the first time (or with `refresh`). */
export async function loadPool({ refresh = false } = {}): Promise<ScryfallCard[]> {
  if (!refresh && existsSync(POOL_FILE)) return JSON.parse(readFileSync(POOL_FILE, 'utf8')) as ScryfallCard[];
  if (refresh || !existsSync(RAW_FILE)) await download();
  const cards: ScryfallCard[] = [];
  const lines = createInterface({ input: createReadStream(RAW_FILE).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed.startsWith('{')) continue;
    const card = JSON.parse(trimmed) as RawOracleCard;
    if (keep(card)) cards.push(slim(card));
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(POOL_FILE, JSON.stringify(cards));
  return cards;
}
