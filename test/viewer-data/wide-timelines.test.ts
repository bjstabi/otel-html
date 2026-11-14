import type { Table } from '@uwdata/flechette';
import { describe, expect, test } from 'vitest';
import { logTimeline, pointBuckets } from '../../src/viewer/data/log-results.js';
import { timelineBuckets } from '../../src/viewer/data/span-results.js';

const WIDTH = 4_000_000; // 1 ms * 2^2: not a power of two, so far multiples are rounded doubles
const asTable = (rows: object[]): Table => ({ toArray: () => rows }) as unknown as Table;

describe.each([2n ** 54n, 2n ** 59n])('buckets %d ns past the anchor', (far) => {
  const base = (far / BigInt(WIDTH)) * BigInt(WIDTH);
  const at = [0n, 2n, 5n].map((k) => base + k * BigInt(WIDTH));
  const spec = { widthNs: WIDTH, startNs: Number(at[0]), endNs: Number(at[2]), originNs: 0 };

  test('the span timeline builds', () => {
    const t = asTable(at.map((bucket, i) => ({ bucket, ok: BigInt(i + 1), error: 0n, unset: 0n })));
    const b = timelineBuckets(t, spec);
    expect(b.length).toBe(6);
    expect(b.counts('ok')).toEqual([1, 0, 2, 0, 0, 3]);
  });

  test('the log timeline builds', () => {
    const t = asTable(at.map((bucket, i) => ({ bucket, band: 'info', n: BigInt(i + 1) })));
    const b = logTimeline(t, spec);
    expect(b.length).toBe(6);
    expect(b.counts('info')).toEqual([1, 0, 2, 0, 0, 3]);
  });

  test('the point buckets build', () => {
    const t = asTable(at.map((bucket, i) => ({ bucket, n: BigInt(i + 1) })));
    const b = pointBuckets(t, spec);
    expect(b.counts('points')).toEqual([1, 0, 2, 0, 0, 3]);
  });
});
