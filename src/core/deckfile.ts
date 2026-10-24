import { parseDecklist } from './decklist.ts';
import type { DeckEntry } from './types.ts';

/**
 * Parse an uploaded deck file. Supports:
 *   - MTGO .dek XML: <Cards Quantity="4" Sideboard="false" Name="Lightning Bolt" />
 *   - CSV exports (Moxfield, Archidekt, Deckbox...) with a count and a name column
 *   - anything else as a plain-text decklist (.txt, .dec, .dck, MTGA exports)
 */
export function parseDeckFile(filename: string, content: string): DeckEntry[] {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const trimmed = content.replace(/^﻿/, '').trim();
  if (ext === 'dek' || trimmed.startsWith('<?xml') || /^<Deck\b/i.test(trimmed)) return parseDekXml(trimmed);
  if (ext === 'csv') return parseCsv(trimmed);
  return parseDecklist(trimmed);
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseDekXml(xml: string): DeckEntry[] {
  const lines: string[] = [];
  const sideboard: string[] = [];
  for (const tag of xml.match(/<Cards\b[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1]!.toLowerCase(), decodeXml(m[2]!)]));
    if (!attrs.name) continue;
    const line = `${attrs.quantity ?? '1'} ${attrs.name}`;
    (attrs.sideboard === 'true' ? sideboard : lines).push(line);
  }
  return parseDecklist([...lines, 'Sideboard', ...sideboard].join('\n'));
}

/** Split one CSV line, honoring double-quoted fields with "" escapes. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

function parseCsv(csv: string): DeckEntry[] {
  const rows = csv.split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(rows[0] ?? '').map((h) => h.toLowerCase());
  const nameCol = header.findIndex((h) => h === 'name' || h === 'card name' || h === 'card');
  const countCol = header.findIndex((h) => ['count', 'quantity', 'qty', 'amount'].includes(h));
  const boardCol = header.findIndex((h) => ['board', 'section', 'category'].includes(h));
  if (nameCol === -1) return parseDecklist(csv);

  const sections: Record<string, string[]> = { main: [], commander: [], sideboard: [] };
  for (const row of rows.slice(1)) {
    const cols = splitCsvLine(row);
    const name = cols[nameCol];
    if (!name) continue;
    const count = countCol === -1 ? '1' : cols[countCol] || '1';
    const board = (boardCol === -1 ? '' : cols[boardCol] ?? '').toLowerCase();
    if (board.includes('maybe')) continue;
    const section = board.includes('commander') ? 'commander' : board.includes('side') ? 'sideboard' : 'main';
    sections[section]!.push(`${count} ${name}`);
  }
  return parseDecklist(
    ['Commander', ...sections.commander!, 'Deck', ...sections.main!, 'Sideboard', ...sections.sideboard!].join('\n'),
  );
}
