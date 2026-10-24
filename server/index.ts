import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { fetchCards } from '../src/core/scryfall.ts';
import { createApp, UpstreamError } from './app.ts';
import { FileCardCache } from './card-cache.ts';

const PORT = Number(process.env.PORT ?? 8787);
const cache = new FileCardCache(process.env.CARD_CACHE ?? '.cache/scryfall-cards.json');

const app = createApp({
  cardSource: async (names) => {
    try {
      return await fetchCards(names, {
        cache,
        // Scryfall asks API clients to identify themselves.
        fetchImpl: (url, init) =>
          fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), 'User-Agent': 'mtg-graph/0.2' } }),
      });
    } catch (err) {
      throw new UpstreamError(`Could not reach Scryfall: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      cache.flush();
    }
  },
});

// In production, serve the built front end from the same origin.
if (existsSync('dist/index.html')) app.use('/*', serveStatic({ root: './dist' }));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`MTG Graph API on http://localhost:${PORT} (${cache.size} cards cached)`);
});
