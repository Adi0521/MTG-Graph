import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { fetchCards } from '../src/core/scryfall.ts';
import { createApp, UpstreamError } from './app.ts';
import { FileCardCache } from './card-cache.ts';
import { cachedSpellbook } from './spellbook-cache.ts';

const PORT = Number(process.env.PORT ?? 8787);
// The file name carries the card format version (see CACHE_PREFIX in scryfall.ts).
const cache = new FileCardCache(process.env.CARD_CACHE ?? '.cache/scryfall-cards-v2.json');
const userAgent = 'mtg-graph/0.3';
const withUserAgent: typeof fetch = (url, init) =>
  fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), 'User-Agent': userAgent } });

const app = createApp({
  cardSource: async (names) => {
    try {
      return await fetchCards(names, {
        cache,
        // Scryfall asks API clients to identify themselves.
        fetchImpl: withUserAgent,
      });
    } catch (err) {
      throw new UpstreamError(`Could not reach Scryfall: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      cache.flush();
    }
  },
  // SPELLBOOK=off disables the Commander Spellbook lookup; the combo engine still runs.
  knownComboSource:
    process.env.SPELLBOOK === 'off'
      ? undefined
      : cachedSpellbook({
          path: process.env.SPELLBOOK_CACHE ?? '.cache/spellbook.json',
          ttlHours: Number(process.env.SPELLBOOK_CACHE_HOURS ?? 168),
          fetchImpl: withUserAgent,
        }),
});

// In production, serve the built front end from the same origin.
if (existsSync('dist/index.html')) app.use('/*', serveStatic({ root: './dist' }));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`MTG Graph API on http://localhost:${PORT} (${cache.size} cards cached)`);
});
