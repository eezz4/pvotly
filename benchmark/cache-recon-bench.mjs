/**
 * pivot-cache benchmark: reconfiguration reuse.
 *
 * Simulates drag-and-drop reconfiguration — one Dataset, many buildGrid calls
 * with different row/column slices. With the encoded-column cache the resolved
 * values + token codes are computed once and reused; without it every build
 * re-scans and re-tokenizes the source records (worst for date-part fields).
 *
 * A/B like the others: run new, stash engine+data, rebuild, run old.
 *   BENCH_LABEL=new node --expose-gc benchmark/cache-recon-bench.mjs
 *   git stash push -- packages/core/src/engine packages/core/src/data
 *   pnpm --filter @pvotly/core run build
 *   BENCH_LABEL=old node --expose-gc benchmark/cache-recon-bench.mjs
 *   git stash pop && pnpm --filter @pvotly/core run build
 */

import { buildGrid, Dataset } from '../packages/core/dist/index.js';

const LABEL = process.env.BENCH_LABEL ?? 'run';

function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}
function range(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

const ROWS = 200_000;
const country = range(10, (i) => `Country_${i}`);
const category = range(8, (i) => `Category_${i}`);
const segment = range(5, (i) => `Segment_${i}`);
const records = range(ROWS, () => {
  const y = 2020 + Math.floor(Math.random() * 5);
  const m = 1 + Math.floor(Math.random() * 12);
  const d = 1 + Math.floor(Math.random() * 28);
  return {
    country: pick(country),
    category: pick(category),
    segment: pick(segment),
    date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    sales: Math.random() * 1000,
  };
});

// Reconfigurations reuse a small set of fields (incl. expensive date parts).
const SLICES = [
  { rows: ['country'], columns: ['date.year'] },
  { rows: ['category'], columns: ['date.quarter'] },
  { rows: ['country', 'category'], columns: ['date.year'] },
  { rows: ['segment'], columns: ['country'] },
  { rows: ['date.year', 'date.quarter'], columns: ['category'] },
  { rows: ['country'], columns: ['category'] },
  { rows: ['category', 'segment'], columns: ['date.year'] },
  { rows: ['country', 'segment'], columns: ['date.quarter'] },
];

const source = {
  data: records,
  mapping: { date: { type: 'date', dateParts: ['year', 'quarter', 'month'] } },
};

// One Dataset, reused across every reconfiguration (this is what a UI does).
const dataset = new Dataset(source);

if (global.gc) global.gc();
const t0 = performance.now();
const per = [];
for (const s of SLICES) {
  const t1 = performance.now();
  buildGrid(dataset, {
    dataSource: source,
    slice: {
      rows: s.rows.map((uniqueName) => ({ uniqueName })),
      columns: s.columns.map((uniqueName) => ({ uniqueName })),
      measures: [{ uniqueName: 'sales', aggregation: 'sum' }],
    },
  });
  per.push(performance.now() - t1);
}
const total = performance.now() - t0;

console.log(`\n[${LABEL}] reconfiguration reuse — ${ROWS.toLocaleString()} rows, ${SLICES.length} builds`);
console.log(`  build 1 (cold): ${per[0].toFixed(0)}ms`);
console.log(`  builds 2..N avg: ${(per.slice(1).reduce((a, b) => a + b, 0) / (per.length - 1)).toFixed(0)}ms`);
console.log(`  total: ${total.toFixed(0)}ms\n`);
