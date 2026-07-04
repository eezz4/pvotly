import type { DataRecord, DataValue, GridType } from '../types';
import type { Dataset } from '../data/dataset';

export interface PathSeg {
  uniqueName: string;
  value: DataValue;
}

export interface MemberNode {
  uniqueName: string;
  value: DataValue;
  caption: string;
  level: number;
  path: PathSeg[];
  /** Full path key (used to look up aggregations). */
  key: string;
  children: Map<string, MemberNode>;
  /** Children in display order (set by the ordering pass). */
  orderedChildren: MemberNode[];
  leafCount: number;
}

/** Stable, collision-free token for a single member value. */
export function valueToken(value: DataValue): string {
  if (value == null) return '\u0000';
  if (value instanceof Date) return `d${value.getTime()}`;
  switch (typeof value) {
    case 'number':
      return `#${value}`;
    case 'boolean':
      return `b${value ? 1 : 0}`;
    default:
      return `s${value}`;
  }
}

const SEP = '\u0001';

/**
 * Member-token interner — the pivot-cache "shared items" dictionary. Each distinct
 * {@link valueToken} string is assigned a compact base-36 code the first time it is
 * seen; path keys are built from the short codes instead of repeating the often-long
 * token strings across every cell key.
 *
 * Scoped to a {@link Dataset} (one interner per dataset, see `Dataset.interner`), so
 * the dictionary is released together with the dataset — there is no process-global
 * cache to grow unbounded across data refreshes, nor to desync against a dataset's
 * cached token columns. A fresh dataset gets a fresh dictionary.
 */
export class Interner {
  private readonly map = new Map<string, number>();
  private next = 0;

  /** Compact code for a raw token string (assigned on first sight, then reused). */
  code(token: string): string {
    let code = this.map.get(token);
    if (code === undefined) {
      code = this.next++;
      this.map.set(token, code);
    }
    return code.toString(36);
  }

  /** Compact code for a member value (interns its {@link valueToken}). */
  token(value: DataValue): string {
    return this.code(valueToken(value));
  }
}

export function pathKey(interner: Interner, segments: PathSeg[]): string {
  let key = '';
  for (let i = 0; i < segments.length; i++) {
    const code = interner.token(segments[i]!.value);
    key = i === 0 ? code : `${key}${SEP}${code}`;
  }
  return key;
}

/** All cumulative prefix keys of a value list, including the empty (grand total). */
export function prefixKeys(interner: Interner, values: DataValue[]): string[] {
  const keys: string[] = [''];
  let acc = '';
  for (let i = 0; i < values.length; i++) {
    const code = interner.token(values[i]!);
    acc = i === 0 ? code : `${acc}${SEP}${code}`;
    keys.push(acc);
  }
  return keys;
}

/** Build the full member hierarchy for an axis from (already filtered) records. */
export function buildMemberTree(
  records: DataRecord[],
  fields: string[],
  dataset: Dataset,
): MemberNode[] {
  const roots = new Map<string, MemberNode>();
  if (!fields.length) return [];

  for (const record of records) {
    let parent = roots;
    const path: PathSeg[] = [];
    for (let level = 0; level < fields.length; level++) {
      const uniqueName = fields[level]!;
      const value = dataset.resolveValue(record, uniqueName);
      path.push({ uniqueName, value });
      const token = valueToken(value);
      let node = parent.get(token);
      if (!node) {
        node = {
          uniqueName,
          value,
          caption: dataset.memberCaption(uniqueName, value),
          level,
          path: path.map((p) => ({ ...p })),
          key: pathKey(dataset.interner, path),
          children: new Map(),
          orderedChildren: [],
          leafCount: 0,
        };
        parent.set(token, node);
      }
      parent = node.children;
    }
  }
  return [...roots.values()];
}

/** Full path key from precomputed member-token codes (the leaf/grand key). */
export function tokenKey(tokens: string[]): string {
  return tokens.join(SEP);
}

/** Cumulative prefix keys built directly from precomputed member-token codes. */
export function prefixTokenKeys(tokens: string[]): string[] {
  const keys: string[] = [''];
  let acc = '';
  for (let i = 0; i < tokens.length; i++) {
    acc = i === 0 ? tokens[i]! : `${acc}\u0001${tokens[i]!}`;
    keys.push(acc);
  }
  return keys;
}

/**
 * Build the member hierarchy from precomputed token + value columns (the pivot
 * cache's encoded records), addressed by record index. Equivalent to
 * {@link buildMemberTree} but reads cached columns instead of re-resolving and
 * re-tokenizing every record on each build.
 */
export function buildMemberTreeFromColumns(
  keep: number[],
  fields: string[],
  tokenColumns: string[][],
  valueColumns: DataValue[][],
  dataset: Dataset,
): MemberNode[] {
  const roots = new Map<string, MemberNode>();
  if (!fields.length) return [];

  for (const i of keep) {
    let parent = roots;
    const path: PathSeg[] = [];
    let key = '';
    for (let level = 0; level < fields.length; level++) {
      const uniqueName = fields[level]!;
      const value = valueColumns[level]![i];
      const token = tokenColumns[level]![i]!;
      path.push({ uniqueName, value });
      key = level === 0 ? token : `${key}\u0001${token}`;
      let node = parent.get(token);
      if (!node) {
        node = {
          uniqueName,
          value,
          caption: dataset.memberCaption(uniqueName, value),
          level,
          path: path.map((p) => ({ ...p })),
          key,
          children: new Map(),
          orderedChildren: [],
          leafCount: 0,
        };
        parent.set(token, node);
      }
      parent = node.children;
    }
  }
  return [...roots.values()];
}

/** Recompute leafCount from the ordered (post-filter) children. */
export function computeLeafCount(node: MemberNode): number {
  if (node.orderedChildren.length === 0) {
    node.leafCount = 1;
    return 1;
  }
  node.leafCount = node.orderedChildren.reduce((sum, c) => sum + computeLeafCount(c), 0);
  return node.leafCount;
}

export interface VisibleNode {
  node: MemberNode;
  expanded: boolean;
  /** Non-leaf node currently showing its subtotal. */
  isSubtotal: boolean;
}

export type IsExpanded = (node: MemberNode) => boolean;

/**
 * Compact layout: pre-order walk. Every node emits one line; an expanded parent
 * additionally emits its descendants. A collapsed/leaf node shows the aggregate
 * over all of its descendants.
 */
export function flattenCompact(roots: MemberNode[], isExpanded: IsExpanded): VisibleNode[] {
  const out: VisibleNode[] = [];
  const walk = (nodes: MemberNode[]) => {
    for (const node of nodes) {
      const hasChildren = node.orderedChildren.length > 0;
      const expanded = hasChildren && isExpanded(node);
      out.push({ node, expanded, isSubtotal: expanded });
      if (expanded) walk(node.orderedChildren);
    }
  };
  walk(roots);
  return out;
}

/**
 * Classic layout: leaves are emitted at full depth; each expanded group emits a
 * trailing subtotal line when requested.
 */
export function flattenClassic(
  roots: MemberNode[],
  isExpanded: IsExpanded,
  showSubtotals: boolean,
): VisibleNode[] {
  const out: VisibleNode[] = [];
  const walk = (nodes: MemberNode[]) => {
    for (const node of nodes) {
      const hasChildren = node.orderedChildren.length > 0;
      const expanded = hasChildren && isExpanded(node);
      if (!expanded) {
        out.push({ node, expanded: false, isSubtotal: false });
        continue;
      }
      walk(node.orderedChildren);
      if (showSubtotals) out.push({ node, expanded: true, isSubtotal: true });
    }
  };
  walk(roots);
  return out;
}

/** Flat layout: only the deepest leaves, no subtotals. */
export function flattenFlat(roots: MemberNode[]): VisibleNode[] {
  const out: VisibleNode[] = [];
  const walk = (nodes: MemberNode[]) => {
    for (const node of nodes) {
      if (node.orderedChildren.length === 0) {
        out.push({ node, expanded: false, isSubtotal: false });
      } else {
        walk(node.orderedChildren);
      }
    }
  };
  walk(roots);
  return out;
}

export function flatten(
  roots: MemberNode[],
  type: GridType,
  isExpanded: IsExpanded,
  showSubtotals: boolean,
): VisibleNode[] {
  switch (type) {
    case 'classic':
      return flattenClassic(roots, isExpanded, showSubtotals);
    case 'flat':
      return flattenFlat(roots);
    case 'compact':
    default:
      return flattenCompact(roots, isExpanded);
  }
}
