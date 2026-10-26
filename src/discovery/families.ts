import type { Ability } from '../core/abilities.ts';
import type { Discovered } from './search.ts';

/**
 * Group discovered combos into families: the same pattern of roles with interchangeable cards
 * ("Solemnity + any persist creature + any free sacrifice outlet" is one family, not 4,000 combos).
 */

export interface Family {
  /** Roles in the pattern, with the cards seen in each. */
  roles: { role: string; cards: string[] }[];
  members: Discovered[];
  /** A known Spellbook combo in this family (exact match or one-card variant), if any. */
  knownMember: Discovered | null;
  /** A known family whose roles this one contains plus one more (a known engine with one extra piece). */
  extends: Family | null;
}

/**
 * Roles without cost details or side effects, for "is this a new idea?": a sacrifice outlet is a sacrifice
 * outlet, whether it costs {1} or 2 life and whether it scries or pings ("activated [sac creature, mana] →
 * drain" and "activated [sac creature] → nothing" match).
 */
const coarse = (role: string) =>
  role
    .split(' & ')
    .map((part) => {
      const noCosts = part.replace(/, mana|mana, |\[mana\]|, life|life, |\[life\]/g, '').replace(/\s+\[\]/g, '');
      // Any sacrifice outlet, whatever it sacrifices and does.
      return /^activated \[sac /.test(noCosts) ? 'sacrifice outlet' : noCosts;
    })
    .join(' & ');

/** A short signature of what an ability does in a loop: costs it pays, what triggers it, what it makes. */
function signature(a: Pick<Ability, 'kind' | 'trigger' | 'cost' | 'outputs'>): string {
  const cost = [
    a.cost.sacrifice && `sac ${a.cost.sacrifice.another ? 'another ' : ''}${a.cost.sacrifice.nontoken ? 'nontoken ' : ''}${a.cost.sacrifice.what}`,
    a.cost.tap && 'tap',
    a.cost.loyalty && 'loyalty',
    a.cost.removeCounter && 'remove counter',
    a.cost.minusCounter && '-1/-1 counter',
    a.cost.life && 'life',
    Object.values(a.cost.mana).some((n) => n > 0) && 'mana',
  ].filter(Boolean);
  const trigger = a.trigger ? `on ${a.trigger.type}${'self' in a.trigger && a.trigger.self ? ' (self)' : ''}` : a.kind;
  const outputs = [...new Set(a.outputs.map((o) => o.type))].sort();
  return `${trigger}${cost.length ? ` [${cost.join(', ')}]` : ''} → ${outputs.join('+') || 'nothing'}`;
}

/** The role each card plays in a combo, from the loop steps it performs and the helper role it fills. */
function roles(c: Discovered, abilitiesByText: Map<string, Ability>): Map<string, string> {
  const byCard = new Map<string, Set<string>>();
  for (const step of c.steps) {
    const ability = abilitiesByText.get(`${step.card}\u0000${step.ability}`);
    const set = byCard.get(step.card) ?? new Set<string>();
    set.add(ability ? signature(ability) : step.ability);
    byCard.set(step.card, set);
  }
  const result = new Map<string, string>();
  for (const card of c.cards) {
    const sig = byCard.get(card);
    result.set(card, sig ? [...sig].sort().join(' & ') : c.helpers.includes(card) ? `helper` : 'piece');
  }
  return result;
}

export function groupFamilies(combos: Discovered[], abilitiesOf: (card: string) => Ability[]): Family[] {
  const lookup = new Map<string, Ability>();
  const ensure = (card: string) => {
    for (const a of abilitiesOf(card)) lookup.set(`${card}\u0000${a.text}`, a);
  };
  const families = new Map<string, Family>();
  for (const c of combos) {
    c.cards.forEach(ensure);
    const r = roles(c, lookup);
    // Helpers are grouped by the card's own role signature too, so different Treasure makers fall together.
    for (const h of c.helpers) {
      const a = abilitiesOf(h)[0];
      r.set(h, `helper: ${a ? signature(a) : h}`);
    }
    const pattern = [...r.values()].sort();
    const key = pattern.join(' | ');
    let family = families.get(key);
    if (!family) {
      family = { roles: pattern.map((role) => ({ role, cards: [] })), members: [], knownMember: null, extends: null };
      families.set(key, family);
    }
    family.members.push(c);
    for (const [card, role] of r) {
      const slot = family.roles.find((s) => s.role === role)!;
      if (!slot.cards.includes(card)) slot.cards.push(card);
    }
    if (!family.knownMember && (c.known || c.variantOf)) family.knownMember = c;
  }
  // A family that is a known family's roles plus one extra role extends a known engine.
  const all = [...families.values()];
  const known = all.filter((f) => f.knownMember);
  const contains = (big: string[], small: string[]) => {
    const pool = [...big];
    for (const r of small) {
      const at = pool.indexOf(r);
      if (at === -1) return false;
      pool.splice(at, 1);
    }
    return true;
  };
  for (const f of all) {
    if (f.knownMember) continue;
    const mine = f.roles.map((r) => coarse(r.role));
    f.extends = known.find((k) => {
      const theirs = k.roles.map((r) => coarse(r.role));
      return mine.length - theirs.length <= 1 && contains(mine, theirs);
    }) ?? null;
  }
  const rank = (f: Family) => (f.knownMember ? 2 : f.extends ? 1 : 0);
  return all.sort((a, b) => rank(a) - rank(b) || b.members.length - a.members.length);
}
