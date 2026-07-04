/**
 * (De)serialization for transferring a computed {@link PivotGrid} across a
 * structured-clone boundary (e.g. a Web Worker `postMessage`).
 *
 * A {@link PivotGrid} carries a `getCell` function, which cannot survive
 * structured clone. {@link serializeGrid} drops it (everything else — trees,
 * leaves, body cells, meta — is plain data) and {@link deserializeGrid}
 * reconstructs an equivalent `getCell` from the body cells on the receiving end.
 */

import type { HeaderNode, MeasureConfig, PivotCell, PivotGrid } from '../types';
import { Interner, PathSeg, pathKey } from './tree';

/** A {@link PivotGrid} without its non-cloneable `getCell` accessor. */
export type SerializedGrid = Omit<PivotGrid, 'getCell'>;

/** Strip the `getCell` function so the grid can be structured-cloned. */
export function serializeGrid(grid: PivotGrid): SerializedGrid {
  // Intentionally omit getCell; the rest is plain serializable data.
  const { getCell: _drop, ...rest } = grid;
  void _drop;
  return rest;
}

/** Rebuild a fully-functional {@link PivotGrid} (incl. `getCell`) from cloned data. */
export function deserializeGrid(grid: SerializedGrid): PivotGrid {
  // A throwaway interner local to this grid: keys only need to be self-consistent
  // between the index build below and getCell, not match the original grid's codes.
  const interner = new Interner();
  const index = new Map<string, PivotCell>();
  for (const row of grid.body) {
    for (const cell of row) {
      const rk = pathKey(interner, cell.rowPath as PathSeg[]);
      const ck = pathKey(interner, cell.columnPath as PathSeg[]);
      index.set(`${rk}|${ck}|${cell.measure}`, cell);
    }
  }

  const getCell = (rowNode: HeaderNode, colNode: HeaderNode, measure: MeasureConfig): PivotCell => {
    const rk = pathKey(interner, rowNode.path as PathSeg[]);
    const ck = pathKey(interner, colNode.path as PathSeg[]);
    const found = index.get(`${rk}|${ck}|${measure.uniqueName}`);
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

  return { ...grid, getCell };
}
