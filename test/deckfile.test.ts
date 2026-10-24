import { describe, expect, it } from 'vitest';
import { parseDeckFile, splitCsvLine } from '../src/core/deckfile.ts';

describe('parseDeckFile', () => {
  it('parses MTGO .dek XML', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Deck xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <NetDeckID>0</NetDeckID>
  <Cards CatID="1" Quantity="4" Sideboard="false" Name="Viscera Seer" Annotation="0" />
  <Cards CatID="2" Quantity="2" Sideboard="false" Name="Ashnod&apos;s Altar" Annotation="0" />
  <Cards CatID="3" Quantity="3" Sideboard="true" Name="Rest in Peace" Annotation="0" />
</Deck>`;
    expect(parseDeckFile('deck.dek', xml)).toEqual([
      { name: 'Viscera Seer', quantity: 4, section: 'main' },
      { name: "Ashnod's Altar", quantity: 2, section: 'main' },
      { name: 'Rest in Peace', quantity: 3, section: 'sideboard' },
    ]);
  });

  it('parses CSV exports with quoted names and boards', () => {
    const csv = ['Count,Name,Edition,Board', '1,"Krenko, Mob Boss",DDT,commander', '4,Lightning Bolt,M10,main', '1,Sol Ring,C21,maybeboard', '2,Rest in Peace,A25,sideboard'].join('\n');
    expect(parseDeckFile('deck.csv', csv)).toEqual([
      { name: 'Krenko, Mob Boss', quantity: 1, section: 'commander' },
      { name: 'Lightning Bolt', quantity: 4, section: 'main' },
      { name: 'Rest in Peace', quantity: 2, section: 'sideboard' },
    ]);
  });

  it('falls back to plain text', () => {
    expect(parseDeckFile('deck.txt', '﻿4 Lightning Bolt\n')).toEqual([{ name: 'Lightning Bolt', quantity: 4, section: 'main' }]);
  });
});

describe('splitCsvLine', () => {
  it('handles escaped quotes', () => {
    expect(splitCsvLine('1,"He said ""hi""",x')).toEqual(['1', 'He said "hi"', 'x']);
  });
});
