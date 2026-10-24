/**
 * Hand-curated two-card combos. These are interactions too specific for the
 * generic theme rules, and they are always shown with the highest edge weight.
 */
export interface Combo {
  cards: [string, string];
  result: string;
}

export const COMBOS: Combo[] = [
  { cards: ['Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts'], result: 'Infinite hasty attackers' },
  { cards: ['Kiki-Jiki, Mirror Breaker', 'Pestermite'], result: 'Infinite hasty attackers' },
  { cards: ['Kiki-Jiki, Mirror Breaker', 'Deceiver Exarch'], result: 'Infinite hasty attackers' },
  { cards: ['Kiki-Jiki, Mirror Breaker', 'Restoration Angel'], result: 'Infinite hasty attackers' },
  { cards: ['Splinter Twin', 'Pestermite'], result: 'Infinite hasty attackers' },
  { cards: ['Splinter Twin', 'Deceiver Exarch'], result: 'Infinite hasty attackers' },
  { cards: ["Thassa's Oracle", 'Demonic Consultation'], result: 'Win the game' },
  { cards: ["Thassa's Oracle", 'Tainted Pact'], result: 'Win the game' },
  { cards: ['Laboratory Maniac', 'Demonic Consultation'], result: 'Win the game' },
  { cards: ['Isochron Scepter', 'Dramatic Reversal'], result: 'Infinite mana with nonland mana rocks' },
  { cards: ['Heliod, Sun-Crowned', 'Walking Ballista'], result: 'Infinite damage' },
  { cards: ['Mikaeus, the Unhallowed', 'Triskelion'], result: 'Infinite damage' },
  { cards: ['Mikaeus, the Unhallowed', 'Walking Ballista'], result: 'Infinite damage' },
  { cards: ['Exquisite Blood', 'Sanguine Bond'], result: 'Infinite life drain' },
  { cards: ['Basalt Monolith', 'Rings of Brighthearth'], result: 'Infinite colorless mana' },
  { cards: ['Grim Monolith', 'Power Artifact'], result: 'Infinite colorless mana' },
  { cards: ['Basalt Monolith', 'Power Artifact'], result: 'Infinite colorless mana' },
  { cards: ['Dualcaster Mage', 'Twinflame'], result: 'Infinite hasty tokens' },
  { cards: ['Dualcaster Mage', 'Heat Shimmer'], result: 'Infinite hasty tokens' },
  { cards: ['Saheeli Rai', 'Felidar Guardian'], result: 'Infinite hasty Cats' },
  { cards: ['Devoted Druid', 'Vizier of Remedies'], result: 'Infinite green mana' },
  { cards: ['Peregrine Drake', 'Deadeye Navigator'], result: 'Infinite mana' },
  { cards: ['Niv-Mizzet, Parun', 'Curiosity'], result: 'Infinite damage and card draw' },
  { cards: ['Niv-Mizzet, the Firemind', 'Curiosity'], result: 'Infinite damage and card draw' },
  { cards: ['Gravecrawler', 'Phyrexian Altar'], result: 'Infinite death triggers (with a Zombie)' },
  { cards: ['Food Chain', 'Squee, the Immortal'], result: 'Infinite creature mana' },
  { cards: ['Food Chain', 'Eternal Scourge'], result: 'Infinite creature mana' },
  { cards: ['Sword of the Meek', 'Thopter Foundry'], result: 'Infinite thopters and life' },
  { cards: ['Painter\'s Servant', 'Grindstone'], result: 'Mill entire library' },
  { cards: ['Pili-Pala', 'Grand Architect'], result: 'Infinite mana' },
  { cards: ['Midnight Guard', 'Presence of Gond'], result: 'Infinite tokens' },
  { cards: ['Village Bell-Ringer', 'Presence of Gond'], result: 'Infinite tokens' },
];
