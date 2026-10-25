import type { DeckEntry } from './types.ts';

/**
 * Client for Commander Spellbook (commanderspellbook.com), a community-curated
 * database of combos. It is human-maintained data, not ML; results for a deck
 * change only when the database does, and the server caches them.
 */

export const SPELLBOOK_URL = 'https://backend.commanderspellbook.com/find-my-combos';

export interface SpellbookCombo {
  id: string;
  cards: string[];
  produces: string[];
  steps: string[];
  prerequisites: string[];
  manaNeeded: string;
  url: string;
  popularity: number;
}

export interface SpellbookNearMiss extends SpellbookCombo {
  /** Cards the combo uses that are not in the deck. */
  missing: string[];
}

export interface SpellbookResult {
  included: SpellbookCombo[];
  almostIncluded: SpellbookNearMiss[];
}

interface RawVariant {
  id: string;
  uses?: { card?: { name?: string } }[];
  produces?: { feature?: { name?: string } }[];
  requires?: { template?: { name?: string }; quantity?: number }[];
  description?: string;
  easyPrerequisites?: string;
  notablePrerequisites?: string;
  manaNeeded?: string;
  popularity?: number | null;
}

const lines = (s: string | undefined) =>
  (s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function toCombo(v: RawVariant): SpellbookCombo {
  const requires = (v.requires ?? []).flatMap((r) => (r.template?.name ? [`Requires ${r.template.name}${(r.quantity ?? 1) > 1 ? ` ×${r.quantity}` : ''}`] : []));
  return {
    id: v.id,
    cards: (v.uses ?? []).flatMap((u) => (u.card?.name ? [u.card.name] : [])),
    produces: (v.produces ?? []).flatMap((p) => (p.feature?.name ? [p.feature.name] : [])),
    steps: lines(v.description),
    prerequisites: [...new Set([...requires, ...lines(v.easyPrerequisites), ...lines(v.notablePrerequisites)])],
    manaNeeded: v.manaNeeded ?? '',
    url: `https://commanderspellbook.com/combo/${v.id}/`,
    popularity: v.popularity ?? 0,
  };
}

/** Lowercased name and front-face name, for matching Spellbook names to deck names. */
const nameKeys = (name: string) => [name.toLowerCase(), name.split(' // ')[0]!.toLowerCase()];

/** Map raw API results to our types; near misses sorted by popularity and capped. */
export function mapSpellbookResults(
  raw: { included?: RawVariant[]; almostIncluded?: RawVariant[] },
  deckNames: string[],
  maxNearMisses = 30,
): SpellbookResult {
  const inDeck = new Set(deckNames.flatMap(nameKeys));
  const byKey = new Map(deckNames.flatMap((n) => nameKeys(n).map((k) => [k, n] as const)));
  const toDeckName = (n: string) => byKey.get(n.toLowerCase()) ?? byKey.get(n.split(' // ')[0]!.toLowerCase()) ?? n;

  const included = (raw.included ?? [])
    .map(toCombo)
    .map((c) => ({ ...c, cards: c.cards.map(toDeckName) }))
    .sort((a, b) => b.popularity - a.popularity || a.id.localeCompare(b.id));
  const almostIncluded = (raw.almostIncluded ?? [])
    .map(toCombo)
    .map((c) => ({
      ...c,
      cards: c.cards.map(toDeckName),
      missing: c.cards.filter((n) => !nameKeys(n).some((k) => inDeck.has(k))),
    }))
    .filter((c) => c.missing.length > 0)
    .sort((a, b) => b.popularity - a.popularity || a.id.localeCompare(b.id))
    .slice(0, maxNearMisses);
  return { included, almostIncluded };
}

export type ComboSource = (entries: DeckEntry[]) => Promise<SpellbookResult>;

/** Query Commander Spellbook for a deck. Throws on network or HTTP errors. */
export async function fetchSpellbook(
  entries: DeckEntry[],
  { fetchImpl = fetch, timeoutMs = 15_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SpellbookResult> {
  const body = {
    main: entries.filter((e) => e.section === 'main').map((e) => ({ card: e.name, quantity: e.quantity })),
    commanders: entries.filter((e) => e.section === 'commander').map((e) => ({ card: e.name, quantity: 1 })),
  };
  const res = await fetchImpl(SPELLBOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Commander Spellbook returned ${res.status}`);
  const json = (await res.json()) as { results?: { included?: RawVariant[]; almostIncluded?: RawVariant[] } };
  return mapSpellbookResults(json.results ?? {}, entries.map((e) => e.name));
}
