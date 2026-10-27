import { describe, expect, it } from 'vitest';
import { ExpHistogram } from '../../src/rollups/exp-histogram.js';

function filled(n: number, maxBuckets?: number): ExpHistogram {
  const h = new ExpHistogram(maxBuckets);
  for (let i = 1; i <= n; i++) h.record(i);
  return h;
}

describe('ExpHistogram', () => {
  it('keeps quantiles within the relative error of its final scale', () => {
    const h = filled(10_000);
    const err = 2 ** (2 ** -h.scale) - 1;
    expect(h.scale).toBeLessThan(20);
    expect(Math.abs(h.quantile(0.5) - 5000) / 5000).toBeLessThanOrEqual(err);
    expect(Math.abs(h.quantile(0.99) - 9900) / 9900).toBeLessThanOrEqual(err);
  });
  it('tracks count, sum, min and max exactly', () => {
    const h = filled(100);
    expect([h.count, h.sum, h.min, h.max]).toEqual([100, 5050, 1, 100]);
    expect(h.quantile(0)).toBe(1);
    expect(h.quantile(1)).toBe(100);
  });
  it('counts zeros in a zero bucket', () => {
    const h = new ExpHistogram();
    h.record(0);
    h.record(0);
    h.record(8);
    expect(h.quantile(0.5)).toBe(0);
    expect(h.quantile(1)).toBe(8);
  });
  it('round-trips through JSON', () => {
    const h = filled(5000);
    const copy = ExpHistogram.from(JSON.parse(JSON.stringify(h.toJSON())));
    for (const q of [0, 0.5, 0.9, 0.99, 1]) expect(copy.quantile(q)).toBe(h.quantile(q));
    expect(copy.toJSON()).toEqual(h.toJSON());
  });
  it('merge equals re-ingest', () => {
    const a = new ExpHistogram();
    const b = new ExpHistogram();
    const all = new ExpHistogram();
    for (let i = 1; i <= 3000; i++) {
      (i % 2 === 0 ? a : b).record(i * 1000);
      all.record(i * 1000);
    }
    a.merge(b);
    expect(a.count).toBe(all.count);
    const err = 2 ** (2 ** -a.scale) - 1;
    expect(Math.abs(a.quantile(0.5) - all.quantile(0.5)) / all.quantile(0.5)).toBeLessThanOrEqual(err);
  });
  it('rejects negative and non-finite values, and bad q', () => {
    const h = new ExpHistogram();
    expect(() => h.record(-1)).toThrow(/non-negative/);
    expect(() => h.record(Number.NaN)).toThrow(/finite/);
    expect(() => h.quantile(2)).toThrow(/between 0 and 1/);
  });
  it('fails fast on corrupt serialized data', () => {
    const good = filled(10).toJSON();
    expect(() => ExpHistogram.from({ ...good, count: good.count + 1 })).toThrow(/invalid-report|count/);
    expect(() => ExpHistogram.from('nope')).toThrow(/expected/);
  });
});
