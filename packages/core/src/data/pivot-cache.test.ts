import { describe, expect, it } from 'vitest';
import { Dataset } from './dataset';
import { buildGrid } from '../engine/build';
import type { PivotConfiguration } from '../types';

const DATA = [
  { country: 'USA', category: 'Bikes', date: '2023-01-15', sales: 100 },
  { country: 'USA', category: 'Parts', date: '2023-06-20', sales: 50 },
  { country: 'UK', category: 'Bikes', date: '2024-02-10', sales: 80 },
  { country: 'UK', category: 'Parts', date: '2024-11-05', sales: 20 },
];
const source = {
  data: DATA,
  mapping: { date: { type: 'date' as const, dateParts: ['year' as const] } },
};

describe('pivot cache — encoded columns', () => {
  it('caches resolved + token columns (same reference reused)', () => {
    const ds = new Dataset(source);
    expect(ds.resolvedColumn('country')).toBe(ds.resolvedColumn('country'));
    expect(ds.tokenColumn('country')).toBe(ds.tokenColumn('country'));
  });

  it('resolved column matches resolveValue per record (incl. date parts)', () => {
    const ds = new Dataset(source);
    const col = ds.resolvedColumn('date.year');
    ds.records.forEach((r, i) => {
      expect(col[i]).toBe(ds.resolveValue(r, 'date.year'));
    });
  });

  it('token column distinguishes values and matches member count', () => {
    const ds = new Dataset(source);
    const toks = ds.tokenColumn('country');
    expect(new Set(toks).size).toBe(ds.getMembers('country').length); // USA, UK
  });

  it('reconfiguring over a reused Dataset equals a fresh build', () => {
    const shared = new Dataset(source);
    const slices: Array<PivotConfiguration['slice']> = [
      { rows: [{ uniqueName: 'country' }], columns: [{ uniqueName: 'category' }], measures: [{ uniqueName: 'sales', aggregation: 'sum' }] },
      { rows: [{ uniqueName: 'category' }], columns: [{ uniqueName: 'date.year' }], measures: [{ uniqueName: 'sales', aggregation: 'average' }] },
      { rows: [{ uniqueName: 'country' }, { uniqueName: 'category' }], measures: [{ uniqueName: 'sales', aggregation: 'sum' }] },
    ];
    for (const slice of slices) {
      const reused = buildGrid(shared, { dataSource: source, slice });
      const fresh = buildGrid(new Dataset(source), { dataSource: source, slice });
      expect(reused.rowLeaves.map((n) => n.caption)).toEqual(fresh.rowLeaves.map((n) => n.caption));
      for (let r = 0; r < fresh.rowLeaves.length; r++) {
        for (let c = 0; c < fresh.columnLeaves.length; c++) {
          const a = reused.getCell(reused.rowLeaves[r]!, reused.columnLeaves[c]!, reused.measures[0]!).value;
          const b = fresh.getCell(fresh.rowLeaves[r]!, fresh.columnLeaves[c]!, fresh.measures[0]!).value;
          expect(a).toBe(b);
        }
      }
    }
  });
});
