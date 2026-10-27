import { describe, expect, test } from 'vitest';
import { topK } from '../../src/viewer/data/top-k.js';

/** Deterministic pseudo-random ints, many repeated, so ties exercise the stable-order rule. */
function values(n: number, range: number, seed = 7): { v: number; id: number }[] {
  let x = seed;
  return Array.from({ length: n }, (_, id) => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return { v: x % range, id };
  });
}

const byV = (a: { v: number }, b: { v: number }): number => a.v - b.v;
const stableTop = <T>(xs: readonly T[], k: number, cmp: (a: T, b: T) => number): T[] =>
  [...xs].sort(cmp).slice(0, k);

describe('topK', () => {
  test.each([
    [0, 10, 5],
    [1, 10, 1],
    [50, 10, 0],
    [50, 10, 50],
    [50, 10, 80],
    [1000, 7, 100],
    [5000, 1000, 1],
    [5000, 3, 4999],
    [20_000, 50, 2000],
  ])('n=%i range=%i k=%i matches a stable sort then slice', (n, range, k) => {
    const xs = values(n, range);
    expect(topK(xs, k, byV)).toEqual(stableTop(xs, k, byV));
  });

  test('descending comparators and already-ordered input', () => {
    const asc = Array.from({ length: 3000 }, (_, i) => ({ v: i >> 2, id: i }));
    const desc = (a: { v: number }, b: { v: number }): number => b.v - a.v;
    expect(topK(asc, 100, desc)).toEqual(stableTop(asc, 100, desc));
    expect(topK(asc, 100, byV)).toEqual(stableTop(asc, 100, byV));
    expect(topK([...asc].reverse(), 100, byV)).toEqual(stableTop([...asc].reverse(), 100, byV));
  });

  test('does not reorder its input', () => {
    const xs = values(500, 20);
    const copy = [...xs];
    topK(xs, 10, byV);
    expect(xs).toEqual(copy);
  });
});
