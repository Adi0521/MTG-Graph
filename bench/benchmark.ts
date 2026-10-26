import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseAbilities } from '../src/core/abilities.ts';
import { analyzeDeck, type CardSource, type KnownComboSource } from '../src/core/analyze.ts';
import { toCard } from '../src/core/card.ts';
import { parseDecklist } from '../src/core/decklist.ts';
import { fetchCards } from '../src/core/scryfall.ts';
import { fetchSpellbook, type SpellbookResult } from '../src/core/spellbook.ts';
import type { DeckEntry, ScryfallCard } from '../src/core/types.ts';

/**
 * Coverage benchmark: runs the analyzer over a set of archetype decks and measures
 *   - synergy coverage: share of non-land cards with at least one link
 *   - combo recall: share of Commander Spellbook's combos the rules engine finds on its own
 * Card and Spellbook data are frozen in bench/data, so results are reproducible and offline.
 */

const ROOT = new URL('./', import.meta.url);
const DECKS_DIR = new URL('decks/', ROOT);
const CARDS_FILE = new URL('data/cards.json', ROOT);
const SPELLBOOK_FILE = new URL('data/spellbook.json', ROOT);

export interface MissedCombo {
  cards: string[];
  produces: string[];
  /** Why the engine could not find it, e.g. "Curiosity: no loop abilities parsed". */
  diagnosis: string[];
}

export interface DeckReport {
  slug: string;
  archetype: string;
  uniqueCards: number;
  notFound: string[];
  connectivity: number;
  isolated: string[];
  spellbookCombos: number;
  engineCombos: number;
  matched: number;
  /** matched / spellbookCombos, or null when Spellbook lists none. */
  recall: number | null;
  matchedCombos: string[];
  missed: MissedCombo[];
  engineOnly: { cards: string[]; produces: string[] }[];
}

export interface BenchmarkResult {
  decks: DeckReport[];
  totals: { decks: number; connectivity: number; spellbookCombos: number; matched: number; recall: number; engineOnly: number };
  /** Cards that appear most often in missed combos with no parsed loop abilities: the biggest engine gaps. */
  topUnparsed: { card: string; misses: number }[];
}

interface FrozenData {
  cards: Record<string, ScryfallCard>;
  spellbook: Record<string, { fetchedAt: string; result: SpellbookResult }>;
}

function readJson<T>(url: URL, fallback: T): T {
  return existsSync(url) ? (JSON.parse(readFileSync(url, 'utf8')) as T) : fallback;
}

export function loadDecks(): { slug: string; archetype: string; entries: DeckEntry[] }[] {
  return readdirSync(DECKS_DIR)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((file) => {
      const text = readFileSync(new URL(file, DECKS_DIR), 'utf8');
      return {
        slug: file.replace(/\.txt$/, ''),
        archetype: /^\/\/ Archetype: (.*)$/m.exec(text)?.[1] ?? file,
        entries: parseDecklist(text),
      };
    });
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const comboKey = (cards: string[]) => [...cards].sort().join(' + ');

/**
 * Run the benchmark. With `fetchMissing`, card or Spellbook data not yet frozen is
 * downloaded and saved; `refresh` re-downloads everything, `refreshCards` only the card data
 * (keeping the Spellbook answer key fixed). Without either, the run
 * is fully offline and fails if data is missing.
 */
export async function runBenchmark({ fetchMissing = false, refresh = false, refreshCards = false } = {}): Promise<BenchmarkResult> {
  const data: FrozenData = {
    cards: refresh || refreshCards ? {} : readJson(CARDS_FILE, {}),
    spellbook: refresh ? {} : readJson(SPELLBOOK_FILE, {}),
  };
  const network = fetchMissing || refresh || refreshCards;
  const userAgent: typeof fetch = (url, init) =>
    fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), 'User-Agent': 'mtg-graph-benchmark/0.1' } });

  const cardSource: CardSource = async (names) => {
    const missing = names.filter((n) => !data.cards[n.toLowerCase()]);
    if (missing.length && network) {
      const memory = { get: (n: string) => data.cards[n.toLowerCase()], set: (n: string, c: ScryfallCard) => void (data.cards[n.toLowerCase()] = c) };
      await fetchCards(missing, { cache: memory, fetchImpl: userAgent });
    }
    const cards = new Map<string, ScryfallCard>();
    const notFound: string[] = [];
    for (const n of names) {
      const c = data.cards[n.toLowerCase()];
      if (c) cards.set(n.toLowerCase(), c);
      else notFound.push(n);
    }
    if (notFound.length && !network) throw new Error(`Benchmark data missing cards (${notFound.join(', ')}); run npm run bench -- --fetch`);
    return { cards, notFound };
  };

  const reports: DeckReport[] = [];
  for (const deck of loadDecks()) {
    const knownCombos: KnownComboSource = async (entries) => {
      const frozen = data.spellbook[deck.slug];
      if (frozen) return frozen;
      if (!network) throw new Error(`Benchmark data missing Spellbook results for ${deck.slug}; run npm run bench -- --fetch`);
      const entry = { fetchedAt: new Date().toISOString(), result: await fetchSpellbook(entries, { fetchImpl: userAgent }) };
      data.spellbook[deck.slug] = entry;
      return entry;
    };
    const result = await analyzeDeck(deck.entries, { cards: cardSource, knownCombos });
    if (result.combos.spellbook.status !== 'ok') throw new Error(`Spellbook data unavailable for ${deck.slug}: ${result.combos.spellbook.error}`);

    const cardByName = new Map(result.cards.map((c) => [c.name, c]));
    const sb = result.combos.combos.filter((c) => c.sources.includes('spellbook'));
    const matched = sb.filter((c) => c.sources.includes('engine'));
    const missed = sb.filter((c) => !c.sources.includes('engine'));
    reports.push({
      slug: deck.slug,
      archetype: deck.archetype,
      uniqueCards: result.deck.uniqueCards,
      notFound: result.deck.notFound,
      connectivity: round(result.insights.connectivity),
      isolated: result.insights.isolated,
      spellbookCombos: sb.length,
      engineCombos: result.combos.engine.found,
      matched: matched.length,
      recall: sb.length ? round(matched.length / sb.length) : null,
      matchedCombos: matched.map((c) => comboKey(c.cards)).sort(),
      missed: missed
        .map((c) => ({
          cards: c.cards,
          produces: c.produces.slice(0, 3),
          diagnosis: diagnose(
            c.cards,
            c.prerequisites,
            (name) => {
              const card = cardByName.get(name);
              return card ? toCard({ name: card.name, type_line: card.typeLine, oracle_text: card.oracleText, mana_cost: card.manaCost, color_identity: card.colorIdentity, keywords: data.cards[name.toLowerCase()]?.keywords }) : null;
            },
          ),
        }))
        .sort((a, b) => comboKey(a.cards).localeCompare(comboKey(b.cards))),
      engineOnly: result.combos.combos
        .filter((c) => c.sources.length === 1 && c.sources[0] === 'engine')
        .map((c) => ({ cards: c.cards, produces: c.produces.slice(0, 3) })),
    });
  }

  if (network) {
    writeFileSync(CARDS_FILE, JSON.stringify(Object.fromEntries(Object.entries(data.cards).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n');
    writeFileSync(SPELLBOOK_FILE, JSON.stringify(data.spellbook, null, 1) + '\n');
  }

  const unparsed = new Map<string, number>();
  for (const r of reports) {
    for (const m of r.missed) {
      for (const d of m.diagnosis) {
        const hit = /^(.*): no loop abilities parsed$/.exec(d);
        if (hit) unparsed.set(hit[1]!, (unparsed.get(hit[1]!) ?? 0) + 1);
      }
    }
  }
  const sbTotal = reports.reduce((n, r) => n + r.spellbookCombos, 0);
  const matchedTotal = reports.reduce((n, r) => n + r.matched, 0);
  return {
    decks: reports,
    totals: {
      decks: reports.length,
      connectivity: round(reports.reduce((n, r) => n + r.connectivity, 0) / reports.length),
      spellbookCombos: sbTotal,
      matched: matchedTotal,
      recall: sbTotal ? round(matchedTotal / sbTotal) : 0,
      engineOnly: reports.reduce((n, r) => n + r.engineOnly.length, 0),
    },
    topUnparsed: [...unparsed]
      .map(([card, misses]) => ({ card, misses }))
      .sort((a, b) => b.misses - a.misses || a.card.localeCompare(b.card)),
  };
}

function diagnose(cards: string[], prerequisites: string[], lookup: (name: string) => ReturnType<typeof toCard> | null): string[] {
  const reasons: string[] = [];
  for (const name of cards) {
    const card = lookup(name);
    if (!card) {
      reasons.push(`${name}: card not in analysis`);
      continue;
    }
    const abilities = parseAbilities(card);
    const usable = abilities.filter((a) => !a.unmodeledCost && !a.oncePerTurn);
    if (abilities.some((a) => a.unmodeledCost)) reasons.push(`${name}: cost not modeled`);
    if (abilities.some((a) => a.oncePerTurn)) reasons.push(`${name}: once per turn`);
    if (usable.length === 0 && !abilities.some((a) => a.unmodeledCost || a.oncePerTurn)) reasons.push(`${name}: no loop abilities parsed`);
  }
  const generic = prerequisites.filter((p) => p.startsWith('Requires '));
  if (generic.length) reasons.push(`needs generic pieces: ${generic.join('; ')}`);
  if (reasons.length === 0) reasons.push('all abilities parsed, but the loop was not closed');
  return reasons;
}

export function renderReport(r: BenchmarkResult): string {
  const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
  const out: string[] = [
    '# Coverage benchmark',
    '',
    'Generated by `npm run bench`. Synergy = share of non-land cards with at least one link.',
    'Combo recall = share of Commander Spellbook combos the rules engine also finds on its own.',
    '',
    `**Totals:** ${r.totals.decks} decks · average synergy coverage ${pct(r.totals.connectivity)} · combo recall ${r.totals.matched}/${r.totals.spellbookCombos} (${pct(r.totals.recall)}) · ${r.totals.engineOnly} engine-only combos`,
    '',
    '| Deck | Archetype | Cards | Synergy | Isolated | Spellbook combos | Engine found | Recall | Engine-only |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...r.decks.map(
      (d) =>
        `| ${d.slug} | ${d.archetype} | ${d.uniqueCards} | ${pct(d.connectivity)} | ${d.isolated.length} | ${d.spellbookCombos} | ${d.matched} | ${pct(d.recall)} | ${d.engineOnly.length} |`,
    ),
    '',
    '## Biggest engine gaps',
    '',
    'Cards in missed Spellbook combos whose abilities the engine could not parse into loop pieces:',
    '',
    ...r.topUnparsed.map((u) => `- ${u.card} (${u.misses} missed combo${u.misses === 1 ? '' : 's'})`),
    '',
    '## Missed combos by deck',
    '',
  ];
  for (const d of r.decks) {
    if (!d.missed.length) continue;
    out.push(`### ${d.slug}`, '');
    for (const m of d.missed) out.push(`- **${m.cards.join(' + ')}** (${m.produces.join(', ')}): ${m.diagnosis.join('; ')}`);
    out.push('');
  }
  out.push('## Cards with no detected synergy', '');
  for (const d of r.decks) if (d.isolated.length) out.push(`- **${d.slug}:** ${d.isolated.join(', ')}`);
  out.push('', '## Engine-only combos (review by hand)', '');
  for (const d of r.decks) for (const e of d.engineOnly) out.push(`- ${d.slug}: ${e.cards.join(' + ')} (${e.produces.join(', ')})`);
  if (r.decks.some((d) => d.notFound.length)) {
    out.push('', '## Cards not found', '');
    for (const d of r.decks) if (d.notFound.length) out.push(`- ${d.slug}: ${d.notFound.join(', ')}`);
  }
  return out.join('\n') + '\n';
}
