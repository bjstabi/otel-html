import { describe, expect, it } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { RelNanos } from '../../src/model/ids.js';
import type { MetricPointRecord, ResourceRef, ScopeRef } from '../../src/model/records.js';
import { StreamNormalizer } from '../../src/rollups/metric-streams.js';

const rel = (n: number): RelNanos => n as RelNanos;

function pt(o: Partial<Omit<MetricPointRecord, 'point'>> & { point: unknown }): MetricPointRecord {
  return {
    name: 'm',
    description: '',
    unit: '',
    type: 'sum',
    temporality: 'cumulative',
    monotonic: true,
    start: rel(0),
    time: rel(1),
    attributes: new Map(),
    flags: 0,
    resource: 0 as ResourceRef,
    scope: 0 as ScopeRef,
    ...o,
  };
}

const sum = (v: number, time: number, o: Partial<MetricPointRecord> = {}): MetricPointRecord =>
  pt({ time: rel(time), point: { asDouble: v }, ...o });

const hist = (counts: string[], time: number, o: Partial<MetricPointRecord> = {}): MetricPointRecord => {
  const total = counts.reduce((s, c) => s + Number(c), 0);
  return pt({
    type: 'histogram',
    time: rel(time),
    point: { count: String(total), sum: total, bucketCounts: counts, explicitBounds: [10] },
    ...o,
  });
};

function deltaOf(n: ReturnType<StreamNormalizer['normalize']>): {
  delta: number;
  resets: number;
  reset: boolean;
} {
  if (n.kind !== 'ok' || n.agg.k !== 'counter') throw new Error(`not an ok counter: ${JSON.stringify(n)}`);
  return { delta: n.agg.delta, resets: n.agg.resets, reset: n.reset };
}

describe('StreamNormalizer', () => {
  it('turns cumulative counter points into deltas and flags a reset', () => {
    const s = new StreamNormalizer();
    const out = [sum(5, 1), sum(8, 2), sum(2, 3)].map((p) => deltaOf(s.normalize(0, p)));
    expect(out).toEqual([
      { delta: 5, resets: 0, reset: false },
      { delta: 3, resets: 0, reset: false },
      { delta: 2, resets: 1, reset: true },
    ]);
  });

  it('keeps streams with different starts apart', () => {
    const s = new StreamNormalizer();
    const A = rel(10);
    const B = rel(20);
    const out = [
      sum(5, 100, { start: A }),
      sum(3, 101, { start: B }),
      sum(9, 102, { start: A }),
      sum(4, 103, { start: B }),
    ].map((p) => deltaOf(s.normalize(0, p)));
    expect(out.map((o) => o.delta)).toEqual([5, 3, 4, 1]);
    expect(out.some((o) => o.reset)).toBe(false);
  });

  it('keeps series apart', () => {
    const s = new StreamNormalizer();
    expect(deltaOf(s.normalize(0, sum(5, 1))).delta).toBe(5);
    expect(deltaOf(s.normalize(1, sum(7, 2))).delta).toBe(7);
  });

  it('treats the first point of a null-start stream as a baseline', () => {
    const s = new StreamNormalizer();
    expect(deltaOf(s.normalize(0, sum(50, 1, { start: null }))).delta).toBe(0);
    expect(deltaOf(s.normalize(0, sum(53, 2, { start: null }))).delta).toBe(3);
  });

  it('treats unspecified temporality like cumulative', () => {
    const s = new StreamNormalizer();
    s.normalize(0, sum(5, 1, { temporality: 'unspecified' }));
    expect(deltaOf(s.normalize(0, sum(8, 2, { temporality: 'unspecified' }))).delta).toBe(3);
  });

  it('accepts delta points in any order', () => {
    const s = new StreamNormalizer();
    const d = (v: number, t: number): MetricPointRecord => sum(v, t, { temporality: 'delta' });
    for (const p of [d(1, 5), d(2, 3), d(4, 4)]) expect(s.normalize(0, p).kind).toBe('ok');
    expect(deltaOf(s.normalize(0, d(7, 1))).delta).toBe(7);
  });

  it('skips a cumulative point older than the last one', () => {
    const s = new StreamNormalizer();
    s.normalize(0, sum(5, 10));
    expect(s.normalize(0, sum(6, 9))).toEqual({ kind: 'skip', reason: 'out-of-order' });
    expect(s.normalize(0, sum(6, 10))).toEqual({ kind: 'skip', reason: 'out-of-order' });
    expect(deltaOf(s.normalize(0, sum(6, 11))).delta).toBe(1);
  });

  it('skips points that carry no value', () => {
    const s = new StreamNormalizer();
    const nan = pt({ type: 'gauge', point: { asDouble: 'NaN' } });
    expect(s.normalize(0, nan)).toEqual({ kind: 'skip', reason: 'no-value' });
    const flagged = pt({ type: 'gauge', flags: 1, point: { asDouble: 3 } });
    expect(s.normalize(0, flagged)).toEqual({ kind: 'skip', reason: 'no-value' });
    const empty = hist(['0', '0'], 1, { temporality: 'delta' });
    expect(s.normalize(0, empty)).toEqual({ kind: 'skip', reason: 'no-value' });
    const badSum = pt({
      type: 'histogram',
      temporality: 'delta',
      point: { count: '1', sum: 'Infinity', bucketCounts: ['1', '0'], explicitBounds: [1] },
    });
    expect(s.normalize(0, badSum)).toEqual({ kind: 'skip', reason: 'no-value' });
  });

  it('makes gauges and non-monotonic sums number aggregates', () => {
    const s = new StreamNormalizer();
    const g = s.normalize(0, pt({ type: 'gauge', time: rel(7), point: { asInt: '42' } }));
    expect(g).toEqual({
      kind: 'ok',
      reset: false,
      agg: { k: 'number', count: 1, sum: 42, min: 42, max: 42, last: 42, lastTime: 7 },
    });
    const n = s.normalize(0, sum(-3, 8, { monotonic: false }));
    expect(n.kind === 'ok' && n.agg.k).toBe('number');
  });

  it('keeps a delta histogram as is', () => {
    const s = new StreamNormalizer();
    const n = s.normalize(0, hist(['1', '2'], 1, { temporality: 'delta' }));
    expect(n).toEqual({
      kind: 'ok',
      reset: false,
      agg: { k: 'hist', count: 3, sum: 3, min: null, max: null, bounds: [10], counts: [1, 2] },
    });
  });

  it('differences cumulative histogram counts', () => {
    const s = new StreamNormalizer();
    const first = s.normalize(0, hist(['1', '1'], 1));
    expect(first.kind === 'ok' && first.agg.k === 'hist' && first.agg.counts).toEqual([1, 1]);
    const n = s.normalize(0, hist(['3', '2'], 2));
    expect(n.kind === 'ok' && n.agg.k === 'hist' && n.agg.counts).toEqual([2, 1]);
    expect(n.kind === 'ok' && n.agg.k === 'hist' && [n.agg.count, n.agg.sum]).toEqual([3, 3]);
    expect(n.kind === 'ok' && n.reset).toBe(false);
  });

  it('treats a drop in cumulative histogram count as a reset', () => {
    const s = new StreamNormalizer();
    s.normalize(0, hist(['3', '2'], 1));
    const n = s.normalize(0, hist(['1', '0'], 2));
    expect(n.kind === 'ok' && n.reset).toBe(true);
    expect(n.kind === 'ok' && n.agg.k === 'hist' && n.agg.counts).toEqual([1, 0]);
  });

  it('gives a null-start first cumulative histogram a zero delta', () => {
    const s = new StreamNormalizer();
    const n = s.normalize(0, hist(['4', '1'], 1, { start: null }));
    expect(n.kind === 'ok' && n.agg.k === 'hist' && [n.agg.count, ...n.agg.counts]).toEqual([0, 0, 0]);
  });

  it('differences cumulative exponential histograms', () => {
    const s = new StreamNormalizer();
    const e = (pos: string[], zero: string, time: number): MetricPointRecord => {
      const count = pos.reduce((a, c) => a + Number(c), Number(zero));
      return pt({
        type: 'exponentialHistogram',
        time: rel(time),
        point: {
          count: String(count),
          sum: count,
          scale: 0,
          zeroCount: zero,
          positive: { offset: 2, bucketCounts: pos },
        },
      });
    };
    s.normalize(0, e(['1', '1'], '1', 1));
    const n = s.normalize(0, e(['1', '3', '2'], '2', 2));
    expect(n.kind === 'ok' && n.agg.k === 'exp' && n.agg.positive).toEqual({ offset: 3, counts: [2, 2] });
    expect(n.kind === 'ok' && n.agg.k === 'exp' && [n.agg.count, n.agg.zeroCount]).toEqual([5, 1]);
  });

  it('makes summaries from the point', () => {
    const s = new StreamNormalizer();
    const n = s.normalize(
      0,
      pt({
        type: 'summary',
        time: rel(9),
        point: { count: '4', sum: 10, quantileValues: [{ quantile: 0.5, value: 2 }, { value: 1 }] },
      }),
    );
    expect(n).toEqual({
      kind: 'ok',
      reset: false,
      agg: {
        k: 'summary',
        count: 4,
        sum: 10,
        quantiles: [
          { q: 0.5, v: 2 },
          { q: 0, v: 1 },
        ],
        lastTime: 9,
      },
    });
  });

  it('continues a stream after toJSON and from', () => {
    const s = new StreamNormalizer();
    s.normalize(0, sum(5, 1));
    s.normalize(1, hist(['3', '2'], 1));
    const copy = StreamNormalizer.from(JSON.parse(JSON.stringify(s.toJSON())), 'streams');
    expect(deltaOf(copy.normalize(0, sum(8, 2))).delta).toBe(3);
    expect(copy.normalize(0, sum(9, 1))).toEqual({ kind: 'skip', reason: 'out-of-order' });
    const h = copy.normalize(1, hist(['4', '2'], 2));
    expect(h.kind === 'ok' && h.agg.k === 'hist' && h.agg.counts).toEqual([1, 0]);
  });

  it('rejects a malformed checkpoint', () => {
    expect(() => StreamNormalizer.from({ streams: 3 }, 'streams')).toThrow(OtelHtmlError);
  });

  it('fails fast on malformed points with invalid-otlp', () => {
    const s = new StreamNormalizer();
    const bad = pt({ type: 'gauge', point: { asDouble: 'abc' } });
    expect(() => s.normalize(0, bad)).toThrow(expect.objectContaining({ code: 'invalid-otlp' }));
    const mismatch = pt({
      type: 'histogram',
      temporality: 'delta',
      point: { count: '1', bucketCounts: ['1'], explicitBounds: [1] },
    });
    expect(() => s.normalize(0, mismatch)).toThrow(expect.objectContaining({ code: 'invalid-otlp' }));
    const badCount = pt({
      type: 'histogram',
      temporality: 'delta',
      point: { count: '5', bucketCounts: ['1', '1'], explicitBounds: [1] },
    });
    expect(() => s.normalize(0, badCount)).toThrow(expect.objectContaining({ code: 'invalid-otlp' }));
  });

  it('rejects an exponential histogram scale outside [-10, 20] or a bucket index a double cannot reach', () => {
    const e = (scale: number, offset: number, counts = ['1']): MetricPointRecord =>
      pt({
        type: 'exponentialHistogram',
        temporality: 'delta',
        point: { count: String(counts.length), scale, positive: { offset, bucketCounts: counts } },
      });
    const s = new StreamNormalizer();
    for (const [scale, path] of [
      [21, 'point.scale'],
      [-11, 'point.scale'],
      [32, 'point.scale'],
    ] as const) {
      expect(() => s.normalize(0, e(scale, 0))).toThrow(
        expect.objectContaining({ code: 'invalid-otlp', path: `metric "m".${path}` }),
      );
    }
    // Outside int32 (where `>>` would wrap), and inside int32 but beyond any double at that scale.
    for (const [scale, offset] of [
      [0, 2 ** 31],
      [0, -(2 ** 31) - 1],
      [20, 2 ** 31 - 1],
      [-10, 3],
      [0, 1200],
    ] as const) {
      expect(() => s.normalize(0, e(scale, offset))).toThrow(
        expect.objectContaining({ code: 'invalid-otlp', path: 'metric "m".point.positive.offset' }),
      );
    }
    // The last bucket counts too, not only the offset.
    expect(() => s.normalize(0, e(-10, 1, ['1', '1']))).toThrow(
      expect.objectContaining({ code: 'invalid-otlp', path: 'metric "m".point.positive.offset' }),
    );
    // The extremes a double can reach are fine.
    for (const [scale, offset] of [
      [20, 1024 * 2 ** 20 - 1],
      [20, -1075 * 2 ** 20],
      [-10, -2],
      [-10, 0],
    ] as const) {
      expect(s.normalize(0, e(scale, offset)).kind).toBe('ok');
    }
  });

  it('prepare parses without touching streams; its step applies the point', () => {
    const s = new StreamNormalizer();
    const steps = [sum(5, 1), sum(8, 2)].map((p) => s.prepare(p));
    expect(s.toJSON()).toEqual({ keys: [], times: [], lasts: [], seriesKeys: [], seriesTimes: [] });
    expect(() => s.prepare(pt({ type: 'gauge', point: { asDouble: 'abc' } }))).toThrow(OtelHtmlError);
    expect(steps.map((step) => deltaOf(step('0/0')).delta)).toEqual([5, 3]);
    // string keys tell apart equal series ids of different metrics
    expect(deltaOf(s.normalize('1/0', sum(2, 3))).delta).toBe(2);
  });

  it("counts a new start after the series' latest point as a restart, a concurrent one as another producer", () => {
    const s = new StreamNormalizer();
    const at = (v: number, time: number, start: number) =>
      deltaOf(s.normalize('m/0', sum(v, time, { start: rel(start) })));
    expect(at(10, 10, 1)).toEqual({ delta: 10, resets: 0, reset: false });
    // a second producer, started before the first one's latest point
    expect(at(100, 15, 5)).toEqual({ delta: 100, resets: 0, reset: false });
    expect(at(20, 20, 1)).toEqual({ delta: 10, resets: 0, reset: false });
    expect(at(150, 25, 5)).toEqual({ delta: 50, resets: 0, reset: false });
    // the first producer restarts: its new start is after everything seen
    expect(at(3, 40, 30)).toEqual({ delta: 3, resets: 1, reset: true });
    expect(at(7, 50, 30)).toEqual({ delta: 4, resets: 0, reset: false });
    // and the state survives a checkpoint
    const back = StreamNormalizer.from(JSON.parse(JSON.stringify(s.toJSON())), 'streams');
    expect(deltaOf(back.normalize('m/0', sum(4, 60, { start: rel(55) })))).toMatchObject({ reset: true });
  });
});
