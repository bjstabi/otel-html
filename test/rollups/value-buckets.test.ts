import { describe, expect, it } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import { ValueBuckets } from '../../src/rollups/value-buckets.js';

const t = (n: number): RelNanos => n as RelNanos;
const MS = 1_000_000;

describe('ValueBuckets', () => {
  it('sums and counts per 1 ms bucket', () => {
    const b = new ValueBuckets();
    b.add(t(0), 1.5);
    b.add(t(10), 2.5);
    b.add(t(MS), 4);
    const j = b.toJSON();
    expect(j.widthNs).toBe(MS);
    expect(j.sums).toEqual([4, 4]);
    expect(j.counts).toEqual([2, 1]);
  });

  it('doubles the width beyond 128 buckets and conserves totals', () => {
    const b = new ValueBuckets();
    for (let i = 0; i < 300; i++) b.add(t(i * MS), 1);
    const j = b.toJSON();
    expect(j.counts.length).toBeLessThanOrEqual(128);
    expect(j.widthNs).toBe(4 * MS);
    expect(j.counts.reduce((a, c) => a + c, 0)).toBe(300);
    expect(j.sums.reduce((a, c) => a + c, 0)).toBe(300);
    expect(j.startNs % j.widthNs).toBe(0);
  });

  it('merging two runs equals adding every point to one', () => {
    const pts = Array.from({ length: 400 }, (_, i) => ({ at: i * 3 * MS + (i % 7), v: i % 5 }));
    const all = new ValueBuckets();
    const a = new ValueBuckets();
    const c = new ValueBuckets();
    pts.forEach((p, i) => {
      all.add(t(p.at), p.v);
      (i < 150 ? a : c).add(t(p.at), p.v);
    });
    a.merge(c);
    expect(a.toJSON()).toEqual(all.toJSON());
  });

  it('merging into or from an empty run is the identity', () => {
    const a = new ValueBuckets();
    a.add(t(5 * MS), 2);
    const e = new ValueBuckets();
    e.merge(a);
    expect(e.toJSON()).toEqual(a.toJSON());
    a.merge(new ValueBuckets());
    expect(a.toJSON()).toEqual(e.toJSON());
  });

  it('round-trips and fails fast on malformed input', () => {
    const a = new ValueBuckets();
    for (let i = 0; i < 200; i++) a.add(t(i * MS), i / 3);
    const back = ValueBuckets.from(JSON.parse(JSON.stringify(a.toJSON())), 'x');
    expect(back.toJSON()).toEqual(a.toJSON());
    expect(() => ValueBuckets.from({ widthNs: 3, startNs: 0, sums: [], counts: [] }, 'x.spark')).toThrow(
      /x\.spark/,
    );
    expect(() => ValueBuckets.from({ widthNs: MS, startNs: 1, sums: [1], counts: [1] }, 'x')).toThrow(
      /startNs/,
    );
  });

  it('rejects non-finite input', () => {
    const b = new ValueBuckets();
    expect(() => b.add(t(0), Number.NaN)).toThrow(RangeError);
    expect(() => b.add(t(Number.POSITIVE_INFINITY), 1)).toThrow(RangeError);
  });
});
