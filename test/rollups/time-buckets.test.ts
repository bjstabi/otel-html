import { describe, expect, it, test } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';

const t = (n: number): RelNanos => n as RelNanos;
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe('TimeBuckets', () => {
  it('buckets at 1 ms and supports negative times', () => {
    const b = new TimeBuckets(['a', 'b']);
    b.add(t(-500_000), 'a');
    b.add(t(1_500_000), 'b', 3);
    expect(b.widthNs).toBe(1_000_000);
    expect(b.startNs).toBe(-1_000_000);
    expect(b.counts('a')).toEqual([1, 0, 0]);
    expect(b.counts('b')).toEqual([0, 0, 3]);
  });
  it('coarsens by powers of two and conserves totals exactly', () => {
    const b = new TimeBuckets(['x', 'y'], 64);
    let total = 0;
    for (let i = 0; i < 5000; i++) {
      b.add(t(i * 1_234_567 - 1_000_000_000), i % 3 === 0 ? 'x' : 'y', 2);
      total += 2;
    }
    expect(b.counts('x').length).toBeLessThanOrEqual(64);
    expect(b.widthNs / 1_000_000).toBeGreaterThan(1);
    expect(Math.log2(b.widthNs / 1_000_000) % 1).toBe(0);
    expect(sum(b.counts('x')) + sum(b.counts('y'))).toBe(total);
  });
  it('restores and coarsens rows of 150 000 buckets without a stack overflow', () => {
    const n = 150_000;
    const json = {
      maxBuckets: n,
      widthNs: 1_000_000,
      startNs: 0,
      keys: ['a'],
      counts: [Array.from({ length: n }, () => 1)],
    };
    const b = TimeBuckets.from(json);
    expect(b.counts('a')).toHaveLength(n);
    b.add(t(2 * n * 1_000_000), 'a');
    expect(b.widthNs).toBe(4_000_000);
    expect(sum(b.counts('a'))).toBe(n + 1);
  });
  it('is independent of insertion order', () => {
    const times = Array.from({ length: 2000 }, (_, i) => ((i * 7919) % 100_000) * 1_000_000);
    const fwd = new TimeBuckets(['k'], 32);
    const rev = new TimeBuckets(['k'], 32);
    for (const x of times) fwd.add(t(x), 'k');
    for (const x of [...times].reverse()) rev.add(t(x), 'k');
    expect(rev.toJSON()).toEqual(fwd.toJSON());
  });
  it('round-trips through JSON', () => {
    const b = new TimeBuckets(['a'], 16);
    for (let i = 0; i < 100; i++) b.add(t(i * 5_000_000), 'a');
    expect(TimeBuckets.from(JSON.parse(JSON.stringify(b.toJSON()))).toJSON()).toEqual(b.toJSON());
  });
  it('rejects unknown keys and bad counts; validates serialized form', () => {
    const b = new TimeBuckets(['a']);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid key
    expect(() => b.add(t(0), 'zzz' as any)).toThrow(/unknown key/);
    expect(() => b.add(t(0), 'a', -1)).toThrow(/non-negative integer/);
    const j = b.toJSON();
    expect(() => TimeBuckets.from({ ...j, widthNs: 3 })).toThrow(/widthNs/);
  });
});

describe('originNs', () => {
  test('TimeBuckets.from accepts a start aligned to originNs and refuses one that is not', () => {
    expect(() =>
      TimeBuckets.from({ maxBuckets: 4, widthNs: 10, originNs: 3, startNs: 13, keys: [], counts: [] }),
    ).toThrow(); // widthNs must be 1 ms * 2^k
    const w = 1_000_000;
    expect(() =>
      TimeBuckets.from({ maxBuckets: 4, widthNs: w, originNs: 3, startNs: w + 3, keys: [], counts: [] }),
    ).not.toThrow();
    expect(() =>
      TimeBuckets.from({ maxBuckets: 4, widthNs: w, originNs: 3, startNs: w, keys: [], counts: [] }),
    ).toThrow();
  });
  test('originNs survives a round trip and is omitted when 0', () => {
    const w = 1_000_000;
    const b = TimeBuckets.from({
      maxBuckets: 4,
      widthNs: w,
      originNs: 3,
      startNs: 3,
      keys: ['a'],
      counts: [[1]],
    });
    expect(b.toJSON().originNs).toBe(3);
    expect('originNs' in new TimeBuckets(['a']).toJSON()).toBe(false);
  });
  test('growth and coarsening keep a restored origin', () => {
    const w = 1_000_000;
    const mk = (maxBuckets: number) =>
      TimeBuckets.from({
        maxBuckets,
        widthNs: w,
        originNs: 3,
        startNs: w + 3,
        keys: ['count'],
        counts: [[1]],
      });
    const b = mk(4);
    expect(() => b.add((w + 3) as never, 'count')).not.toThrow();
    expect(b.total('count')).toBe(2);
    b.add((w * 3 + 5) as never, 'count'); // grows right on the origin grid
    b.add(3 as never, 'count'); // grows left
    expect(b.startNs).toBe(3);
    expect(b.counts('count')).toEqual([1, 2, 0, 1]);
    b.add((w * 9 + 7) as never, 'count'); // coarsens
    expect(b.widthNs).toBe(w * 4);
    expect((b.startNs - 3) % b.widthNs).toBe(0);
    expect(b.total('count')).toBe(5);
    expect(b.toJSON().originNs).toBe(3);
  });
});
