import { z } from 'zod';
import { parseWith } from '../format/validate.js';
import { OtelHtmlError } from '../model/errors.js';
import type { MetricPointRecord } from '../model/records.js';
import {
  type BucketAgg,
  BucketAggSchema,
  downscaleExp,
  type ExpAgg,
  type ExpSide,
  type HistAgg,
} from './metric-agg.js';

export type Normalized =
  | { kind: 'ok'; agg: BucketAgg; reset: boolean }
  | { kind: 'skip'; reason: 'out-of-order' | 'no-value' };

/** Flag bit 1 of an OTLP data point: the point records that no value was observed. */
const NO_RECORDED_VALUE = 1;

type AggKind = BucketAgg['k'];
type Temporality = MetricPointRecord['temporality'];

interface Rule {
  readonly type: MetricPointRecord['type'];
  readonly temporality: Temporality | '*';
  readonly monotonic: boolean | '*';
  readonly agg: AggKind;
  /** Cumulative points are differenced against the stream's previous point. */
  readonly cumulative: boolean;
}

/** First matching row wins. */
const RULES: readonly Rule[] = [
  { type: 'gauge', temporality: '*', monotonic: '*', agg: 'number', cumulative: false },
  { type: 'sum', temporality: '*', monotonic: false, agg: 'number', cumulative: false },
  { type: 'sum', temporality: 'delta', monotonic: true, agg: 'counter', cumulative: false },
  { type: 'sum', temporality: 'cumulative', monotonic: true, agg: 'counter', cumulative: true },
  { type: 'sum', temporality: 'unspecified', monotonic: true, agg: 'counter', cumulative: true },
  { type: 'histogram', temporality: 'delta', monotonic: '*', agg: 'hist', cumulative: false },
  { type: 'histogram', temporality: 'cumulative', monotonic: '*', agg: 'hist', cumulative: true },
  { type: 'histogram', temporality: 'unspecified', monotonic: '*', agg: 'hist', cumulative: false },
  { type: 'exponentialHistogram', temporality: 'delta', monotonic: '*', agg: 'exp', cumulative: false },
  { type: 'exponentialHistogram', temporality: 'cumulative', monotonic: '*', agg: 'exp', cumulative: true },
  { type: 'exponentialHistogram', temporality: 'unspecified', monotonic: '*', agg: 'exp', cumulative: false },
  { type: 'summary', temporality: '*', monotonic: '*', agg: 'summary', cumulative: false },
];

function ruleFor(p: MetricPointRecord): Rule {
  const r = RULES.find(
    (x) =>
      x.type === p.type &&
      (x.temporality === '*' || x.temporality === p.temporality) &&
      (x.monotonic === '*' || x.monotonic === p.monotonic),
  );
  if (r === undefined) {
    throw new OtelHtmlError('invalid-otlp', {
      path: `metric ${JSON.stringify(p.name)}`,
      expected: 'a known metric type and temporality',
      actual: `${p.type}/${p.temporality}/${p.monotonic ? 'monotonic' : 'non-monotonic'}`,
    });
  }
  return r;
}

// Point JSON is protobuf-JSON: 64-bit integers are strings, special doubles are "NaN"/"Infinity".
const NUMBER_TEXT = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|NaN|-?Infinity)$/;
const wire = z.union([z.number(), z.string().regex(NUMBER_TEXT)]).transform(Number);
const wireInt = z.union([z.number(), z.string().regex(/^-?\d+$/)]).transform(Number);

const ValuePointSchema = z.object({ asDouble: wire.optional(), asInt: wireInt.optional() });
const HistPointSchema = z.object({
  count: wireInt.default(0),
  sum: wire.optional(),
  min: wire.optional(),
  max: wire.optional(),
  bucketCounts: z.array(wireInt).default([]),
  explicitBounds: z.array(wire).default([]),
});
const ExpSideWireSchema = z.object({
  offset: wireInt.default(0),
  bucketCounts: z.array(wireInt).default([]),
});
const ExpPointSchema = z.object({
  count: wireInt.default(0),
  sum: wire.optional(),
  min: wire.optional(),
  max: wire.optional(),
  scale: wireInt.default(0),
  zeroCount: wireInt.default(0),
  zeroThreshold: wire.default(0),
  positive: ExpSideWireSchema.default({ offset: 0, bucketCounts: [] }),
  negative: ExpSideWireSchema.default({ offset: 0, bucketCounts: [] }),
});
const SummaryPointSchema = z.object({
  count: wireInt.default(0),
  sum: wire.default(0),
  quantileValues: z.array(z.object({ quantile: wire.default(0), value: wire.default(0) })).default([]),
});

function malformed(p: MetricPointRecord, path: string, expected: string, actual: string): OtelHtmlError {
  return new OtelHtmlError('invalid-otlp', {
    path: `metric ${JSON.stringify(p.name)}${path === '' ? '' : `.${path}`}`,
    expected,
    actual,
  });
}

function parsePoint<S extends z.ZodType>(schema: S, p: MetricPointRecord): z.output<S> {
  const r = schema.safeParse(p.point);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const path = ['point', ...(issue?.path ?? []).map(String)].join('.');
  throw malformed(p, path, `a valid ${p.type} point`, issue?.message ?? 'invalid value');
}

function checkCounts(p: MetricPointRecord, path: string, counts: readonly number[]): void {
  for (const [i, c] of counts.entries()) {
    if (!Number.isSafeInteger(c) || c < 0) {
      throw malformed(p, `${path}[${i}]`, 'a non-negative integer', String(c));
    }
  }
}

const sumOf = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
const finiteOrNull = (n: number | undefined): number | null =>
  n !== undefined && Number.isFinite(n) ? n : null;

function histOf(p: MetricPointRecord): HistAgg | null {
  const d = parsePoint(HistPointSchema, p);
  checkCounts(p, 'point.bucketCounts', d.bucketCounts);
  checkCounts(p, 'point.count', [d.count]);
  if (d.sum !== undefined && !Number.isFinite(d.sum)) return null;
  if (d.explicitBounds.some((b) => !Number.isFinite(b))) {
    throw malformed(p, 'point.explicitBounds', 'finite numbers', JSON.stringify(d.explicitBounds));
  }
  const counts = d.bucketCounts.length === 0 && d.explicitBounds.length === 0 ? [d.count] : d.bucketCounts;
  if (counts.length !== d.explicitBounds.length + 1) {
    throw malformed(p, 'point.bucketCounts', `${d.explicitBounds.length + 1} entries`, String(counts.length));
  }
  if (sumOf(counts) !== d.count) {
    throw malformed(p, 'point.count', `sum of bucketCounts (${sumOf(counts)})`, String(d.count));
  }
  return {
    k: 'hist',
    count: d.count,
    sum: d.sum ?? 0,
    min: finiteOrNull(d.min),
    max: finiteOrNull(d.max),
    bounds: d.explicitBounds,
    counts,
  };
}

function expOf(p: MetricPointRecord): ExpAgg | null {
  const d = parsePoint(ExpPointSchema, p);
  const sides = [
    ['positive', d.positive],
    ['negative', d.negative],
  ] as const;
  for (const [name, s] of sides) {
    checkCounts(p, `point.${name}.bucketCounts`, s.bucketCounts);
    if (!Number.isSafeInteger(s.offset))
      throw malformed(p, `point.${name}.offset`, 'an integer', String(s.offset));
  }
  checkCounts(p, 'point.zeroCount', [d.zeroCount]);
  checkCounts(p, 'point.count', [d.count]);
  if (d.sum !== undefined && !Number.isFinite(d.sum)) return null;
  if (!Number.isFinite(d.zeroThreshold) || d.zeroThreshold < 0) {
    throw malformed(p, 'point.zeroThreshold', 'a finite non-negative number', String(d.zeroThreshold));
  }
  const total = d.zeroCount + sumOf(d.positive.bucketCounts) + sumOf(d.negative.bucketCounts);
  if (total !== d.count)
    throw malformed(p, 'point.count', `sum of bucket counts (${total})`, String(d.count));
  return {
    k: 'exp',
    count: d.count,
    sum: d.sum ?? 0,
    min: finiteOrNull(d.min),
    max: finiteOrNull(d.max),
    scale: d.scale,
    zeroCount: d.zeroCount,
    zeroThreshold: d.zeroThreshold,
    positive: { offset: d.positive.offset, counts: d.positive.bucketCounts },
    negative: { offset: d.negative.offset, counts: d.negative.bucketCounts },
  };
}

function numberValueOf(p: MetricPointRecord): number | null {
  const d = parsePoint(ValuePointSchema, p);
  const v = d.asDouble ?? d.asInt;
  return v !== undefined && Number.isFinite(v) ? v : null;
}

function summaryOf(p: MetricPointRecord): BucketAgg | null {
  const d = parsePoint(SummaryPointSchema, p);
  checkCounts(p, 'point.count', [d.count]);
  if (!Number.isFinite(d.sum)) return null;
  return {
    k: 'summary',
    count: d.count,
    sum: d.sum,
    quantiles: d.quantileValues
      .filter((q) => Number.isFinite(q.quantile) && Number.isFinite(q.value))
      .map((q) => ({ q: q.quantile, v: q.value })),
    lastTime: p.time,
  };
}

const emptyHist = (h: HistAgg): HistAgg => ({
  ...h,
  count: 0,
  sum: 0,
  min: null,
  max: null,
  counts: h.counts.map(() => 0),
});
const emptyExp = (e: ExpAgg): ExpAgg => ({
  ...e,
  count: 0,
  sum: 0,
  min: null,
  max: null,
  zeroCount: 0,
  positive: { offset: 0, counts: [] },
  negative: { offset: 0, counts: [] },
});

function sameBounds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Cumulative `cur` minus `prev`; null when something dropped, which means the stream was reset. */
function diffHist(cur: HistAgg, prev: HistAgg): HistAgg | null {
  if (!sameBounds(cur.bounds, prev.bounds) || cur.count < prev.count) return null;
  const counts = cur.counts.map((c, i) => c - (prev.counts[i] ?? 0));
  if (counts.some((c) => c < 0)) return null;
  return {
    k: 'hist',
    count: cur.count - prev.count,
    sum: cur.sum - prev.sum,
    min: null,
    max: null,
    bounds: cur.bounds,
    counts,
  };
}

function trimSide(offset: number, counts: number[]): ExpSide {
  let lo = 0;
  let hi = counts.length;
  while (lo < hi && counts[lo] === 0) lo++;
  while (hi > lo && counts[hi - 1] === 0) hi--;
  return lo === hi ? { offset: 0, counts: [] } : { offset: offset + lo, counts: counts.slice(lo, hi) };
}

function diffSide(cur: ExpSide, prev: ExpSide): ExpSide | null {
  const counts = [...cur.counts];
  for (const [j, c] of prev.counts.entries()) {
    if (c === 0) continue;
    const i = prev.offset + j - cur.offset;
    const have = counts[i];
    if (have === undefined || have < c) return null;
    counts[i] = have - c;
  }
  return trimSide(cur.offset, counts);
}

function diffExp(cur: ExpAgg, prev: ExpAgg): ExpAgg | null {
  if (cur.count < prev.count || cur.scale > prev.scale || cur.zeroThreshold !== prev.zeroThreshold)
    return null;
  const old = downscaleExp(prev, cur.scale);
  const positive = diffSide(cur.positive, old.positive);
  const negative = diffSide(cur.negative, old.negative);
  if (positive === null || negative === null || cur.zeroCount < old.zeroCount) return null;
  return {
    ...cur,
    count: cur.count - prev.count,
    sum: cur.sum - prev.sum,
    min: null,
    max: null,
    zeroCount: cur.zeroCount - old.zeroCount,
    positive,
    negative,
  };
}

/** What a cumulative stream remembers: the previous value (counters) or counts (histograms). */
export interface SerializedStreams {
  streams: { key: string; time: number; last: number | BucketAgg }[];
}
const SerializedStreamsSchema: z.ZodType<SerializedStreams> = z.strictObject({
  streams: z.array(
    z.strictObject({
      key: z.string(),
      time: z.number().finite(),
      last: z.union([z.number().finite(), BucketAggSchema]),
    }),
  ),
});

interface Stream {
  time: number;
  last: number | BucketAgg;
}

/**
 * Turns each metric point into a mergeable delta. Cumulative streams (a series plus its start time) remember
 * their previous point; everything else is stateless.
 */
export class StreamNormalizer {
  readonly #streams = new Map<string, Stream>();

  normalize(seriesId: number, p: MetricPointRecord): Normalized {
    if ((p.flags & NO_RECORDED_VALUE) !== 0) return { kind: 'skip', reason: 'no-value' };
    const rule = ruleFor(p);
    switch (rule.agg) {
      case 'number': {
        const v = numberValueOf(p);
        if (v === null) return SKIP_NO_VALUE;
        return ok({ k: 'number', count: 1, sum: v, min: v, max: v, last: v, lastTime: p.time });
      }
      case 'summary': {
        const agg = summaryOf(p);
        return agg === null ? SKIP_NO_VALUE : ok(agg);
      }
      case 'counter': {
        const v = numberValueOf(p);
        if (v === null) return SKIP_NO_VALUE;
        if (!rule.cumulative) return ok({ k: 'counter', delta: v, resets: 0 });
        return this.#cumulative(
          seriesId,
          p,
          v,
          (cur, prev) => (cur < prev ? null : cur - prev),
          asCounter,
          () => 0,
        );
      }
      case 'hist': {
        const h = histOf(p);
        if (h === null) return SKIP_NO_VALUE;
        if (!rule.cumulative) return h.count === 0 ? SKIP_NO_VALUE : ok(h);
        return this.#cumulative(seriesId, p, h, diffHist, asHist, emptyHist);
      }
      case 'exp': {
        const e = expOf(p);
        if (e === null) return SKIP_NO_VALUE;
        if (!rule.cumulative) return e.count === 0 ? SKIP_NO_VALUE : ok(e);
        return this.#cumulative(seriesId, p, e, diffExp, asExp, emptyExp);
      }
      default:
        return assertNeverKind(rule.agg);
    }
  }

  /**
   * `diff` returns null for a reset, in which case the point's own value counts. The first point of a stream
   * counts in full when the stream has a start time, and is only a baseline otherwise.
   */
  #cumulative<T extends number | HistAgg | ExpAgg>(
    seriesId: number,
    p: MetricPointRecord,
    cur: T,
    diff: (cur: T, prev: T) => T | null,
    recall: (last: number | BucketAgg) => T | null,
    zero: (cur: T) => T,
  ): Normalized {
    const key = `${seriesId}:${p.start ?? 'none'}`;
    const prev = this.#streams.get(key);
    if (prev !== undefined && p.time <= prev.time) return { kind: 'skip', reason: 'out-of-order' };
    this.#streams.set(key, { time: p.time, last: cur });
    if (prev === undefined) return wrap(p.start === null ? zero(cur) : cur, false);
    const before = recall(prev.last);
    const delta = before === null ? null : diff(cur, before);
    return delta === null ? wrap(cur, true) : wrap(delta, false);
  }

  toJSON(): SerializedStreams {
    return { streams: [...this.#streams].map(([key, s]) => ({ key, time: s.time, last: s.last })) };
  }

  static from(input: unknown, root: string): StreamNormalizer {
    const s = parseWith(SerializedStreamsSchema, input, root);
    const n = new StreamNormalizer();
    for (const e of s.streams) n.#streams.set(e.key, { time: e.time, last: e.last });
    return n;
  }
}

const SKIP_NO_VALUE: Normalized = { kind: 'skip', reason: 'no-value' };

function ok(agg: BucketAgg): Normalized {
  return { kind: 'ok', agg, reset: false };
}

function wrap(v: number | HistAgg | ExpAgg, reset: boolean): Normalized {
  const agg: BucketAgg = typeof v === 'number' ? { k: 'counter', delta: v, resets: reset ? 1 : 0 } : v;
  return { kind: 'ok', agg, reset };
}

const asCounter = (last: number | BucketAgg): number | null => (typeof last === 'number' ? last : null);
const asHist = (last: number | BucketAgg): HistAgg | null =>
  typeof last !== 'number' && last.k === 'hist' ? last : null;
const asExp = (last: number | BucketAgg): ExpAgg | null =>
  typeof last !== 'number' && last.k === 'exp' ? last : null;

function assertNeverKind(x: never): never {
  throw new OtelHtmlError('invalid-report', {
    path: 'metric-streams',
    expected: 'known aggregate kind',
    actual: String(x),
  });
}
