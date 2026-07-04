/**
 * tree-first accumulation benchmark.
 *
 * The old accumulation loop wrote a bucket for every prefix-key combination
 * across both axes: (rowFields+1) x (colFields+1) buckets per record. The new
 * loop writes only the leaf intersection + the two grand-total edges — at
 * most 4 buckets per record, regardless of how many row/column fields are
 * sliced — then fills subtotals in one bottom-up merge pass over the (much
 * smaller) member-tree nodes.
 *
 * 3 row fields x 2 col fields: old writes (3+1)*(2+1)=12 buckets/record;
 * new writes <=4. Cardinalities are kept low relative to the record count
 * (many records share the same leaf) so the per-record multiplier — not
 * output-grid size — is what's being measured; a high-cardinality grid where
 * almost every record lands in its own distinct cell dilutes the old loop's
 * redundant-write cost and isn't representative.
 *
 * A/B like cache-bench.mjs: run new, checkout the pre-tree-first commit, rebuild, run old.
 *   BENCH_LABEL=new node --expose-gc benchmark/tree-first-bench.mjs
 *   git checkout <pre-tree-first-sha> -- packages/core/src/engine/{build,aggregate,tree}.ts
 *   pnpm --filter @pvotly/core run build
 *   BENCH_LABEL=old node --expose-gc benchmark/tree-first-bench.mjs
 *   git checkout HEAD -- packages/core/src/engine/{build,aggregate,tree}.ts
 *   pnpm --filter @pvotly/core run build
 */

import { buildGrid, Dataset } from '../packages/core/dist/index.js';

const LABEL = process.env.BENCH_LABEL ?? 'run';
const ROWS = Number(process.argv[2] ?? 2_000_000);
const REPS = 5;

const heapMB = () => process.memoryUsage().heapUsed / 1024 / 1024;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];

// 3 row fields x 2 col fields (old: 12 buckets/record, new: <=4). Low
// cardinality (product ~1200 row combos x 40 col combos) against 2M records
// means every bucket is touched thousands of times — this is where the old
// per-record fan-out (12 map writes/record) costs the most relative to the
// new leaf+grand-total write (<=4) followed by one bottom-up merge pass over
// the ~1200-node tree.
const customer = range(50, (i) => `cust_${i}`);
const region = range(8, (i) => `region_${i}`);
const tier = range(3, (i) => `tier_${i}`);
const category = range(10, (i) => `cat_${i}`);
const channel = range(4, (i) => `chan_${i}`);

const records = range(ROWS, () => ({
  customer: pick(customer),
  region: pick(region),
  tier: pick(tier),
  category: pick(category),
  channel: pick(channel),
  amount: Math.random() * 1000,
}));

const config = {
  dataSource: { data: records },
  slice: {
    rows: [{ uniqueName: 'customer' }, { uniqueName: 'region' }, { uniqueName: 'tier' }],
    columns: [{ uniqueName: 'category' }, { uniqueName: 'channel' }],
    measures: [{ uniqueName: 'amount', aggregation: 'sum' }],
  },
};

const times = [];
let heapDelta = 0;
let grid;
for (let i = 0; i < REPS; i++) {
  const dataset = new Dataset({ data: records });
  if (global.gc) global.gc();
  const before = heapMB();
  const t0 = performance.now();
  grid = buildGrid(dataset, config);
  times.push(performance.now() - t0);
  if (i === REPS - 1) {
    if (global.gc) global.gc();
    heapDelta = heapMB() - before;
  }
}

console.log(`\ntree-first accumulation — ${ROWS.toLocaleString()} rows, 3 row fields x 2 col fields (low cardinality), ${REPS} reps\n`);
console.log(
  `  [${LABEL}] median=${median(times).toFixed(0)}ms  ` +
  `(min=${Math.min(...times).toFixed(0)} max=${Math.max(...times).toFixed(0)})  ` +
  `heapΔ(last run)=${heapDelta.toFixed(0)}MB  out=${grid.rowLeaves.length}×${grid.columnLeaves.length}  body=${grid.body.length}`,
);
console.log();
