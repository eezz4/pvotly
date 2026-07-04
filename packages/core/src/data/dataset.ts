import type {
  AggregationType,
  DataRecord,
  DataSourceConfig,
  DataValue,
  DatePart,
  FieldMapping,
  FieldType,
} from '../types';
import { datePartCaption, datePartValue, toDate } from '../engine/dateParts';
import { Interner } from '../engine/tree';
import { parseCsv } from './parseCSV';
import { discoverFields, inferFieldType, normalizeValue } from './inferTypes';

const DATE_PARTS: DatePart[] = [
  'year',
  'quarter',
  'month',
  'monthName',
  'week',
  'dayOfMonth',
  'weekday',
  'date',
  'hour',
  'minute',
  'second',
];
const DATE_PART_SET = new Set<string>(DATE_PARTS);

export interface FieldInfo {
  /** Identity used by the slice config: base field, or `field.part`. */
  uniqueName: string;
  /** Underlying source field name. */
  field: string;
  /** Date part, when this is a derived date field. */
  part?: DatePart;
  caption: string;
  type: FieldType;
  /** Numeric field usable on the Values axis. */
  isMeasure: boolean;
  /** Usable as a row/column/filter dimension. */
  isDimension: boolean;
  /** For a base date field: the parts it can expand into. */
  dateParts?: DatePart[];
  /** Default aggregation when dropped into Values. */
  aggregation?: AggregationType;
  /** Default number-format name. */
  format?: string;
}

interface ParsedName {
  field: string;
  part?: DatePart;
}

/**
 * Normalized, queryable view over a data source. Owns type inference, value
 * normalization, date-part resolution, member enumeration and captions.
 */
export class Dataset {
  readonly records: DataRecord[];
  private readonly mapping: Record<string, FieldMapping>;
  private readonly types = new Map<string, FieldType>();
  private readonly fieldOrder: string[];
  private readonly memberCache = new Map<string, DataValue[]>();
  private readonly valueColumns = new Map<string, DataValue[]>();
  private readonly tokenColumns = new Map<string, string[]>();
  /**
   * Member-token dictionary for this dataset's path keys. Owned here (not a
   * process-global), so it is released with the dataset and a refresh that builds
   * a new `Dataset` starts from a clean dictionary — no leak, no cross-dataset
   * desync. Used by {@link tokenColumn} and by `buildGrid`'s {@link pathKey} calls.
   */
  readonly interner = new Interner();

  constructor(config: DataSourceConfig) {
    this.mapping = config.mapping ?? {};
    const raw = Dataset.extractRecords(config);
    this.fieldOrder = discoverFields(raw);

    // Resolve a type per field (mapping override wins over inference).
    for (const field of this.fieldOrder) {
      const override = this.mapping[field]?.type;
      this.types.set(field, override ?? inferFieldType(raw, field));
    }

    // Normalize every value to its resolved type once, up front.
    this.records = raw.map((record) => {
      const out: DataRecord = {};
      for (const field of this.fieldOrder) {
        out[field] = normalizeValue(record[field], this.types.get(field)!);
      }
      return out;
    });
  }

  private static extractRecords(config: DataSourceConfig): DataRecord[] {
    if (config.data) return config.data;
    if (config.csv != null) return parseCsv(config.csv, config.csvOptions);
    if (config.matrix && config.matrix.length) {
      const [header, ...rows] = config.matrix;
      const keys = header!.map((h) => String(h));
      return rows.map((row) => {
        const rec: DataRecord = {};
        keys.forEach((k, i) => {
          rec[k] = row[i] ?? null;
        });
        return rec;
      });
    }
    return [];
  }

  /** Split `field.part` into its components, validating the part. */
  parseName(uniqueName: string): ParsedName {
    const dot = uniqueName.lastIndexOf('.');
    if (dot > 0) {
      const maybePart = uniqueName.slice(dot + 1);
      const base = uniqueName.slice(0, dot);
      if (DATE_PART_SET.has(maybePart) && this.types.has(base)) {
        return { field: base, part: maybePart as DatePart };
      }
    }
    return { field: uniqueName };
  }

  fieldType(field: string): FieldType {
    return this.types.get(field) ?? 'string';
  }

  /** Resolve the value of a (possibly derived) field for one record. */
  resolveValue(record: DataRecord, uniqueName: string): DataValue {
    const { field, part } = this.parseName(uniqueName);
    const raw = record[field];
    if (part) {
      const d = toDate(raw);
      return d ? datePartValue(d, part) : null;
    }
    return raw ?? null;
  }

  /** Display caption for a member value of a given field. */
  memberCaption(uniqueName: string, value: DataValue): string {
    const { part } = this.parseName(uniqueName);
    if (value == null) return this.mapping[uniqueName]?.caption ? '' : '(blank)';
    if (part) return datePartCaption(value, part);
    if (value instanceof Date) return value.toLocaleDateString();
    return String(value);
  }

  /** Caption for the field itself (header label). */
  fieldCaption(uniqueName: string): string {
    const explicit = this.mapping[uniqueName]?.caption;
    if (explicit) return explicit;
    const { field, part } = this.parseName(uniqueName);
    const baseCaption = this.mapping[field]?.caption ?? field;
    if (part) {
      const partLabel = part.charAt(0).toUpperCase() + part.slice(1);
      return `${baseCaption} (${partLabel})`;
    }
    return baseCaption;
  }

  /**
   * Pivot cache — resolved values for a field, one per source record, computed
   * once and reused across every `buildGrid` call (reconfiguration skips the
   * re-scan / date-part resolution). Invalidate by creating a new `Dataset`.
   */
  resolvedColumn(uniqueName: string): DataValue[] {
    let col = this.valueColumns.get(uniqueName);
    if (!col) {
      col = this.records.map((r) => this.resolveValue(r, uniqueName));
      this.valueColumns.set(uniqueName, col);
    }
    return col;
  }

  /**
   * Pivot cache — interned member-token codes for a field, one per record. These
   * are the codes path keys are built from, so an accumulation/tree build reads
   * them directly instead of re-tokenizing every record on each build.
   */
  tokenColumn(uniqueName: string): string[] {
    let col = this.tokenColumns.get(uniqueName);
    if (!col) {
      col = this.resolvedColumn(uniqueName).map((v) => this.interner.token(v));
      this.tokenColumns.set(uniqueName, col);
    }
    return col;
  }

  /** Distinct, sorted member values for a field. */
  getMembers(uniqueName: string): DataValue[] {
    if (this.memberCache.has(uniqueName)) return this.memberCache.get(uniqueName)!;
    const seen = new Set<DataValue>();
    const members: DataValue[] = [];
    for (const record of this.records) {
      const v = this.resolveValue(record, uniqueName);
      const key = v instanceof Date ? v.getTime() : v;
      if (!seen.has(key as DataValue)) {
        seen.add(key as DataValue);
        members.push(v);
      }
    }
    members.sort(compareValues);
    this.memberCache.set(uniqueName, members);
    return members;
  }

  /** Field-list metadata for every available (and derived) field. */
  listFields(): FieldInfo[] {
    const out: FieldInfo[] = [];
    for (const field of this.fieldOrder) {
      const mapping = this.mapping[field];
      if (mapping?.visible === false) continue;
      const type = this.types.get(field)!;
      const isNumber = type === 'number';
      const baseInfo: FieldInfo = {
        uniqueName: field,
        field,
        caption: this.fieldCaption(field),
        type,
        isMeasure: mapping?.isMeasure ?? isNumber,
        isDimension: !(mapping?.isMeasure === true),
        dateParts: undefined,
        aggregation: mapping?.aggregation,
        format: mapping?.format,
      };
      if ((type === 'date' || type === 'datetime') && mapping?.dateParts?.length) {
        baseInfo.dateParts = mapping.dateParts;
        out.push(baseInfo);
        for (const part of mapping.dateParts) {
          const uniqueName = `${field}.${part}`;
          out.push({
            uniqueName,
            field,
            part,
            caption: this.fieldCaption(uniqueName),
            type: part === 'monthName' || part === 'date' ? 'string' : 'number',
            isMeasure: false,
            isDimension: true,
          });
        }
      } else {
        out.push(baseInfo);
      }
    }
    return out;
  }

  get fields(): string[] {
    return [...this.fieldOrder];
  }
}

/** Total ordering across mixed primitive/date values (nulls last). */
export function compareValues(a: DataValue, b: DataValue): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  if (typeof av === 'boolean' && typeof bv === 'boolean') return av === bv ? 0 : av ? 1 : -1;
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
}
