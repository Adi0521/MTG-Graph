import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runBenchmark } from '../bench/benchmark.ts';

/**
 * Coverage must not regress. Runs offline on the frozen data in bench/data and
 * compares with bench/baseline.json. After an intentional improvement, refresh the
 * baseline with `npm run bench -- --baseline`.
 */
const baseline = JSON.parse(readFileSync(new URL('../bench/baseline.json', import.meta.url), 'utf8')) as Record<
  string,
  { connectivity: number; matchedCombos: string[] }
>;

describe('coverage benchmark', async () => {
  const result = await runBenchmark();

  it('covers every baseline deck', () => {
    expect(result.decks.map((d) => d.slug).sort()).toEqual(Object.keys(baseline).sort());
  });

  for (const deck of result.decks) {
    it(`${deck.slug}: synergy coverage and combo recall do not regress`, () => {
      const base = baseline[deck.slug]!;
      expect(deck.notFound).toEqual([]);
      expect(deck.connectivity).toBeGreaterThanOrEqual(base.connectivity);
      expect(deck.matchedCombos).toEqual(expect.arrayContaining(base.matchedCombos));
    });
  }
}, 60_000);
