/** Subset of the Scryfall card object that the analyzer uses. */
export interface ScryfallFace {
  name: string;
  type_line?: string;
  oracle_text?: string;
  mana_cost?: string;
  colors?: string[];
  image_uris?: ScryfallImages;
}

export interface ScryfallImages {
  small?: string;
  normal?: string;
  art_crop?: string;
}

export interface ScryfallCard {
  name: string;
  type_line?: string;
  oracle_text?: string;
  keywords?: string[];
  colors?: string[];
  color_identity?: string[];
  mana_cost?: string;
  cmc?: number;
  image_uris?: ScryfallImages;
  card_faces?: ScryfallFace[];
  scryfall_uri?: string;
}

/** A card normalized for rule matching. */
export interface Card {
  name: string;
  quantity: number;
  typeLine: string;
  /** Original oracle text (all faces joined), for display. */
  oracleText: string;
  /** Lowercased oracle text with self-references replaced by "~". Rules match against this. */
  text: string;
  keywords: string[];
  colorIdentity: string[];
  manaCost: string;
  cmc: number;
  creatureTypes: string[];
  imageUrl?: string;
  artUrl?: string;
  scryfallUri?: string;
}

export interface DeckEntry {
  name: string;
  quantity: number;
  section: 'main' | 'commander' | 'sideboard';
}
