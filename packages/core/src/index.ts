/**
 * @pvotly/core — framework-agnostic pivot table engine.
 *
 * @example
 * ```ts
 * import { PivotEngine } from '@pvotly/core';
 *
 * const engine = new PivotEngine({
 *   dataSource: { data: records },
 *   slice: {
 *     rows: [{ uniqueName: 'Country' }],
 *     columns: [{ uniqueName: 'Category' }],
 *     measures: [{ uniqueName: 'Revenue', aggregation: 'sum' }],
 *   },
 * });
 * const grid = engine.getGrid();
 * ```
 */

export * from './types';

// Core orchestrator + data model
export { PivotEngine } from './engine/PivotEngine';
export type { Axis } from './engine/PivotEngine';
export { Dataset, compareValues } from './data/dataset';
export type { FieldInfo } from './data/dataset';

// Pure builder (use directly for one-shot, stateless rendering)
export { buildGrid } from './engine/build';

// Building blocks (handy for advanced/custom usage)
export {
  createAggregator,
  createCustomAggregator,
  registerAggregator,
  unregisterAggregator,
  getAggregatorRegistry,
  resolveAggregator,
  isBuiltinAggregation,
  AGGREGATION_LABELS,
} from './engine/aggregate';
export type { Aggregator, AggregatorRegistry } from './engine/aggregate';
export { formatValue, formatDate, formatDateIntl, resolveFormat, DEFAULT_FORMAT } from './engine/format';
export { compileFormula } from './engine/calculated';
export type { CompiledFormula, AggRef, AggResolver } from './engine/calculated';
export { resolveCellStyle } from './engine/conditional';
export { datePartValue, datePartCaption, toDate, MONTH_NAMES, WEEKDAY_NAMES } from './engine/dateParts';
export { parseCsv, parseCsvToMatrix } from './data/parseCSV';
export { inferFieldType, normalizeValue, discoverFields } from './data/inferTypes';
export { EventEmitter } from './events';

// Grid (de)serialization (Web Worker / network transfer)
export { serializeGrid, deserializeGrid } from './engine/serialize';
export type { SerializedGrid } from './engine/serialize';
export type { WorkerRequestMessage, WorkerResponseMessage } from './engine/workerProtocol';

// Data sources: remote / async / spreadsheet / archive
export { loadRemote, dataSourceFromUrl } from './data/remote';
export type { RemoteFormat, RemoteOptions } from './data/remote';
export { loadDataSource, loadRemoteSource, isAsyncSource } from './data/source';
export { parseXlsx, sheetToRecords } from './data/spreadsheet';
export type { SheetToRecordsOptions } from './data/spreadsheet';
export { unzip } from './data/zip';
export type { ZipEntry } from './data/zip';
export { inflateRaw } from './data/inflate';

// Tree primitives (for renderers that walk the header hierarchy)
export {
  buildMemberTree,
  prefixKeys,
  pathKey,
  valueToken,
  Interner,
  flatten,
  flattenCompact,
  flattenClassic,
  flattenFlat,
} from './engine/tree';
export type { MemberNode, PathSeg, VisibleNode } from './engine/tree';
