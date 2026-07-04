/**
 * pivot-cache benchmark: member-token interning (shared-items dictionary).
 *
 * Measures build time + heap for a pivot whose member names are long and highly
 * repeated across descendants — the case where replacing repeated token strings
 * in every cell key with short interned codes pays off.
 *
 * A/B like ab-bench: run new, stash tree.ts, rebuild, run old.
 *   BENCH_LABEL=new node --expose-gc benchmark/cache-bench.mjs
 *   git stash push -- packages/core/src/engine/tree.ts
 *   pnpm --filter @pvotly/core run build
 *   BENCH_LABEL=old node --expose-gc benchmark/cache-bench.mjs
 *   git stash pop && pnpm --filter @pvotly/core run build
 */

import { buildGrid, Dataset } from '../packages/core/dist/index.js';

const LABEL = process.env.BENCH_LABEL ?? 'run';

function heapMB() {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}
function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}
function range(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

// Long, repeated member names: a country name is embedded in every descendant
// leaf key, so interning it to a 1-2 char code dedupes a lot of string bytes.
const PAD = '________________________________'; // 32 chars
function gen(rows) {
  const country = range(10, (i) => `Country${PAD}${i}`);
  const region = range(100, (i) => `Region${PAD}${i}`);
  const city = range(500, (i) => `City${PAD}${i}`);
  const year = range(5, (i) => 2020 + i);
  const quarter = range(4, (i) => `Q${i + 1}`);
  return range(rows, () => ({
    country: pick(country), region: pick(region), city: pick(city),
    year: pick(year), quarter: pick(quarter),
    sales: Math.random() * 1000,
  }));
}

function run(rows) {
  const records = gen(rows);
  const config = {
    dataSource: { data: records },
    slice: {
      rows: [{ uniqueName: 'country' }, { uniqueName: 'region' }, { uniqueName: 'city' }],
      columns: [{ uniqueName: 'year' }, { uniqueName: 'quarter' }],
      measures: [{ uniqueName: 'sales', aggregation: 'sum' }],
    },
  };
  if (global.gc) global.gc();
  const before = heapMB();
  const t0 = performance.now();
  const grid = buildGrid(new Dataset({ data: records }), config);
  const t = performance.now() - t0;
  const after = heapMB();
  console.log(`  ${rows.toLocaleString()} rows  out=${grid.rowLeaves.length}×${grid.columnLeaves.length}` +
    `  build=${t.toFixed(0)}ms  heapΔ=${(after - before).toFixed(0)}MB`);
}

console.log(`\n[${LABEL}] member-token interning — Node ${process.version}\n`);
for (const rows of [100_000, 300_000]) run(rows);
console.log();
