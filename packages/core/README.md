# @pvotly/core

The pure-TypeScript pivot table engine that powers pvotly.

`@pvotly/core` turns a flat array of records into a fully computed pivot grid:
data modelling and type inference, aggregation, filtering, sorting, expand /
collapse, calculated measures, number/conditional formatting and "show value as"
post-processing. It is framework-agnostic and has **zero runtime dependencies**,
so it runs anywhere TypeScript/JavaScript runs (browser, Node, Workers, Deno).

It produces a renderer-friendly `PivotGrid` and leaves all DOM/UI concerns to
the renderer packages (`@pvotly/web`, `@pvotly/react`).

- Version: `0.1.0`
- License: MIT

## Install

```bash
npm install @pvotly/core
# or
pnpm add @pvotly/core
# or
yarn add @pvotly/core
```

The package ships ESM and CJS builds plus type declarations.

## Quick start

```ts
import { PivotEngine } from '@pvotly/core';

const records = [
  { Country: 'USA', Category: 'Bikes', Revenue: 1200, Units: 4 },
  { Country: 'USA', Category: 'Parts', Revenue: 300, Units: 12 },
  { Country: 'UK', Category: 'Bikes', Revenue: 900, Units: 3 },
];

const engine = new PivotEngine({
  dataSource: { data: records },
  slice: {
    rows: [{ uniqueName: 'Country' }],
    columns: [{ uniqueName: 'Category' }],
    measures: [{ uniqueName: 'Revenue', aggregation: 'sum' }],
  },
});

const grid = engine.getGrid();

// Walk the ordered, visible leaves of each axis and read each body cell.
for (const row of grid.rowLeaves) {
  for (const col of grid.columnLeaves) {
    for (const measure of grid.measures) {
      const cell = grid.getCell(row, col, measure);
      console.log(row.caption, col.caption, measure.uniqueName, cell.formatted);
    }
  }
}
```

`PivotEngine` is stateful: after the initial build it caches the grid and only
rebuilds when the configuration or data changes. The grid itself is lazily built
on the first `getGrid()` call.

### Reading the computed grid

`getGrid()` returns a `PivotGrid`:

```ts
interface PivotGrid {
  rowTree: HeaderNode[];      // full row header hierarchy
  columnTree: HeaderNode[];   // full column header hierarchy
  rowLeaves: HeaderNode[];    // flattened, ordered, visible row leaves
  columnLeaves: HeaderNode[]; // flattened, ordered, visible column leaves
  measures: MeasureConfig[];  // active measures, in order
  getCell: (row: HeaderNode, col: HeaderNode, measure: MeasureConfig) => PivotCell;
  body: PivotCell[][];        // body cells in visual order (rows x cols x measures)
  meta: GridMeta;
}
```

- `rowLeaves` / `columnLeaves` are the rows/columns you actually render (already
  ordered, filtered, expanded/collapsed, and including any subtotal and grand-total
  lines). Use `rowTree` / `columnTree` when you need the full header hierarchy for
  spanning headers.
- `getCell(row, col, measure)` looks up the computed cell at the intersection of a
  row leaf, a column leaf and a measure. It always returns a `PivotCell` (a blank
  cell if nothing matches).
- `body` is a convenience matrix of the body cells already laid out in visual order
  if you prefer iterating instead of looking up.

Each `PivotCell` carries the raw aggregated `value`, the `displayValue` (after
"show value as"), a ready-to-render `formatted` string, the `measure`,
`rowPath` / `columnPath`, the `isTotal` / `isGrandTotal` flags, and an optional
conditional-format `style`.

Each `HeaderNode` carries `uniqueName`, `value`, `caption`, `level`, `path`,
`children`, `expanded`, `leafCount` (drives col/row span), and `isTotal` /
`isGrandTotal` flags on leaves.

### Engine API highlights

```ts
const engine = new PivotEngine(config);

engine.getGrid();                 // build (or return cached) PivotGrid
engine.getConfiguration();        // current report (deep clone)
engine.setConfiguration(config);  // replace the whole report
engine.getFields();               // FieldInfo[] for the field list
engine.getMembers('Country');     // distinct member values for a field

// Slice mutations (drag-and-drop style)
engine.addToRows('Country');
engine.addToColumns('Category');
engine.addToValues('Revenue');
engine.addToFilters('Year');
engine.removeField('Category');

// Measures / sorting / filtering / drilling
engine.setAggregation('Revenue', 'average');
engine.setShowDataAs('Revenue', 'percentOfRowTotal');
engine.sortField('Country', 'desc');
engine.setFilter('Country', { type: 'members', include: ['USA'] });
engine.expandAll();
engine.collapseAll();

// Drill-through: the underlying records behind a cell
engine.getRecords(cell.rowPath, cell.columnPath);
```

`PivotEngine` extends a tiny `EventEmitter` and emits `ready`, `reportChange`,
`dataChange`, `filterChange`, `sortChange` and other events (see `PivotEventMap`).

```ts
engine.on('reportChange', (config) => {
  /* persist the report, re-render, ... */
});
```

## `buildGrid()` — the pure function

When you do not need the stateful engine (one-shot / stateless rendering, server
side, snapshot tests), call the pure builder directly. It is a referentially
transparent function of `(Dataset, PivotConfiguration)`:

```ts
import { buildGrid, Dataset } from '@pvotly/core';

const dataset = new Dataset({ data: records });
const grid = buildGrid(dataset, {
  dataSource: { data: records },
  slice: {
    rows: [{ uniqueName: 'Country' }],
    measures: [{ uniqueName: 'Revenue', aggregation: 'sum' }],
  },
});
```

`PivotEngine.getGrid()` is implemented on top of `buildGrid()`.

### `Dataset`

`Dataset` is the normalized, queryable view over a data source. It owns type
inference, value normalization, date-part resolution, member enumeration and
captions:

```ts
const ds = new Dataset({ data: records });
ds.records;                  // normalized DataRecord[]
ds.listFields();             // FieldInfo[] (including derived date-part fields)
ds.getMembers('Country');    // distinct, sorted member values
ds.fieldType('Revenue');     // 'number'
ds.resolveValue(record, 'Date.year'); // resolve a derived field for one record
```

**Pivot cache (reuse the `Dataset`).** The first build resolves + tokenizes each
field into cached columns and a per-`Dataset` member-token dictionary; subsequent
builds of the *same* `Dataset` read those instead of re-scanning the records. There
is nothing to call — just **keep the `Dataset` and rebuild with new configs** to get
the benefit:

```ts
const ds = new Dataset({ data: records });
const a = buildGrid(ds, configA);   // cold: resolves + tokenizes, fills the cache
const b = buildGrid(ds, configB);   // warm: reuses the cache (faster reconfiguration)
```

`PivotEngine` already holds one `Dataset` across slice/sort/filter changes, so this
happens automatically. To **refresh data**, build a *new* `Dataset` (or
`engine.updateData(...)`): the old cache — including its token dictionary — is
released with it, so there is no global state to clear.

## Configuration: `PivotConfiguration`

A `PivotConfiguration` (the "report") is fully serializable:

```ts
interface PivotConfiguration {
  dataSource: DataSourceConfig;   // required: where the data comes from
  slice?: Slice;                  // the report definition (rows/columns/measures/...)
  options?: PivotOptions;         // grid + behavior options
  formats?: NumberFormat[];       // named number formats
  conditions?: ConditionalFormat[]; // conditional cell styling
  localization?: Localization;    // captions / labels
}
```

### `dataSource`

Exactly one source should be provided:

```ts
interface DataSourceConfig {
  data?: DataRecord[];      // in-memory array of objects
  matrix?: DataValue[][];   // array-of-arrays; first row is the header
  csv?: string;             // raw CSV text (parsed via parseCsv)
  csvOptions?: CsvParseOptions;
  mapping?: FieldMap;       // per-field caption/type/format/dateParts overrides
}
```

`mapping` lets you override a field's `caption`, logical `type`, default
`aggregation`/`format`, mark a numeric field as measure-only (`isMeasure`), hide
it (`visible: false`), or expand a date field into `dateParts` (a single date
field becomes a hierarchy such as `Date.year > Date.quarter > Date.month`).

### `slice`

```ts
interface Slice {
  rows?: SliceField[];          // row dimensions
  columns?: SliceField[];       // column dimensions
  measures?: MeasureConfig[];   // values
  reportFilters?: SliceField[]; // report-level filters
  expands?: ExpandsConfig;      // drilled-into member paths
  drills?: DrillsConfig;        // drilled-up member paths
  sorting?: SortingConfig;      // sort an axis by a measure's values
  flatSort?: Array<{ uniqueName: string; sort: SortDirection }>;
}
```

A `SliceField` is a dimension: `{ uniqueName, caption?, sort?, filter? }`. For a
date part use `field.part`, e.g. `{ uniqueName: 'Date.month' }`.

A `MeasureConfig` is a value:

```ts
interface MeasureConfig {
  uniqueName: string;        // source field, or a unique id for a calculated measure
  caption?: string;
  aggregation?: AggregationType; // ignored when `formula` is present
  showDataAs?: ShowDataAs;       // default 'raw'
  format?: string;               // name referencing a NumberFormat
  formula?: string;              // calculated-measure expression
  active?: boolean;              // set false to exclude from the grid
}
```

### `options`

```ts
interface PivotOptions {
  grid?: {
    type?: 'compact' | 'classic' | 'flat'; // default 'compact'
    showGrandTotals?: 'on' | 'off' | 'rows' | 'columns';
    showTotals?: 'on' | 'off' | 'rows' | 'columns'; // subtotals
    showHeaders?: boolean;
    showFilter?: boolean;
    title?: string;
  };
  defaultAggregation?: AggregationType; // used when a value has no aggregation
  virtualization?: boolean;
  drillThrough?: boolean;
  readOnly?: boolean;
  // ...plus configurator / date-pattern options
}
```

### `formats`

A list of named `NumberFormat` objects. A measure references one by `format`
name; the format named `''` is the default. Supports `decimalPlaces`,
`decimalSeparator`, `thousandsSeparator`, `currencySymbol` /
`currencySymbolAlign`, `isPercent`, `negativeFormat` (`'minus'` |
`'parentheses'` | `'redMinus'`), `nullValue`, `dateTimePattern`, `textAlign` and
more.

```ts
formats: [
  { name: '', decimalPlaces: 0, thousandsSeparator: ',' },
  { name: 'usd', currencySymbol: '$', currencySymbolAlign: 'left', decimalPlaces: 2 },
];
```

### `conditions`

Conditional cell styling. Each condition optionally targets a `measure`, applies
a `condition` comparison, and sets an inline `format` (`CellStyle`):

```ts
conditions: [
  {
    measure: 'Revenue',
    condition: { op: '>', value: 1000 },
    format: { backgroundColor: '#e6ffed', fontWeight: 'bold' },
  },
];
```

Condition operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `between` (`{ from, to }`),
`contains`, `isTrue`, `isFalse`.

### `localization`

Captions/labels such as `grandTotal`, `totalLabel` (`"{0} Total"`),
`blankMember`, `noData` and per-aggregation labels via `aggregations`.

## Aggregation types

`AggregationType` (used by `MeasureConfig.aggregation`,
`PivotOptions.defaultAggregation`, value filters, etc.):

| Type | Meaning |
| --- | --- |
| `sum` | Sum of numeric values |
| `count` | Count of records |
| `distinctCount` | Count of distinct values |
| `average` | Arithmetic mean |
| `median` | Median |
| `min` | Minimum |
| `max` | Maximum |
| `product` | Product of values |
| `first` | First value encountered |
| `last` | Last value encountered |
| `stdev` | Standard deviation (sample) |
| `stdevp` | Standard deviation (population) |
| `var` | Variance (sample) |
| `varp` | Variance (population) |
| `none` | Raw value (flat view / single record) |

Human-readable labels are available as the `AGGREGATION_LABELS` export, and
`createAggregator(type)` builds the reducer for a given type.

## Calculated measures

A measure with a `formula` is calculated from other aggregations rather than a
single source field. The aggregation arguments are evaluated per cell, so a
calculated measure is correct at every level (cells, subtotals, grand totals).

Grammar (whitespace-insensitive):

```
expr   := term (('+' | '-') term)*
term   := factor (('*' | '/') factor)*
factor := number | '(' expr ')' | '-' factor | call
call   := ident '(' [ string ] ')'
```

`ident` is an aggregation function; its string argument is the source field
(quoted with single or double quotes). `count()` may omit the field argument.

```ts
measures: [
  {
    uniqueName: 'grossRevenue',
    caption: 'Gross Revenue',
    formula: 'sum("price") * sum("quantity")',
  },
  {
    uniqueName: 'avgOrderValue',
    caption: 'Avg Order Value',
    formula: 'sum("revenue") / count()',
  },
];
```

Supported function names (case-insensitive, with aliases): `sum`, `count`,
`distinctCount`, `average` (`avg`, `mean`), `median`, `min`, `max`, `product`,
`first`, `last`, `stdev`, `stdevp`, `var`, `varp`. Division by zero and missing
operands evaluate to `null` (a blank cell). You can compile a formula directly
via the `compileFormula` export.

## `showDataAs` values

`MeasureConfig.showDataAs` post-processes the aggregated value once the full grid
exists (so it can reference totals, siblings and running sequences). Default is
`raw`.

| Value | Meaning |
| --- | --- |
| `raw` | Aggregated value, unchanged |
| `percentOfGrandTotal` | % of the grand total |
| `percentOfRowTotal` | % of the row total |
| `percentOfColumnTotal` | % of the column total |
| `percentOfParentRowTotal` | % of the parent row total |
| `percentOfParentColumnTotal` | % of the parent column total |
| `runningTotalInRow` | Running total across columns |
| `runningTotalInColumn` | Running total down rows |
| `rankInRow` | Rank within the row |
| `rankInColumn` | Rank within the column |
| `differenceFromPrevRow` | Difference from the previous row |
| `differenceFromPrevColumn` | Difference from the previous column |

Percentage variants are formatted as percentages automatically.

## Filters

Filters live on a `SliceField.filter` (member dimensions) or in
`reportFilters`. `FieldFilter` is one of four kinds, discriminated by `type`:

### `members` — explicit include/exclude

```ts
{ type: 'members', include: ['USA', 'UK'] }
{ type: 'members', exclude: ['Other'] }   // ignored when `include` is present
```

### `value` — top/bottom N or numeric threshold by a measure

```ts
{ type: 'value', measure: 'Revenue', query: { op: 'top', count: 5 } }
{ type: 'value', measure: 'Revenue', query: { op: 'greater', value: 1000 } }
```

`query.op` is one of: `top` / `bottom` (`{ count }`), `equal`, `notEqual`,
`greater`, `greaterEqual`, `less`, `lessEqual` (`{ value }`), `between` /
`notBetween` (`{ from, to }`).

### `label` — string predicate on member captions

```ts
{ type: 'label', query: { op: 'contains', value: 'Bike' } }
```

`query.op` is one of: `contains`, `notContains`, `beginsWith`, `endsWith`,
`equal`, `notEqual`, `regex`.

### `query` — arbitrary predicate (date/numeric ranges on members)

```ts
{ type: 'query', query: { /* field -> value map */ } }
```

## Exports

The package re-exports the full type contract plus the engine and building
blocks. Key exports:

- `PivotEngine`, type `Axis`
- `buildGrid`
- `Dataset`, `compareValues`, type `FieldInfo`
- `createAggregator`, `AGGREGATION_LABELS`, type `Aggregator`
- `formatValue`, `formatDate`, `resolveFormat`, `DEFAULT_FORMAT`
- `compileFormula`, types `CompiledFormula`, `AggRef`, `AggResolver`
- `resolveCellStyle`
- date-part helpers: `datePartValue`, `datePartCaption`, `toDate`,
  `MONTH_NAMES`, `WEEKDAY_NAMES`
- data helpers: `parseCsv`, `parseCsvToMatrix`, `inferFieldType`,
  `normalizeValue`, `discoverFields`
- tree helpers: `buildMemberTree`, `prefixKeys`, `pathKey`, `valueToken`,
  `Interner`, `flatten`, `flattenCompact`, `flattenClassic`,
  `flattenFlat` and types `MemberNode`, `PathSeg`, `VisibleNode`
- `EventEmitter`

All public types (`PivotConfiguration`, `Slice`, `MeasureConfig`,
`AggregationType`, `ShowDataAs`, `FieldFilter`, `PivotGrid`, `PivotCell`,
`HeaderNode`, etc.) are exported from the package root.

Path keys intern distinct member tokens into a compact shared dictionary (an
`Interner`). Each `Dataset` owns its own interner and reuses it across rebuilds, so
reconfiguration stays cheap; the dictionary is released with the `Dataset` (a data
refresh builds a new one), so there is no process-global cache to leak.

## Related packages

- `@pvotly/web` — framework-agnostic web renderer
- `@pvotly/react` — React wrapper

## License

MIT
