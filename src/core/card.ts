import type { Card, ScryfallCard } from './types.ts';

const SELF_REFERENCES =
  /\bthis (creature|artifact|enchantment|permanent|land|planeswalker|card|spell|vehicle|equipment|aura|token)\b/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lowercase the oracle text and replace every way a card can refer to itself
 * (its full name, its short legendary name, "this creature", ...) with "~",
 * so rules can match "when ~ enters" regardless of templating era.
 */
export function normalizeText(oracle: string, names: string[]): string {
  // Reminder text (in parentheses) restates keywords and token rules; matching it causes false links.
  let text = oracle
    .toLowerCase()
    .replace(/−/g, '-')
    .replace(/ ?\([^)]*\)/g, '');
  const aliases = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    aliases.add(lower);
    // "Krenko, Mob Boss" is referred to as "Krenko" in its own text.
    const short = lower.split(',')[0]!.trim();
    if (short.length >= 3) aliases.add(short);
  }
  // Replace longer aliases first so the full name wins over its short form.
  for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'g'), '~');
  }
  return text.replace(SELF_REFERENCES, '~');
}

/** Creature/kindred subtypes from a type line, e.g. "Creature — Goblin Warrior" → ["Goblin", "Warrior"]. */
export function creatureTypes(typeLine: string): string[] {
  const types = new Set<string>();
  for (const face of typeLine.split('//')) {
    const [supertypes, subtypes] = face.split('—');
    if (!subtypes || !/\b(Creature|Kindred|Tribal)\b/.test(supertypes ?? '')) continue;
    for (const t of subtypes.trim().split(/\s+/)) if (t) types.add(t);
  }
  return [...types];
}

export function toCard(raw: ScryfallCard, quantity = 1): Card {
  const faces = raw.card_faces ?? [];
  const faceNames = faces.map((f) => f.name);
  const oracleText = raw.oracle_text ?? faces.map((f) => f.oracle_text ?? '').join('\n//\n');
  const typeLine = raw.type_line ?? faces.map((f) => f.type_line ?? '').join(' // ');
  const images = raw.image_uris ?? faces[0]?.image_uris;
  return {
    name: raw.name,
    quantity,
    typeLine,
    oracleText,
    text: normalizeText(oracleText, [raw.name, ...faceNames]),
    keywords: (raw.keywords ?? []).map((k) => k.toLowerCase()),
    colorIdentity: raw.color_identity ?? raw.colors ?? [],
    manaCost: raw.mana_cost ?? faces.map((f) => f.mana_cost ?? '').join(' // '),
    cmc: raw.cmc ?? 0,
    creatureTypes: creatureTypes(typeLine),
    imageUrl: images?.normal,
    artUrl: images?.art_crop,
    scryfallUri: raw.scryfall_uri,
  };
}
