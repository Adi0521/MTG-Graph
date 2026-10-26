/**
 * Coverage benchmark over bench/decks.
 *   npm run bench               offline, using frozen data in bench/data
 *   npm run bench -- --fetch    download data for new decks/cards first
 *   npm run bench -- --refresh  re-download all data
 *   npm run bench -- --refresh-cards  re-download card data only (Spellbook answers stay fixed)
 *   npm run bench -- --baseline also save the scores as bench/baseline.json
 *   npm run bench -- --holdout  score the held-out decks in bench/holdout instead (report-holdout.md)
 * Writes bench/report.md and bench/results.json.
 */
import { writeFileSync } from 'node:fs';
import { renderReport, runBenchmark } from '../bench/benchmark.ts';

const args = new Set(process.argv.slice(2));
const holdout = args.has('--holdout');
const result = await runBenchmark({
  fetchMissing: args.has('--fetch'),
  refresh: args.has('--refresh'),
  refreshCards: args.has('--refresh-cards'),
  set: holdout ? 'holdout' : 'train',
});
const suffix = holdout ? '-holdout' : '';
writeFileSync(new URL(`../bench/results${suffix}.json`, import.meta.url), JSON.stringify(result, null, 2) + '\n');
writeFileSync(new URL(`../bench/report${suffix}.md`, import.meta.url), renderReport(result, holdout ? 'Held-out benchmark' : 'Coverage benchmark'));
if (args.has('--baseline') && !holdout) {
  const baseline = Object.fromEntries(
    result.decks.map((d) => [d.slug, { connectivity: d.connectivity, matchedCombos: d.matchedCombos }]),
  );
  writeFileSync(new URL('../bench/baseline.json', import.meta.url), JSON.stringify(baseline, null, 2) + '\n');
}

const pct = (n: number | null) => (n === null ? '  –' : `${Math.round(n * 100)}%`.padStart(4));
console.log('deck'.padEnd(22), 'synergy', 'isolated', 'recall');
for (const d of result.decks) {
  console.log(d.slug.padEnd(22), pct(d.connectivity).padStart(7), String(d.isolated.length).padStart(8), `${pct(d.recall)} (${d.matched}/${d.spellbookCombos})`, d.notFound.length ? `NOT FOUND: ${d.notFound.join(', ')}` : '');
}
const t = result.totals;
console.log(`\nTotal: synergy ${pct(t.connectivity)}, combo recall ${t.matched}/${t.spellbookCombos} (${pct(t.recall)}), ${t.engineOnly} engine-only. Report: bench/report${suffix}.md`);
