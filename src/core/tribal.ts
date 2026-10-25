import type { Card } from './types.ts';

const IRREGULAR_PLURALS: Record<string, string> = {
  Elf: 'Elves',
  Dwarf: 'Dwarves',
  Wolf: 'Wolves',
  Werewolf: 'Werewolves',
  Mouse: 'Mice',
  Ox: 'Oxen',
  Fungus: 'Fungi',
  Octopus: 'Octopuses',
  Sphinx: 'Sphinxes',
  Fox: 'Foxes',
  Merfolk: 'Merfolk',
  Phyrexian: 'Phyrexians',
};

export function pluralize(type: string): string {
  if (IRREGULAR_PLURALS[type]) return IRREGULAR_PLURALS[type];
  if (/(s|x|z|ch|sh)$/i.test(type)) return `${type}es`;
  if (/[^aeiou]y$/i.test(type)) return `${type.slice(0, -1)}ies`;
  return `${type}s`;
}

/**
 * Text with clauses that mention a type without caring about it removed:
 * token creation ("create a 1/1 Goblin token") and hostile references
 * ("protection from Humans", "can't be blocked by Walls", "destroy target Elf").
 */
function textForTribal(card: Card): string {
  return card.text
    .replace(/create[^.]*?tokens?/g, ' ')
    .replace(/protection from [^.,\n]*/g, ' ')
    .replace(/can't be blocked (?:except )?by [^.,\n]*/g, ' ')
    .replace(/(?:destroy|exile) (?:target|all|each) [^.,\n]*/g, ' ');
}

/** Creature types a card's rules text refers to, out of the candidate set. */
export function referencedTypes(card: Card, candidates: Iterable<string>): string[] {
  const body = textForTribal(card);
  const found: string[] = [];
  for (const type of candidates) {
    const re = new RegExp(`\\b(?:${type}|${pluralize(type)})\\b`, 'i');
    if (re.test(body)) found.push(type);
  }
  return found;
}

export function hasType(card: Card, type: string): boolean {
  return card.creatureTypes.includes(type) || card.keywords.includes('changeling');
}
