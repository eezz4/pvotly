import type {
  AggregationName,
  AggregationType,
  AggregatorDefinition,
  DataRecord,
  DataValue,
} from '../types';

/**
 * An aggregator consumes the values of a single measure for the records that
 * fall into one grid cell, then produces the aggregated result.
 *
 * `field` values are pushed for value-based reducers; `count` ignores the value
 * and simply tallies records.
 */
export interface Aggregator {
  push(value: DataValue, record: DataRecord): void;
  value(): number | DataValue;
  /**
   * Merge another aggregator's accumulated state into this one. Used during
   * bottom-up tree propagation to compute subtotals from leaf cells without
   * re-scanning raw records.
   *
   * The `this` parameter type means each implementation receives its own
   * concrete type, so it can read the other's private fields directly with no
   * cast or `instanceof`. Callers only ever merge aggregators built for the same
   * aggregation key (see `propagateAxis`), so the same-type invariant holds.
   */
  merge(other: this): void;
}

/**
 * Append every element of `src` to `dst` in place. Uses a loop, not
 * `dst.push(...src)`, because spreading a large array as call arguments overflows
 * the call stack (hit when merging multi-million-element median/variance buffers,
 * e.g. a grand-total subtotal or a parallel-reduce partial).
 */
function appendAll<T>(dst: T[], src: readonly T[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]!);
}

function asNumber(value: DataValue): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

class SumAggregator implements Aggregator {
  private sum = 0;
  private has = false;
  push(value: DataValue): void {
    const n = asNumber(value);
    if (n !== null) {
      this.sum += n;
      this.has = true;
    }
  }
  value(): number | null {
    return this.has ? this.sum : null;
  }
  merge(other: this): void {
    this.sum += other.sum;
    this.has ||= other.has;
  }
}

class CountAggregator implements Aggregator {
  private n = 0;
  push(): void {
    this.n += 1;
  }
  value(): number {
    return this.n;
  }
  merge(other: this): void {
    this.n += other.n;
  }
}

class DistinctCountAggregator implements Aggregator {
  private set = new Set<DataValue>();
  push(value: DataValue): void {
    if (value != null && value !== '') this.set.add(value);
  }
  value(): number {
    return this.set.size;
  }
  merge(other: this): void {
    other.set.forEach((v) => this.set.add(v));
  }
}

class AverageAggregator implements Aggregator {
  private sum = 0;
  private n = 0;
  push(value: DataValue): void {
    const v = asNumber(value);
    if (v !== null) {
      this.sum += v;
      this.n += 1;
    }
  }
  value(): number | null {
    return this.n ? this.sum / this.n : null;
  }
  merge(other: this): void {
    this.sum += other.sum;
    this.n += other.n;
  }
}

class MinAggregator implements Aggregator {
  private min: number | null = null;
  push(value: DataValue): void {
    const v = asNumber(value);
    if (v !== null) this.min = this.min === null ? v : Math.min(this.min, v);
  }
  value(): number | null {
    return this.min;
  }
  merge(other: this): void {
    if (other.min !== null) this.min = this.min === null ? other.min : Math.min(this.min, other.min);
  }
}

class MaxAggregator implements Aggregator {
  private max: number | null = null;
  push(value: DataValue): void {
    const v = asNumber(value);
    if (v !== null) this.max = this.max === null ? v : Math.max(this.max, v);
  }
  value(): number | null {
    return this.max;
  }
  merge(other: this): void {
    if (other.max !== null) this.max = this.max === null ? other.max : Math.max(this.max, other.max);
  }
}

class ProductAggregator implements Aggregator {
  private product = 1;
  private has = false;
  push(value: DataValue): void {
    const v = asNumber(value);
    if (v !== null) {
      this.product *= v;
      this.has = true;
    }
  }
  value(): number | null {
    return this.has ? this.product : null;
  }
  merge(other: this): void {
    if (other.has) {
      this.product *= other.product;
      this.has = true;
    }
  }
}

class MedianAggregator implements Aggregator {
  private values: number[] = [];
  push(value: DataValue): void {
    const v = asNumber(value);
    if (v !== null) this.values.push(v);
  }
  value(): number | null {
    if (!this.values.length) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  merge(other: this): void {
    appendAll(this.values, other.values);
  }
}

/** Population/sample variance + standard deviation share a numeric accumulator. */
class VarianceAggregator implements Aggregator {
  private values: number[] = [];
  constructor(
    private readonly mode: 'var' | 'varp' | 'stdev' | 'stdevp',
  ) {}
  push(value: DataValue): void {
    const v = asNumber(value);
    if (v !== null) this.values.push(v);
  }
  value(): number | null {
    const n = this.values.length;
    if (n === 0) return null;
    const sample = this.mode === 'var' || this.mode === 'stdev';
    if (sample && n < 2) return 0;
    const mean = this.values.reduce((a, b) => a + b, 0) / n;
    const ss = this.values.reduce((a, b) => a + (b - mean) ** 2, 0);
    const variance = ss / (sample ? n - 1 : n);
    return this.mode === 'stdev' || this.mode === 'stdevp' ? Math.sqrt(variance) : variance;
  }
  merge(other: this): void {
    appendAll(this.values, other.values);
  }
}

class FirstAggregator implements Aggregator {
  private first: DataValue = null;
  private set = false;
  push(value: DataValue): void {
    if (!this.set) {
      this.first = value;
      this.set = true;
    }
  }
  value(): DataValue {
    return this.first;
  }
  merge(other: this): void {
    if (!this.set && other.set) {
      this.first = other.first;
      this.set = true;
    }
  }
}

class LastAggregator implements Aggregator {
  private last: DataValue = null;
  push(value: DataValue): void {
    this.last = value;
  }
  value(): DataValue {
    return this.last;
  }
  merge(other: this): void {
    if (other.last !== null) this.last = other.last;
  }
}

/* -------------------------------------------------------------------------- */
/* Custom aggregators                                                         */
/* -------------------------------------------------------------------------- */

/** A name -> definition lookup for user-registered aggregators. */
export type AggregatorRegistry = Map<string, AggregatorDefinition>;

/** Process-wide registry of custom aggregators. */
const globalRegistry: AggregatorRegistry = new Map();

/**
 * Register a custom aggregator globally so it can be referenced by name from any
 * measure's `aggregation`. A per-report `customAggregators` map (passed via
 * {@link resolveAggregator}) overrides entries here.
 *
 * @returns an unregister function.
 */
export function registerAggregator(name: string, definition: AggregatorDefinition): () => void {
  globalRegistry.set(name, definition);
  return () => {
    if (globalRegistry.get(name) === definition) globalRegistry.delete(name);
  };
}

/** Remove a globally-registered aggregator by name. */
export function unregisterAggregator(name: string): void {
  globalRegistry.delete(name);
}

/** The shared global aggregator registry (for inspection/advanced use). */
export function getAggregatorRegistry(): AggregatorRegistry {
  return globalRegistry;
}

/** True when `name` is one of the 15 built-in aggregations. */
export function isBuiltinAggregation(name: string): name is AggregationType {
  return Object.prototype.hasOwnProperty.call(AGGREGATION_LABELS, name);
}

/**
 * Resolve a custom {@link AggregatorDefinition} by name, preferring the supplied
 * per-report registry over the global one.
 */
export function resolveAggregator(
  name: string,
  registry?: AggregatorRegistry,
): AggregatorDefinition | undefined {
  return registry?.get(name) ?? globalRegistry.get(name);
}

/**
 * Buffered values/records for custom aggregators, kept off the public object so
 * `merge()` can replay them without exposing internal state on the Aggregator.
 */
const customBuffers = new WeakMap<Aggregator, { values: DataValue[]; records: DataRecord[] }>();

/** Adapt an {@link AggregatorDefinition} (streaming or batch) to an {@link Aggregator}. */
export function createCustomAggregator(definition: AggregatorDefinition): Aggregator {
  const values: DataValue[] = [];
  const records: DataRecord[] = [];

  // Streaming form takes priority when a reducer is provided.
  if (typeof definition.reduce === 'function') {
    const reduce = definition.reduce;
    const finalize = definition.finalize;
    let acc: unknown = definition.init ? definition.init() : undefined;
    const agg: Aggregator = {
      push(value, record) {
        acc = reduce(acc, value, record);
        values.push(value);
        records.push(record);
      },
      value() {
        return finalize ? finalize(acc) : (acc as number | DataValue);
      },
      // Replay the other aggregator's buffered input through our reducer so the
      // streaming accumulator stays correct after a merge.
      merge(other) {
        const buf = customBuffers.get(other);
        if (!buf) return;
        for (let i = 0; i < buf.values.length; i++) {
          acc = reduce(acc, buf.values[i]!, buf.records[i]!);
          values.push(buf.values[i]!);
          records.push(buf.records[i]!);
        }
      },
    };
    customBuffers.set(agg, { values, records });
    return agg;
  }

  // Batch form: collect values/records, evaluate once.
  const evaluate = definition.evaluate;
  const agg: Aggregator = {
    push(value, record) {
      values.push(value);
      records.push(record);
    },
    value() {
      return evaluate ? evaluate(values, records) : null;
    },
    merge(other) {
      const buf = customBuffers.get(other);
      if (!buf) return;
      appendAll(values, buf.values);
      appendAll(records, buf.records);
    },
  };
  customBuffers.set(agg, { values, records });
  return agg;
}

/**
 * Factory: build the right aggregator for a measure's aggregation. Built-in
 * names map to their reducer; any other name is resolved against `registry`
 * (per-report) then the global registry. Unknown names fall back to `sum`.
 */
export function createAggregator(
  type: AggregationName,
  registry?: AggregatorRegistry,
): Aggregator {
  switch (type) {
    case 'sum':
      return new SumAggregator();
    case 'count':
      return new CountAggregator();
    case 'distinctCount':
      return new DistinctCountAggregator();
    case 'average':
      return new AverageAggregator();
    case 'median':
      return new MedianAggregator();
    case 'min':
      return new MinAggregator();
    case 'max':
      return new MaxAggregator();
    case 'product':
      return new ProductAggregator();
    case 'stdev':
    case 'stdevp':
    case 'var':
    case 'varp':
      return new VarianceAggregator(type as 'var' | 'varp' | 'stdev' | 'stdevp');
    case 'first':
      return new FirstAggregator();
    case 'last':
    case 'none':
      return new LastAggregator();
    default: {
      const custom = resolveAggregator(type as string, registry);
      return custom ? createCustomAggregator(custom) : new SumAggregator();
    }
  }
}

export const AGGREGATION_LABELS: Record<AggregationType, string> = {
  sum: 'Sum',
  count: 'Count',
  distinctCount: 'Distinct Count',
  average: 'Average',
  median: 'Median',
  min: 'Min',
  max: 'Max',
  product: 'Product',
  first: 'First',
  last: 'Last',
  stdev: 'Std Dev (sample)',
  stdevp: 'Std Dev (population)',
  var: 'Variance (sample)',
  varp: 'Variance (population)',
  none: 'None',
};

export { asNumber };
