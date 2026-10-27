import { describe, expect, it } from 'vitest';
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
