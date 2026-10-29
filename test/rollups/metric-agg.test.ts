import { describe, expect, it } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import {
  type BucketAgg,
  BucketAggSchema,
  downscaleExp,
  type ExpAgg,
  type HistAgg,
  mergeAgg,
  type NumberAgg,
  quantileOf,
} from '../../src/rollups/metric-agg.js';

const num = (o: Partial<NumberAgg>): NumberAgg => ({
  k: 'number',
  count: 1,
  sum: 1,
  min: 1,
  max: 1,
  last: 1,
  lastTime: 1,
  ...o,
});
const hist = (o: Partial<HistAgg>): HistAgg => ({
  k: 'hist',
  count: 10,
  sum: 50,
  min: 0,
  max: 12,
  bounds: [0, 5, 10],
  counts: [1, 2, 3, 4],
  ...o,
});
const exp = (o: Partial<ExpAgg>): ExpAgg => ({
  k: 'exp',
  count: 0,
  sum: 0,
  min: null,
  max: null,
  scale: 0,
  zeroCount: 0,
  zeroThreshold: 0,
  positive: { offset: 0, counts: [] },
  negative: { offset: 0, counts: [] },
  ...o,
});
/** Single positive observation `v` at `scale`. */
function oneValue(v: number, scale: number): ExpAgg {
  const i = Math.ceil(Math.log2(v) * 2 ** scale) - 1;
  return exp({ count: 1, sum: v, min: v, max: v, scale, positive: { offset: i, counts: [1] } });
}

describe('mergeAgg', () => {
  it('merges number aggs, taking last from the later lastTime', () => {
    const m = mergeAgg(
      num({ count: 2, sum: 5, min: 1, max: 4, last: 9, lastTime: 20 }),
      num({ count: 3, sum: 6, min: 0, max: 3, last: 7, lastTime: 10 }),
      'p',
    );
    expect(m).toEqual({ k: 'number', count: 5, sum: 11, min: 0, max: 4, last: 9, lastTime: 20 });
  });
  it('equal last times give the same last value in either order', () => {
    const a = num({ last: 9, lastTime: 20 });
    const b = num({ last: 4, lastTime: 20 });
    expect(mergeAgg(a, b, 'p')).toEqual(mergeAgg(b, a, 'p'));
    expect(mergeAgg(b, a, 'p')).toMatchObject({ last: 9 });
    const s = (count: number, v: number): BucketAgg => ({
      k: 'summary',
      count,
      sum: count,
      quantiles: [{ q: 0.5, v }],
      lastTime: 5,
    });
    expect(mergeAgg(s(1, 1), s(2, 9), 'p')).toEqual(mergeAgg(s(2, 9), s(1, 1), 'p'));
  });
  it('adds counter delta and resets', () => {
    const m = mergeAgg({ k: 'counter', delta: 3, resets: 1 }, { k: 'counter', delta: 4, resets: 2 }, 'p');
    expect(m).toEqual({ k: 'counter', delta: 7, resets: 3 });
  });
  it('adds hist buckets and throws on mismatched bounds or kinds', () => {
    const m = mergeAgg(hist({}), hist({}), 'p');
    expect(m).toMatchObject({ count: 20, counts: [2, 4, 6, 8] });
    expect(() => mergeAgg(hist({}), hist({ bounds: [0, 5, 11] }), 'p')).toThrow(/bounds/);
    expect(() => mergeAgg(hist({}), num({}), 'p')).toThrow(/kind/);
  });
  it('keeps summary quantiles from the larger lastTime', () => {
    const a: BucketAgg = { k: 'summary', count: 1, sum: 1, quantiles: [{ q: 0.5, v: 1 }], lastTime: 5 };
    const b: BucketAgg = { k: 'summary', count: 2, sum: 4, quantiles: [{ q: 0.5, v: 9 }], lastTime: 3 };
    expect(mergeAgg(a, b, 'p')).toMatchObject({
      count: 3,
      sum: 5,
      quantiles: [{ q: 0.5, v: 1 }],
      lastTime: 5,
    });
  });
  it('merges exp aggs at the smaller scale, conserving count', () => {
    const a = oneValue(3, 3);
    const b = oneValue(100, 1);
    const m = mergeAgg(a, b, 'p');
    expect(m).toMatchObject({ k: 'exp', scale: 1, count: 2 });
    if (m.k !== 'exp') throw new Error('kind');
    expect(m.positive.counts.reduce((s, c) => s + c, 0)).toBe(2);
  });
  it('an exp agg with no buckets (only zeros) keeps the other side at its own scale', () => {
    const zeros = exp({ count: 2, zeroCount: 2, scale: -4 });
    const m = mergeAgg(oneValue(3, 3), zeros, 'p');
    expect(m).toMatchObject({ k: 'exp', scale: 3, count: 3, zeroCount: 2 });
    expect(mergeAgg(zeros, oneValue(3, 3), 'p')).toEqual(m);
  });
  it('stays within 160 buckets per side for wildly spread values', () => {
    let acc: BucketAgg = oneValue(1e-6, 20);
    for (let i = 1; i < 1000; i++) acc = mergeAgg(acc, oneValue(i % 2 === 0 ? 1e-6 : 1e6, 20), 'p');
    if (acc.k !== 'exp') throw new Error('kind');
    expect(acc.count).toBe(1000);
    expect(acc.positive.counts.length).toBeLessThanOrEqual(160);
    expect(acc.negative.counts.length).toBeLessThanOrEqual(160);
  });
  it('raises the zero threshold to the larger one, folding covered buckets into zeroCount', () => {
    const m = mergeAgg(exp({ zeroThreshold: 4 }), oneValue(1, 0), 'p');
    if (m.k !== 'exp') throw new Error('kind');
    expect(m.zeroThreshold).toBe(4);
    expect(m.zeroCount).toBe(1);
    expect(m.positive.counts).toEqual([]);
  });
});

describe('downscaleExp', () => {
  it('maps index i to i >> d and conserves count', () => {
    const e = exp({ count: 3, scale: 1, positive: { offset: -3, counts: [1, 1, 1] } });
    const d = downscaleExp(e, 0);
    expect(d.positive).toEqual({ offset: -2, counts: [1, 2] });
  });
  it('rejects upscaling', () => {
    expect(() => downscaleExp(exp({ scale: 1 }), 2)).toThrow();
  });
  it('rejects a scale below -10 or a shift beyond 30 bits, where `>>` would wrap', () => {
    expect(() => downscaleExp(exp({ scale: -10 }), -11)).toThrow(OtelHtmlError);
    expect(() => downscaleExp(exp({ scale: 21 }), -10)).toThrow(OtelHtmlError);
    expect(
      downscaleExp(exp({ scale: 20, positive: { offset: 2 ** 30, counts: [1] }, count: 1 }), -10).positive,
    ).toEqual({
      offset: 1,
      counts: [1],
    });
  });
  it('merges far-apart exp aggs without going below scale -10', () => {
    const lo = exp({ count: 1, scale: 20, positive: { offset: -1075 * 2 ** 20, counts: [1] } });
    const hi = exp({ count: 1, scale: 20, positive: { offset: 1024 * 2 ** 20 - 1, counts: [1] } });
    const m = mergeAgg(lo, hi, 'p');
    expect(m.k === 'exp' && m.scale).toBeGreaterThanOrEqual(-10);
    expect(m.k === 'exp' && m.count).toBe(2);
  });
});

describe('quantileOf', () => {
  it('interpolates inside explicit buckets', () => {
    const v = quantileOf(hist({}), 0.5);
    expect(v).toBeGreaterThan(5);
    expect(v).toBeLessThanOrEqual(10);
  });
  it('is null when empty', () => {
    expect(quantileOf(hist({ count: 0, counts: [0, 0, 0, 0], min: null, max: null }), 0.5)).toBeNull();
  });
  it('clamps to max in the open last bucket', () => {
    expect(quantileOf(hist({}), 1)).toBe(12);
  });
  it('returns a negative p50 for a negative-only exp', () => {
    const e = exp({ count: 3, scale: 0, negative: { offset: 2, counts: [3] } });
    const v = quantileOf(e, 0.5);
    expect(v).not.toBeNull();
    expect(v).toBeLessThan(0);
    expect(v).toBeCloseTo(-(2 ** 2.5), 10);
  });
  it('returns 0 when the median lies in the zero bucket', () => {
    expect(quantileOf(exp({ count: 3, zeroCount: 3 }), 0.5)).toBe(0);
  });
});

describe('BucketAggSchema', () => {
  it('rejects NaN sums and bounds/counts mismatches', () => {
    expect(BucketAggSchema.safeParse(hist({ sum: Number.NaN })).success).toBe(false);
    expect(BucketAggSchema.safeParse(exp({ scale: 21 })).success).toBe(false);
    expect(BucketAggSchema.safeParse(exp({ scale: -11 })).success).toBe(false);
    expect(
      BucketAggSchema.safeParse(exp({ count: 1, positive: { offset: 2 ** 31, counts: [1] } })).success,
    ).toBe(false);
    expect(BucketAggSchema.safeParse(exp({ scale: 20 })).success).toBe(true);
    expect(BucketAggSchema.safeParse(hist({ counts: [1, 2, 3] })).success).toBe(false);
    expect(BucketAggSchema.safeParse(hist({ count: 11 })).success).toBe(false);
  });
  it('rejects bounds out of order and a quantile outside [0, 1]', () => {
    expect(BucketAggSchema.safeParse(hist({ bounds: [0, 10, 5] })).success).toBe(false);
    expect(BucketAggSchema.safeParse(hist({ bounds: [0, 5, 5] })).success).toBe(false);
    const summary = (q: number): BucketAgg => ({
      k: 'summary',
      count: 1,
      sum: 1,
      quantiles: [{ q, v: 1 }],
      lastTime: 0,
    });
    expect(BucketAggSchema.safeParse(summary(1)).success).toBe(true);
    expect(BucketAggSchema.safeParse(summary(1.5)).success).toBe(false);
    expect(BucketAggSchema.safeParse(summary(-0.1)).success).toBe(false);
  });
  it('accepts valid aggs and checks exp count including zeroCount', () => {
    expect(BucketAggSchema.safeParse(hist({})).success).toBe(true);
    const ok = exp({ count: 3, zeroCount: 1, positive: { offset: 0, counts: [2] } });
    expect(BucketAggSchema.safeParse(ok).success).toBe(true);
    expect(BucketAggSchema.safeParse({ ...ok, count: 2 }).success).toBe(false);
  });
});
