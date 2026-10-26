import type { ScryfallCard } from './types.ts';

const COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const BATCH_SIZE = 75; // Scryfall's maximum identifiers per collection request.
const REQUEST_DELAY_MS = 100; // Scryfall asks for 50–100ms between requests.
// Bump when slim() keeps new fields, so cached cards missing them are fetched again.
const CACHE_PREFIX = 'mtg-graph:card:v2:';

export interface FetchResult {
  cards: Map<string, ScryfallCard>;
  notFound: string[];
}

export interface CardCache {
  get(name: string): ScryfallCard | undefined;
  set(name: string, card: ScryfallCard): void;
}

/** localStorage-backed cache; silently becomes a no-op where storage is unavailable. */
export const localStorageCache: CardCache = {
  get(name) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + name.toLowerCase());
      return raw ? (JSON.parse(raw) as ScryfallCard) : undefined;
    } catch {
      return undefined;
    }
  },
  set(name, card) {
    try {
      localStorage.setItem(CACHE_PREFIX + name.toLowerCase(), JSON.stringify(slim(card)));
    } catch {
      // Quota exceeded or storage blocked: caching is best-effort.
    }
  },
};

/** Keep only the fields the analyzer reads, to keep the cache small. */
export function slim(card: ScryfallCard): ScryfallCard {
  const { name, type_line, oracle_text, keywords, colors, color_identity, mana_cost, cmc, power, toughness, image_uris, card_faces, scryfall_uri } = card;
  return {
    name,
    type_line,
    oracle_text,
    keywords,
    colors,
    color_identity,
    mana_cost,
    cmc,
    power,
    toughness,
    image_uris: image_uris && { normal: image_uris.normal, art_crop: image_uris.art_crop },
    card_faces: card_faces?.map((f) => ({
      name: f.name,
      type_line: f.type_line,
      oracle_text: f.oracle_text,
      mana_cost: f.mana_cost,
      colors: f.colors,
      power: f.power,
      toughness: f.toughness,
      image_uris: f.image_uris && { normal: f.image_uris.normal, art_crop: f.image_uris.art_crop },
    })),
    scryfall_uri,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Look up cards by name using Scryfall's /cards/collection endpoint.
 * Returned map is keyed by the requested name (lowercased).
 */
export async function fetchCards(
  names: string[],
  { cache = localStorageCache, fetchImpl = fetch }: { cache?: CardCache; fetchImpl?: typeof fetch } = {},
): Promise<FetchResult> {
  const cards = new Map<string, ScryfallCard>();
  const missing: string[] = [];
  for (const name of new Set(names)) {
    const cached = cache.get(name);
    if (cached) cards.set(name.toLowerCase(), cached);
    else missing.push(name);
  }

  const notFound: string[] = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(REQUEST_DELAY_MS);
    const batch = missing.slice(i, i + BATCH_SIZE);
    const res = await fetchImpl(COLLECTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
    });
    if (!res.ok) throw new Error(`Scryfall request failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { data: ScryfallCard[]; not_found?: { name?: string }[] };

    const unmatched = new Set(batch.map((n) => n.toLowerCase()));
    for (const card of body.data) {
      // Match the response back to the requested name (full name or a face name).
      const candidates = [card.name, ...(card.card_faces?.map((f) => f.name) ?? [])].map((n) => n.toLowerCase());
      const requested = candidates.find((n) => unmatched.has(n)) ?? card.name.toLowerCase();
      unmatched.delete(requested);
      const slimmed = slim(card);
      cards.set(requested, slimmed);
      cache.set(requested, slimmed);
    }
    for (const nf of body.not_found ?? []) if (nf.name) notFound.push(nf.name);
  }
  return { cards, notFound };
}
