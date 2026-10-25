import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { analyzeDeck, DeckError, ENGINE_VERSION, type AnalyzeOptions, type CardSource, type KnownComboSource } from '../src/core/analyze.ts';
import { parseDeckFile } from '../src/core/deckfile.ts';
import { parseDecklist } from '../src/core/decklist.ts';
import { EDGE_KIND_META, type EdgeKind } from '../src/core/graph.ts';
import { THEMES } from '../src/core/rules.ts';
import { DEFAULT_STRUCTURE_OPTIONS, MAX_LOOP_LENGTH_LIMIT } from '../src/core/structures.ts';
import type { DeckEntry } from '../src/core/types.ts';

const MAX_BODY_BYTES = 1024 * 1024;

export class UpstreamError extends Error {}

/**
 * POST /api/analyze accepts either
 *   - JSON: { "decklist": "4 Lightning Bolt\n...", "options": {...}, "enabledKinds": [...], "spellbook": true }
 *   - multipart/form-data: a "deck" file (.txt/.dek/.csv/...) or a "decklist" text field,
 *     plus optional "options" and "enabledKinds" fields as JSON strings and "spellbook" ("true"/"false").
 */
export function createApp({ cardSource, knownComboSource }: { cardSource: CardSource; knownComboSource?: KnownComboSource }) {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true, engineVersion: ENGINE_VERSION }));

  app.get('/api/rules', (c) =>
    c.json({
      engineVersion: ENGINE_VERSION,
      defaults: DEFAULT_STRUCTURE_OPTIONS,
      maxLoopLength: MAX_LOOP_LENGTH_LIMIT,
      kinds: EDGE_KIND_META,
      themes: THEMES.map((t) => ({
        id: t.id,
        label: t.label,
        weight: t.weight,
        provides: t.provides.map((m) => m.why),
        wants: t.wants.map((m) => m.why),
      })),
    }),
  );

  app.post(
    '/api/analyze',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Deck upload is larger than 1 MB.' }, 413) }),
    async (c) => {
      let entries: DeckEntry[];
      let options: AnalyzeOptions;
      try {
        ({ entries, options } = await readRequest(c.req.raw));
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Invalid request.' }, 400);
      }
      try {
        return c.json(await analyzeDeck(entries, { cards: cardSource, knownCombos: knownComboSource }, options));
      } catch (err) {
        if (err instanceof DeckError) return c.json({ error: err.message }, 400);
        if (err instanceof UpstreamError) return c.json({ error: err.message }, 502);
        console.error(err);
        return c.json({ error: 'Analysis failed.' }, 500);
      }
    },
  );

  return app;
}

async function readRequest(req: Request): Promise<{ entries: DeckEntry[]; options: AnalyzeOptions }> {
  const type = req.headers.get('content-type') ?? '';
  let entries: DeckEntry[];
  let rawOptions: unknown;
  let rawKinds: unknown;
  let rawSpellbook: unknown;

  if (type.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('deck');
    const text = form.get('decklist');
    if (file instanceof File && file.size > 0) entries = parseDeckFile(file.name, await file.text());
    else if (typeof text === 'string' && text.trim()) entries = parseDecklist(text);
    else throw new Error('Send a "deck" file or a "decklist" text field.');
    rawOptions = parseJsonField(form.get('options'), 'options');
    rawKinds = parseJsonField(form.get('enabledKinds'), 'enabledKinds');
    rawSpellbook = parseJsonField(form.get('spellbook'), 'spellbook');
  } else if (type.includes('application/json')) {
    const body = (await req.json().catch(() => {
      throw new Error('Request body is not valid JSON.');
    })) as { decklist?: unknown; filename?: unknown; options?: unknown; enabledKinds?: unknown; spellbook?: unknown };
    if (typeof body.decklist !== 'string' || !body.decklist.trim()) throw new Error('"decklist" must be a non-empty string.');
    entries = typeof body.filename === 'string' ? parseDeckFile(body.filename, body.decklist) : parseDecklist(body.decklist);
    rawOptions = body.options;
    rawKinds = body.enabledKinds;
    rawSpellbook = body.spellbook;
  } else {
    throw new Error('Use Content-Type application/json or multipart/form-data.');
  }

  if (rawSpellbook !== undefined && typeof rawSpellbook !== 'boolean') throw new Error('"spellbook" must be true or false.');
  return {
    entries,
    options: { structure: validateOptions(rawOptions), enabledKinds: validateKinds(rawKinds), spellbook: rawSpellbook as boolean | undefined },
  };
}

function parseJsonField(value: FormDataEntryValue | null, name: string): unknown {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`"${name}" must be valid JSON.`);
  }
}

function validateOptions(raw: unknown): AnalyzeOptions['structure'] {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('"options" must be an object.');
  const out: Record<string, number> = {};
  for (const key of Object.keys(DEFAULT_STRUCTURE_OPTIONS)) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`options.${key} must be a number.`);
    out[key] = v;
  }
  return out;
}

function validateKinds(raw: unknown): EdgeKind[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error('"enabledKinds" must be an array.');
  for (const k of raw) if (typeof k !== 'string' || !(k in EDGE_KIND_META)) throw new Error(`Unknown edge kind: ${String(k)}`);
  return raw as EdgeKind[];
}
