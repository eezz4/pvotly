import { describe, expect, it } from 'vitest';
import { Interner, pathKey, prefixKeys } from './tree';

const seg = (value: unknown) => ({ uniqueName: 'f', value: value as never });

describe('member-token interning (per-dataset shared-items dictionary)', () => {
  it('is deterministic and collision-free within one interner', () => {
    const it1 = new Interner();
    const a = pathKey(it1, [seg('USA'), seg('West')]);
    const b = pathKey(it1, [seg('USA'), seg('West')]);
    const c = pathKey(it1, [seg('USA'), seg('East')]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('avoids prefix-concatenation collisions', () => {
    const i = new Interner();
    // With a real delimiter, "1"+"23" must not collide with "12"+"3".
    const k1 = pathKey(i, [seg('1'), seg('23')]);
    const k2 = pathKey(i, [seg('12'), seg('3')]);
    expect(k1).not.toBe(k2);
  });

  it('distinguishes the number 1 from the string "1"', () => {
    const i = new Interner();
    expect(pathKey(i, [seg(1)])).not.toBe(pathKey(i, [seg('1')]));
  });

  it('prefixKeys yields the cumulative prefixes ending at the leaf key', () => {
    const i = new Interner();
    const vals = ['USA', 'West', 'LA'];
    const keys = prefixKeys(i, vals);
    expect(keys[0]).toBe(''); // grand total
    expect(keys).toHaveLength(vals.length + 1);
    expect(keys[keys.length - 1]).toBe(pathKey(i, vals.map(seg)));
  });

  it('two fresh interners assign the same codes for the same insertion order', () => {
    // No process-global state: a new dataset's interner is independent but
    // reproducible, so keys are stable across rebuilds from the same data.
    const a = new Interner();
    const b = new Interner();
    expect(pathKey(b, [seg('X'), seg('Y')])).toBe(pathKey(a, [seg('X'), seg('Y')]));
  });
});
