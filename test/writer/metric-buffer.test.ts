import { describe, expect, test } from 'vitest';
import { type BucketAgg, mergeAgg } from '../../src/rollups/metric-agg.js';
import { MetricBuffer } from '../../src/writer/metric-buffer.js';

const num = (v: number, lastTime: number): BucketAgg => ({
  k: 'number',
  count: 1,
  sum: v,
  min: v,
  max: v,
  last: v,
  lastTime,
});
const counter = (delta: number, resets = 0): BucketAgg => ({ k: 'counter', delta, resets });

/** The one bucket (series 0, index 7) a fresh buffer holds after `aggs` arrive in this order. */
function buffered(...aggs: BucketAgg[]): BucketAgg | undefined {
  const b = new MetricBuffer(2);
  for (const a of aggs) b.add(0, 7, a, 'p');
  const s = b.series('p');
  expect(s.map((x) => x.t)).toEqual([[7]]);
  return s[0]?.a[0];
}

describe('MetricBuffer', () => {
  test('equal-time gauge points keep the larger last either way round, as mergeAgg does (#147)', () => {
    const want = { k: 'number', count: 2, sum: 8, min: 3, max: 5, last: 5, lastTime: 1 };
    expect(mergeAgg(num(5, 1), num(3, 1), 'p')).toEqual(want);
    expect(mergeAgg(num(3, 1), num(5, 1), 'p')).toEqual(want);
    expect(buffered(num(5, 1), num(3, 1))).toEqual(want);
    expect(buffered(num(3, 1), num(5, 1))).toEqual(want);
  });

  test('a later lastTime wins over a larger last', () => {
    expect(buffered(num(9, 1), num(2, 2))).toEqual(mergeAgg(num(9, 1), num(2, 2), 'p'));
    expect(buffered(num(9, 1), num(2, 2))).toMatchObject({ last: 2, lastTime: 2 });
  });

  test('a counter pair gives the same bucket either way round', () => {
    const want = { k: 'counter', delta: 7, resets: 1 };
    expect(mergeAgg(counter(3), counter(4, 1), 'p')).toEqual(want);
    expect(buffered(counter(3), counter(4, 1))).toEqual(want);
    expect(buffered(counter(4, 1), counter(3))).toEqual(want);
  });

  test('an equal-time pair older than the latest bucket merges the same way', () => {
    const b = new MetricBuffer(2);
    b.add(0, 9, num(1, 5), 'p');
    b.add(0, 7, num(3, 1), 'p'); // older than bucket 9: kept apart
    b.add(0, 7, num(5, 1), 'p');
    expect(b.series('p')).toEqual([
      { id: 0, t: [7, 9], a: [mergeAgg(num(3, 1), num(5, 1), 'p'), num(1, 5)] },
    ]);
  });
});
