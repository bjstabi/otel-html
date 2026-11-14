import { describe, expect, test } from 'vitest';
import { gridOf, slot, zeros } from '../../src/viewer/data/grid.js';

const WIDTH = 1_048_576; // 1 ms * 2^20, aligned in the producer
const FAR = 2n ** 59n; // about 18 years past the anchor
const bucket = (k: number): bigint => FAR + BigInt(k) * BigInt(WIDTH);

describe('a grid far from the anchor', () => {
  test('rounded bucket times still give an integer length and a slot each', () => {
    const at = [0, 1, 2, 3, 4, 5, 6].map((k) => Number(bucket(k)));
    const grid = gridOf(at, WIDTH);
    expect(grid).not.toBeNull();
    expect(Number.isInteger(grid?.length)).toBe(true);
    expect(grid?.length).toBe(7);
    if (grid === null) return;
    expect(at.map((b) => slot(b, grid, WIDTH))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test('the grid sizes a series (zeros) from buckets 2^59 ns past the anchor', () => {
    const ks = [0, 3, 7];
    const at = ks.map((k) => Number(bucket(k)));
    const grid = gridOf(at, WIDTH);
    if (grid === null) throw new Error('a grid');
    const counts = zeros(grid.length);
    at.forEach((b, i) => {
      counts[slot(b, grid, WIDTH)] = i + 1;
    });
    expect(counts).toEqual([1, 0, 0, 2, 0, 0, 0, 3]);
  });

  test('a safe-range bucket off the grid is still refused', () => {
    expect(() => slot(1.5 * WIDTH, { start: 0, length: 4 }, WIDTH)).toThrow(/bucket/);
  });
});
