import type {
  AggregationName,
  DataValue,
  GridType,
  MeasureConfig,
  NumberFormat,
  PivotCell,
  PivotConfiguration,
  PivotGrid,
  HeaderNode,
  SliceField,
  ValueFilter,
} from '../types';
import { Dataset, compareValues } from '../data/dataset';
import { Aggregator, AggregatorRegistry, createAggregator } from './aggregate';
import { compileFormula, CompiledFormula } from './calculated';
import { resolveCellStyle } from './conditional';
import { formatValue, resolveFormat } from './format';
import { buildRecordPredicate, combinePredicates, RecordPredicate } from './filter';
import {
  Interner,
  MemberNode,
  PathSeg,
  VisibleNode,
  buildMemberTreeFromColumns,
  computeLeafCount,
  flatten,
  pathKey,
  prefixTokenKeys,
} from './tree';

interface EffectiveMeasure {
  uniqueName: string;
  caption: string;
  aggregation: AggregationName;
  showDataAs: NonNullable<MeasureConfig['showDataAs']>;
  format?: NumberFormat;
  compiled?: CompiledFormula;
  raw: MeasureConfig;
}

interface AxisEntry {
  node: MemberNode;
  level: number;
  isSubtotal: boolean;
  isGrandTotal: boolean;
  expanded: boolean;
}

const PERCENT_FORMAT: NumberFormat = { name: '__pct', isPercent: true, decimalPlaces: 2 };

/**
 * Shared, frozen cell returned for every empty (null-valued) intersection. A pivot
 * `body` is mostly empty at any real cardinality, so serving one immutable
 * singleton for blank cells — instead of allocating a distinct {@link PivotCell}
 * each — bounds heap by the *non-empty* cells while keeping `body`'s dense shape.
 * Cells that hold a real value (including `0` / `false`) are always their own cell.
 */
const EMPTY_CELL: PivotCell = Object.freeze({
  value: null,
  displayValue: null,
  formatted: '',
  measure: '',
  rowPath: [],
  columnPath: [],
  isTotal: false,
  isGrandTotal: false,
});

/**
 * "Show value as" transforms that write a carried value (running sum, rank,
 * prev-delta) onto *empty* intersections too. A measure using one needs a real,
 * mutable cell at its empty intersections — see {@link needsRealEmptyCells}.
 */
const SEQUENCE_SHOW_AS: ReadonlySet<string> = new Set([
  'runningTotalInRow',
  'runningTotalInColumn',
  'rankInRow',
  'rankInColumn',
  'differenceFromPrevRow',
  'differenceFromPrevColumn',
]);

/**
 * A measure needs a real {@link PivotCell} (not the shared {@link EMPTY_CELL}) at
 * its empty intersections when something must be written onto / rendered for those
 * blanks: a sequence-based show-as carries a value onto them, or a format-level
 * `nullValue` renders text for them. Otherwise blank cells share EMPTY_CELL.
 */
function needsRealEmptyCells(m: EffectiveMeasure): boolean {
  return SEQUENCE_SHOW_AS.has(m.showDataAs) || !!m.format?.nullValue;
}

function aggKeyOf(aggregation: AggregationName, field: string | null): string {
  return `${aggregation}::${field ?? ''}`;
}

/** Build the fully computed pivot grid for a dataset + configuration. */
export function buildGrid(dataset: Dataset, config: PivotConfiguration): PivotGrid {
  const slice = config.slice ?? {};
  const options = config.options ?? {};
  const gridOpts = options.grid ?? {};
  const type: GridType = gridOpts.type ?? 'compact';
  // Measure layout: top-level `valuesAxis` wins, else the grid option, else columns.
  const valuesAxis: 'columns' | 'rows' = config.valuesAxis ?? gridOpts.measurePosition ?? 'columns';
  // Grid-wide locale fallback for the Intl formatting layer.
  const locale = options.locale ?? config.locale;
  // Per-report custom aggregators override globally-registered ones.
  const customRegistry: AggregatorRegistry | undefined = config.customAggregators
    ? new Map(Object.entries(config.customAggregators))
    : undefined;

  const rowFields = (slice.rows ?? []).map((f) => f.uniqueName);
  const colFields = (slice.columns ?? []).map((f) => f.uniqueName);
  const rowSlice = slice.rows ?? [];
  const colSlice = slice.columns ?? [];

  const formatsMap = new Map<string, NumberFormat>();
  for (const f of config.formats ?? []) formatsMap.set(f.name, f);

  const defaultAggregation: AggregationName = options.defaultAggregation ?? 'sum';
  const measures = resolveMeasures(slice.measures ?? [], defaultAggregation, formatsMap, dataset);
  // This dataset's member-token dictionary. The same interner feeds both the
  // cached token columns and every pathKey() below, so the keys line up.
  const interner = dataset.interner;

  /* ---- 1. record-level filtering ------------------------------------- */
  const predicates: RecordPredicate[] = [];
  for (const f of [...rowSlice, ...colSlice, ...(slice.reportFilters ?? [])]) {
    if (f.filter) predicates.push(buildRecordPredicate(dataset, f.uniqueName, f.filter));
  }
  const predicate = combinePredicates(predicates);
  // Filter to record indices so the cached pivot-cache columns can be read by
  // position (the columns are addressed by source-record index).
  const allRecords = dataset.records;
  const keep: number[] = [];
  for (let i = 0; i < allRecords.length; i++) {
    if (predicate(allRecords[i]!)) keep.push(i);
  }

  /* ---- 2. base aggregation plan -------------------------------------- */
  const baseAggs = new Map<string, { aggregation: AggregationName; field: string | null }>();
  const addAgg = (aggregation: AggregationName, field: string | null) => {
    baseAggs.set(aggKeyOf(aggregation, field), { aggregation, field });
  };
  for (const m of measures) {
    if (m.compiled) {
      for (const ref of m.compiled.references) addAgg(ref.aggregation, ref.field);
    } else {
      addAgg(m.aggregation, m.uniqueName);
    }
  }
  const collectFieldFilterAggs = (fields: SliceField[]) => {
    for (const f of fields) {
      if (f.filter?.type === 'value') {
        addAgg(f.filter.aggregation ?? measureAggregation(measures, f.filter.measure), f.filter.measure);
      }
    }
  };
  collectFieldFilterAggs(rowSlice);
  collectFieldFilterAggs(colSlice);
  if (slice.sorting?.row) {
    addAgg(measureAggregation(measures, slice.sorting.row.measure), slice.sorting.row.measure);
  }
  if (slice.sorting?.column) {
    addAgg(measureAggregation(measures, slice.sorting.column.measure), slice.sorting.column.measure);
  }

  /* ---- 3. accumulate cross-tab buckets over every prefix ------------- */
  // Pivot-cache columns (resolved values + interned token codes), computed once
  // on the Dataset and reused across builds — reconfiguration no longer re-scans
  // or re-tokenizes the source records.
  const rowTokenCols = rowFields.map((f) => dataset.tokenColumn(f));
  const colTokenCols = colFields.map((f) => dataset.tokenColumn(f));
  const rowValueCols = rowFields.map((f) => dataset.resolvedColumn(f));
  const colValueCols = colFields.map((f) => dataset.resolvedColumn(f));
  const aggValueCols = new Map<string, DataValue[]>();
  for (const [, { field }] of baseAggs) {
    if (field && !aggValueCols.has(field)) aggValueCols.set(field, dataset.resolvedColumn(field));
  }

  const cells = new Map<string, Map<string, Map<string, Aggregator>>>();
  const makeBucket = (): Map<string, Aggregator> => {
    const m = new Map<string, Aggregator>();
    for (const [key, { aggregation }] of baseAggs) m.set(key, createAggregator(aggregation, customRegistry));
    return m;
  };
  for (const i of keep) {
    const record = allRecords[i]!;
    const rKeys = prefixTokenKeys(rowTokenCols.map((c) => c[i]!));
    const cKeys = prefixTokenKeys(colTokenCols.map((c) => c[i]!));
    for (const rk of rKeys) {
      let rowMap = cells.get(rk);
      if (!rowMap) {
        rowMap = new Map();
        cells.set(rk, rowMap);
      }
      for (const ck of cKeys) {
        let bucket = rowMap.get(ck);
        if (!bucket) {
          bucket = makeBucket();
          rowMap.set(ck, bucket);
        }
        for (const [key, { field }] of baseAggs) {
          bucket.get(key)!.push(field ? (aggValueCols.get(field)![i] ?? null) : null, record);
        }
      }
    }
  }

  const rawAggAt = (rowKey: string, colKey: string, aggregation: AggregationName, field: string | null) => {
    const agg = cells.get(rowKey)?.get(colKey)?.get(aggKeyOf(aggregation, field));
    return agg ? agg.value() : null;
  };
  const numericAggAt = (rowKey: string, colKey: string, aggregation: AggregationName, field: string | null) => {
    const v = rawAggAt(rowKey, colKey, aggregation, field);
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const measureRaw = (rowKey: string, colKey: string, m: EffectiveMeasure): number | DataValue => {
    if (m.compiled) return m.compiled.evaluate((a, f) => numericAggAt(rowKey, colKey, a, f));
    return rawAggAt(rowKey, colKey, m.aggregation, m.uniqueName);
  };
  const measureNumeric = (rowKey: string, colKey: string, m: EffectiveMeasure): number | null => {
    if (m.compiled) return m.compiled.evaluate((a, f) => numericAggAt(rowKey, colKey, a, f));
    return numericAggAt(rowKey, colKey, m.aggregation, m.uniqueName);
  };

  /* ---- 4. build + order member trees --------------------------------- */
  const rowRoots = buildMemberTreeFromColumns(keep, rowFields, rowTokenCols, rowValueCols, dataset);
  const colRoots = buildMemberTreeFromColumns(keep, colFields, colTokenCols, colValueCols, dataset);
  orderAxis(interner, rowRoots, rowSlice, 'row', measures, slice, numericAggAt);
  orderAxis(interner, colRoots, colSlice, 'column', measures, slice, numericAggAt);
  rowRoots.forEach(computeLeafCount);
  colRoots.forEach(computeLeafCount);

  /* ---- 5. expansion + flatten ---------------------------------------- */
  const expandedSet = pathSet(interner, slice.expands?.rows, slice.expands?.columns);
  const collapsedSet = pathSet(interner, slice.drills?.rows, slice.drills?.columns);
  const defaultExpanded =
    slice.expands?.expandAll === true ? true : slice.drills?.drillAll === true ? false : true;
  const isExpanded = (node: MemberNode) => {
    if (collapsedSet.has(node.key)) return false;
    if (expandedSet.has(node.key)) return true;
    return defaultExpanded;
  };

  const { rowsGT, colsGT } = grandTotalFlags(gridOpts.showGrandTotals);
  const { rowsSub, colsSub } = subtotalFlags(gridOpts.showTotals);

  const rowEntries = toEntries(
    rowFields.length ? flatten(rowRoots, type, isExpanded, rowsSub) : [],
    rowFields.length,
  );
  const colEntries = toEntries(
    colFields.length ? flatten(colRoots, type, isExpanded, colsSub) : [],
    colFields.length,
  );
  // Implicit single "all" line when an axis has no fields.
  if (!rowFields.length) rowEntries.push(allEntry());
  if (!colFields.length) colEntries.push(allEntry());
  // Grand totals.
  if (rowsGT && rowFields.length) rowEntries.push(grandTotalEntry(config));
  if (colsGT && colFields.length) colEntries.push(grandTotalEntry(config));

  /* ---- 6. body, show-as, formatting, conditions ---------------------- */
  const conditions = config.conditions;
  const cellIndex = new Map<string, PivotCell>();
  const body: PivotCell[][] = [];

  // Create (and index) a single body cell for a row/column/measure triple.
  const makeCell = (rowEntry: AxisEntry, colEntry: AxisEntry, m: EffectiveMeasure): PivotCell => {
    const rowKey = rowEntry.node.key;
    const colKey = colEntry.node.key;
    const value = measureRaw(rowKey, colKey, m);
    // Empty intersection -> the shared frozen cell, left out of the index, UNLESS
    // this measure must render/carry something on blanks (sequence show-as or a
    // nullValue format). Those get a real, indexed cell so the show-as / format
    // pass can fill it and getCell returns it; getCell synthesizes a blank on a
    // miss, so plain empty cells are unchanged for rendering.
    if (value == null && !needsRealEmptyCells(m)) return EMPTY_CELL;
    const cell: PivotCell = {
      value,
      displayValue: value,
      formatted: '',
      measure: m.uniqueName,
      rowPath: rowEntry.node.path,
      columnPath: colEntry.node.path,
      isTotal: rowEntry.isSubtotal || colEntry.isSubtotal,
      isGrandTotal: rowEntry.isGrandTotal || colEntry.isGrandTotal,
    };
    cellIndex.set(`${rowKey}|${colKey}|${m.uniqueName}`, cell);
    return cell;
  };

  if (valuesAxis === 'rows' && measures.length) {
    // Measures laid out along the row axis: each row leaf expands into one body
    // row per measure; every body row has exactly one cell per column leaf.
    for (const rowEntry of rowEntries) {
      for (const m of measures) {
        body.push(colEntries.map((colEntry) => makeCell(rowEntry, colEntry, m)));
      }
    }
  } else {
    // Measures laid out along the column axis (default): each body row has
    // `columnLeaves * measures` cells, measures innermost.
    for (const rowEntry of rowEntries) {
      const rowArr: PivotCell[] = [];
      for (const colEntry of colEntries) {
        for (const m of measures) rowArr.push(makeCell(rowEntry, colEntry, m));
      }
      body.push(rowArr);
    }
  }

  applyShowAs(
    rowEntries,
    colEntries,
    measures,
    cellIndex,
    measureNumeric,
  );

  // Format + conditional styling pass.
  for (const cell of cellIndex.values()) {
    const m = measures.find((mm) => mm.uniqueName === cell.measure)!;
    const isPercent = cell.measure && m.showDataAs.startsWith('percentOf');
    const fmt = isPercent ? PERCENT_FORMAT : m.format;
    cell.formatted = formatValue(cell.displayValue, fmt, locale);
    cell.style = resolveCellStyle(
      typeof cell.displayValue === 'number' ? cell.displayValue : cell.value,
      cell.measure,
      conditions,
    );
  }

  /* ---- 7. assemble public grid --------------------------------------- */
  const rowTree = rowRoots.map((n) => toHeaderNode(n, isExpanded));
  const columnTree = colRoots.map((n) => toHeaderNode(n, isExpanded));
  const rowLeaves = rowEntries.map((e) => entryToHeaderNode(e));
  const columnLeaves = colEntries.map((e) => entryToHeaderNode(e));

  const getCell = (rowNode: HeaderNode, colNode: HeaderNode, measure: MeasureConfig): PivotCell => {
    const rk = pathKey(interner, rowNode.path as PathSeg[]);
    const ck = pathKey(interner, colNode.path as PathSeg[]);
    const found = cellIndex.get(`${rk}|${ck}|${measure.uniqueName}`);
    if (found) return found;
    return {
      value: null,
      displayValue: null,
      formatted: '',
      measure: measure.uniqueName,
      rowPath: rowNode.path,
      columnPath: colNode.path,
      isTotal: false,
      isGrandTotal: false,
    };
  };

  return {
    rowTree,
    columnTree,
    rowLeaves,
    columnLeaves,
    measures: measures.map((m) => m.raw),
    getCell,
    body,
    meta: {
      type,
      rowFieldCount: rowFields.length,
      columnFieldCount: colFields.length,
      measureCount: measures.length,
      totalRows:
        valuesAxis === 'rows' ? rowEntries.length * Math.max(1, measures.length) : rowEntries.length,
      totalColumns:
        valuesAxis === 'rows' ? colEntries.length : colEntries.length * Math.max(1, measures.length),
      valuesAxis,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function resolveMeasures(
  configs: MeasureConfig[],
  defaultAggregation: AggregationName,
  formatsMap: Map<string, NumberFormat>,
  dataset: Dataset,
): EffectiveMeasure[] {
  return configs
    .filter((m) => m.active !== false)
    .map((m) => {
      let compiled: CompiledFormula | undefined;
      if (m.formula) {
        try {
          compiled = compileFormula(m.formula);
        } catch {
          compiled = undefined;
        }
      }
      const format = m.format ? formatsMap.get(m.format) : formatsMap.get('');
      return {
        uniqueName: m.uniqueName,
        caption: m.caption ?? dataset.fieldCaption(m.uniqueName),
        aggregation: m.aggregation ?? defaultAggregation,
        showDataAs: m.showDataAs ?? 'raw',
        format: format ? resolveFormat(format) : undefined,
        compiled,
        raw: m,
      };
    });
}

function measureAggregation(measures: EffectiveMeasure[], name: string): AggregationName {
  return measures.find((m) => m.uniqueName === name)?.aggregation ?? 'sum';
}

/** Order + value-filter the children of every node on an axis. */
function orderAxis(
  interner: Interner,
  roots: MemberNode[],
  axisFields: SliceField[],
  axis: 'row' | 'column',
  measures: EffectiveMeasure[],
  slice: PivotConfiguration['slice'] & object,
  numericAggAt: (r: string, c: string, a: AggregationName, f: string | null) => number | null,
): void {
  const valueSort = axis === 'row' ? slice.sorting?.row : slice.sorting?.column;
  const sortTupleKey = valueSort?.tuple ? pathKey(interner, valueSort.tuple as PathSeg[]) : '';

  const orderSiblings = (siblings: MemberNode[], level: number): MemberNode[] => {
    const field = axisFields[level];
    let nodes = [...siblings];

    if (valueSort) {
      const measureAgg = measureAggregation(measures, valueSort.measure);
      const dir = valueSort.direction === 'desc' ? -1 : 1;
      nodes.sort((a, b) => {
        const av =
          axis === 'row'
            ? numericAggAt(a.key, sortTupleKey, measureAgg, valueSort.measure)
            : numericAggAt(sortTupleKey, a.key, measureAgg, valueSort.measure);
        const bv =
          axis === 'row'
            ? numericAggAt(b.key, sortTupleKey, measureAgg, valueSort.measure)
            : numericAggAt(sortTupleKey, b.key, measureAgg, valueSort.measure);
        return ((av ?? 0) - (bv ?? 0)) * dir;
      });
    } else {
      const dir = field?.sort === 'desc' ? -1 : 1;
      if (field?.sort !== 'unsorted') {
        nodes.sort((a, b) => compareValues(a.value, b.value) * dir);
      }
    }

    if (field?.filter?.type === 'value') {
      nodes = applyValueFilter(nodes, field.filter, axis, measures, numericAggAt);
    }
    return nodes;
  };

  const walk = (nodes: MemberNode[], level: number) => {
    const ordered = orderSiblings(nodes, level);
    for (const node of ordered) {
      node.orderedChildren = walk([...node.children.values()], level + 1);
    }
    return ordered;
  };

  const orderedRoots = walk(roots, 0);
  roots.length = 0;
  roots.push(...orderedRoots);
}

function applyValueFilter(
  nodes: MemberNode[],
  filter: ValueFilter,
  axis: 'row' | 'column',
  measures: EffectiveMeasure[],
  numericAggAt: (r: string, c: string, a: AggregationName, f: string | null) => number | null,
): MemberNode[] {
  const agg = filter.aggregation ?? measureAggregation(measures, filter.measure);
  const valueOf = (node: MemberNode) =>
    axis === 'row'
      ? numericAggAt(node.key, '', agg, filter.measure)
      : numericAggAt('', node.key, agg, filter.measure);
  const q = filter.query;
  switch (q.op) {
    case 'top':
      return [...nodes].sort((a, b) => (valueOf(b) ?? -Infinity) - (valueOf(a) ?? -Infinity)).slice(0, q.count);
    case 'bottom':
      return [...nodes].sort((a, b) => (valueOf(a) ?? Infinity) - (valueOf(b) ?? Infinity)).slice(0, q.count);
    default:
      return nodes.filter((n) => {
        const v = valueOf(n);
        if (v == null) return false;
        switch (q.op) {
          case 'equal':
            return v === q.value;
          case 'notEqual':
            return v !== q.value;
          case 'greater':
            return v > q.value;
          case 'greaterEqual':
            return v >= q.value;
          case 'less':
            return v < q.value;
          case 'lessEqual':
            return v <= q.value;
          case 'between':
            return v >= q.from && v <= q.to;
          case 'notBetween':
            return v < q.from || v > q.to;
          default:
            return true;
        }
      });
  }
}

/** "Show value as" transforms applied to the already-computed cells. */
function applyShowAs(
  rowEntries: AxisEntry[],
  colEntries: AxisEntry[],
  measures: EffectiveMeasure[],
  cellIndex: Map<string, PivotCell>,
  measureNumeric: (r: string, c: string, m: EffectiveMeasure) => number | null,
): void {
  // Running totals, ranks and prev-deltas must skip *subtotal* lines: a subtotal
  // is the aggregate of the leaves around it, so folding it into the accumulator
  // (or ranking it against its own children) double-counts those leaves. The
  // grand-total line is intentionally retained as a final accumulating/ranked
  // entry (see build.showas.test.ts).
  const dataRows = rowEntries.filter((e) => !e.isSubtotal);
  const dataCols = colEntries.filter((e) => !e.isSubtotal);

  for (const m of measures) {
    if (m.showDataAs === 'raw') continue;
    const grand = measureNumeric('', '', m);

    if (m.showDataAs === 'percentOfGrandTotal') {
      for (const r of rowEntries)
        for (const c of colEntries) {
          const cell = cellIndex.get(`${r.node.key}|${c.node.key}|${m.uniqueName}`);
          if (cell) cell.displayValue = ratio(measureNumeric(r.node.key, c.node.key, m), grand);
        }
    } else if (m.showDataAs === 'percentOfRowTotal') {
      for (const r of rowEntries) {
        const rowTotal = measureNumeric(r.node.key, '', m);
        for (const c of colEntries) {
          const cell = cellIndex.get(`${r.node.key}|${c.node.key}|${m.uniqueName}`);
          if (cell) cell.displayValue = ratio(measureNumeric(r.node.key, c.node.key, m), rowTotal);
        }
      }
    } else if (m.showDataAs === 'percentOfColumnTotal') {
      for (const c of colEntries) {
        const colTotal = measureNumeric('', c.node.key, m);
        for (const r of rowEntries) {
          const cell = cellIndex.get(`${r.node.key}|${c.node.key}|${m.uniqueName}`);
          if (cell) cell.displayValue = ratio(measureNumeric(r.node.key, c.node.key, m), colTotal);
        }
      }
    } else if (m.showDataAs === 'runningTotalInColumn') {
      for (const c of dataCols) {
        let acc = 0;
        for (const r of dataRows) {
          const v = measureNumeric(r.node.key, c.node.key, m) ?? 0;
          acc += v;
          const cell = cellIndex.get(`${r.node.key}|${c.node.key}|${m.uniqueName}`);
          if (cell) cell.displayValue = acc;
        }
      }
    } else if (m.showDataAs === 'runningTotalInRow') {
      for (const r of dataRows) {
        let acc = 0;
        for (const c of dataCols) {
          const v = measureNumeric(r.node.key, c.node.key, m) ?? 0;
          acc += v;
          const cell = cellIndex.get(`${r.node.key}|${c.node.key}|${m.uniqueName}`);
          if (cell) cell.displayValue = acc;
        }
      }
    } else if (m.showDataAs === 'rankInColumn') {
      for (const c of dataCols) rankSequence(dataRows, c, m, cellIndex, measureNumeric, 'col');
    } else if (m.showDataAs === 'rankInRow') {
      for (const r of dataRows) rankSequence(dataCols, r, m, cellIndex, measureNumeric, 'row');
    } else if (m.showDataAs === 'differenceFromPrevColumn') {
      // For each row, step across columns: null in the first column.
      for (const r of dataRows) {
        let prev: number | null = null;
        for (const c of dataCols) {
          const v = measureNumeric(r.node.key, c.node.key, m);
          const cell = cellIndex.get(`${r.node.key}|${c.node.key}|${m.uniqueName}`);
          if (cell) cell.displayValue = prev == null || v == null ? null : v - prev;
          prev = v;
        }
      }
    } else if (m.showDataAs === 'differenceFromPrevRow') {
      // For each column, step down rows: null in the first row.
      for (const c of dataCols) {
        let prev: number | null = null;
        for (const r of dataRows) {
          const v = measureNumeric(r.node.key, c.node.key, m);
          const cell = cellIndex.get(`${r.node.key}|${c.node.key}|${m.uniqueName}`);
          if (cell) cell.displayValue = prev == null || v == null ? null : v - prev;
          prev = v;
        }
      }
    }
  }
}

function rankSequence(
  variable: AxisEntry[],
  fixed: AxisEntry,
  m: EffectiveMeasure,
  cellIndex: Map<string, PivotCell>,
  measureNumeric: (r: string, c: string, m: EffectiveMeasure) => number | null,
  mode: 'row' | 'col',
): void {
  const items = variable.map((v) => {
    const rk = mode === 'col' ? v.node.key : fixed.node.key;
    const ck = mode === 'col' ? fixed.node.key : v.node.key;
    return { v, value: measureNumeric(rk, ck, m) };
  });
  const sorted = [...items].filter((i) => i.value != null).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const rankMap = new Map<AxisEntry, number>();
  sorted.forEach((item, idx) => rankMap.set(item.v, idx + 1));
  for (const item of items) {
    const rk = mode === 'col' ? item.v.node.key : fixed.node.key;
    const ck = mode === 'col' ? fixed.node.key : item.v.node.key;
    const cell = cellIndex.get(`${rk}|${ck}|${m.uniqueName}`);
    if (cell) cell.displayValue = rankMap.get(item.v) ?? null;
  }
}

function ratio(value: number | null, total: number | null): number | null {
  if (value == null || total == null || total === 0) return null;
  return value / total;
}

type MemberPathList = Array<{ tuple: Array<{ uniqueName: string; value: DataValue }> }>;

function pathSet(interner: Interner, rows?: MemberPathList, columns?: MemberPathList): Set<string> {
  const set = new Set<string>();
  const add = (paths?: MemberPathList) => {
    for (const p of paths ?? []) set.add(pathKey(interner, p.tuple as PathSeg[]));
  };
  add(rows);
  add(columns);
  return set;
}

function grandTotalFlags(opt?: string): { rowsGT: boolean; colsGT: boolean } {
  if (opt === 'off') return { rowsGT: false, colsGT: false };
  if (opt === 'rows') return { rowsGT: true, colsGT: false };
  if (opt === 'columns') return { rowsGT: false, colsGT: true };
  return { rowsGT: true, colsGT: true };
}

function subtotalFlags(opt?: string): { rowsSub: boolean; colsSub: boolean } {
  if (opt === 'off') return { rowsSub: false, colsSub: false };
  if (opt === 'rows') return { rowsSub: true, colsSub: false };
  if (opt === 'columns') return { rowsSub: false, colsSub: true };
  return { rowsSub: true, colsSub: true };
}

function toEntries(visible: VisibleNode[], _fieldCount: number): AxisEntry[] {
  return visible.map((v) => ({
    node: v.node,
    level: v.node.level,
    isSubtotal: v.isSubtotal,
    isGrandTotal: false,
    expanded: v.expanded,
  }));
}

function allEntry(): AxisEntry {
  return {
    node: {
      uniqueName: '',
      value: null,
      caption: '',
      level: 0,
      path: [],
      key: '',
      children: new Map(),
      orderedChildren: [],
      leafCount: 1,
    },
    level: 0,
    isSubtotal: false,
    isGrandTotal: false,
    expanded: false,
  };
}

function grandTotalEntry(config: PivotConfiguration): AxisEntry {
  const caption = config.localization?.grandTotal ?? 'Grand Total';
  const entry = allEntry();
  entry.node.caption = caption;
  entry.isGrandTotal = true;
  return entry;
}

function toHeaderNode(node: MemberNode, isExpanded: (n: MemberNode) => boolean): HeaderNode {
  return {
    uniqueName: node.uniqueName,
    value: node.value,
    caption: node.caption,
    level: node.level,
    path: node.path,
    children: node.orderedChildren.map((c) => toHeaderNode(c, isExpanded)),
    expanded: node.orderedChildren.length > 0 && isExpanded(node),
    leafCount: node.leafCount,
  };
}

function entryToHeaderNode(entry: AxisEntry): HeaderNode {
  return {
    uniqueName: entry.node.uniqueName,
    value: entry.node.value,
    caption: entry.node.caption,
    level: entry.level,
    path: entry.node.path,
    children: [],
    expanded: entry.expanded,
    isTotal: entry.isSubtotal,
    isGrandTotal: entry.isGrandTotal,
    leafCount: entry.node.leafCount,
  };
}
