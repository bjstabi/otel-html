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
  expIndexRange,
  type HistAgg,
  MAX_EXP_SCALE,
  MIN_EXP_SCALE,
} from './metric-agg.js';

export type Normalized =
  /** `evicted`: making room for this point's folded series dropped another's stream state (see `foldedPerMetric`). */
  | { kind: 'ok'; agg: BucketAgg; reset: boolean; evicted?: true }
  | { kind: 'skip'; reason: 'out-of-order' | 'no-value' };

/** A series' identity for stream state: unique across the report, e.g. `<metric id>/<series id>`. */
export type SeriesKey = string | number;

/** Where a point's stream state lives, when a plain `SeriesKey` is not enough. */
export interface StreamTarget {
  series: SeriesKey;
  /**
   * The metric id, for a series folded into the metric's `other` series (keyed by `foldedSeriesKey`): such series
   * are not capped by the catalog, so the normalizer keeps only the most recently used `foldedPerMetric` of them.
   */
  foldedIn?: number;
  /**
   * The input report, when a merge replays several one after another. A new stream is a reset only after a point
   * of the same report: the next report's streams are separate runs, not restarts (spec §5.2).
   */
  origin?: number | undefined;
}

/** A 32-bit xor-multiply hash of `s` (FNV-1a when given FNV's basis and prime), as 8 hex chars. */
function hash32(s: string, basis: number, prime: number): string {
  let h = basis >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, prime) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The stream key of a series folded into `other`: its catalog identity (`foldKey`, the full series key) hashed to
 * 64 bits, so the state a folded series costs does not grow with its attributes.
 */
export function foldedSeriesKey(metricId: number, foldKey: string): string {
  // Two different multipliers, so the halves collide independently.
  return `${metricId}/~${hash32(foldKey, 0x811c9dc5, 0x01000193)}${hash32(foldKey, 0x9747b28c, 0x5bd1e995)}`;
}

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
  if (
    d.explicitBounds.some((b, i) => !Number.isFinite(b) || (i > 0 && b <= (d.explicitBounds[i - 1] ?? b)))
  ) {
    throw malformed(
      p,
      'point.explicitBounds',
      'finite numbers in ascending order',
      JSON.stringify(d.explicitBounds),
    );
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
  if (d.scale < MIN_EXP_SCALE || d.scale > MAX_EXP_SCALE) {
    throw malformed(p, 'point.scale', `an integer in [${MIN_EXP_SCALE}, ${MAX_EXP_SCALE}]`, String(d.scale));
  }
  // A bucket no double falls in is malformed, and bounding the indexes keeps every bucket shift exact.
  const range = expIndexRange(d.scale);
  for (const [name, s] of sides) {
    checkCounts(p, `point.${name}.bucketCounts`, s.bucketCounts);
    const last = s.offset + Math.max(0, s.bucketCounts.length - 1);
    if (!Number.isSafeInteger(s.offset) || s.offset < range.min || last > range.max) {
      throw malformed(
        p,
        `point.${name}.offset`,
        `bucket indexes in [${range.min}, ${range.max}] at scale ${d.scale}`,
        `${s.offset}..${last}`,
      );
    }
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

const INT_TEXT = /^-?\d+$/;

/** `asDouble`/`asInt` read without Zod (most points); undefined when a field needs the full parse. */
function plainValue(raw: unknown, text: RegExp): number | undefined | null {
  if (raw === undefined) return null;
  if (typeof raw === 'number') return raw;
  return typeof raw === 'string' && text.test(raw) ? Number(raw) : undefined;
}

function numberValueOf(p: MetricPointRecord): number | null {
  // Fast path for the common shapes; anything else goes through the schema, which also reports the error.
  if (typeof p.point === 'object' && p.point !== null) {
    const dbl = plainValue(Reflect.get(p.point, 'asDouble'), NUMBER_TEXT);
    const int = plainValue(Reflect.get(p.point, 'asInt'), INT_TEXT);
    if (dbl !== undefined && int !== undefined) {
      const v = dbl ?? int;
      return v !== null && Number.isFinite(v) ? v : null;
    }
  }
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
      .filter((q) => q.quantile >= 0 && q.quantile <= 1 && Number.isFinite(q.value))
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

function diffExp(given: ExpAgg, prev: ExpAgg): ExpAgg | null {
  if (given.count < prev.count || given.zeroThreshold !== prev.zeroThreshold) return null;
  // SDKs only lower the scale within a stream; a higher one is compared at the previous (coarser) scale, not
  // taken for a reset.
  const scale = Math.min(given.scale, prev.scale);
  const cur = downscaleExp(given, scale);
  const old = downscaleExp(prev, scale);
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

/**
 * Checkpointed state, columnar (one entry per cumulative stream, then one per series): what each stream
 * remembers is its previous value (counters) or counts (histograms); per series, the time of its latest point.
 */
export interface SerializedStreams {
  keys: string[];
  times: number[];
  lasts: (number | BucketAgg)[];
  seriesKeys: string[];
  seriesTimes: number[];
  /** Per metric with folded series: their series keys, least recently used first. */
  folded: [number, string[]][];
}

const SerializedStreamsSchema: z.ZodType<SerializedStreams> = z
  .strictObject({
    keys: z.array(z.string()),
    times: z.array(z.number().finite()),
    lasts: z.array(z.union([z.number().finite(), BucketAggSchema])),
    seriesKeys: z.array(z.string()),
    seriesTimes: z.array(z.number().finite()),
    folded: z.array(z.tuple([z.number().int().nonnegative(), z.array(z.string())])).default([]),
  })
  .refine((s) => s.times.length === s.keys.length && s.lasts.length === s.keys.length, {
    message: 'one time and one last value per stream key',
    path: ['keys'],
  })
  .refine((s) => s.seriesTimes.length === s.seriesKeys.length, {
    message: 'one time per series key',
    path: ['seriesKeys'],
  });

interface Stream {
  time: number;
  last: number | BucketAgg;
}

export interface StreamNormalizerOptions {
  /** Most folded series (`StreamTarget.foldedIn`) whose streams are kept per metric; the default is unbounded. */
  foldedPerMetric?: number;
}

/**
 * Turns each metric point into a mergeable delta. Cumulative streams (a series plus its start time) remember
 * their previous point; everything else is stateless.
 */
export class StreamNormalizer {
  readonly #streams = new Map<string, Stream>();
  /** Time of each series' latest cumulative point, over all its streams: tells a restart from a second producer. */
  readonly #latest = new Map<string, number>();
  /** The input report of each series' latest point, for points that name one (merge only; never checkpointed). */
  readonly #latestOrigin = new Map<string, number>();
  /** Per metric, its folded series (least recently used first) and the stream keys of each. */
  readonly #folded = new Map<number, Map<string, Set<string>>>();
  readonly #foldedPerMetric: number;

  constructor(opts: StreamNormalizerOptions = {}) {
    this.#foldedPerMetric = opts.foldedPerMetric ?? Number.POSITIVE_INFINITY;
  }

  /** `series` identifies the point's series across the whole report (series ids alone repeat per metric). */
  normalize(series: SeriesKey | StreamTarget, p: MetricPointRecord): Normalized {
    return this.prepare(p)(series);
  }

  /**
   * Parses `p`, throwing `invalid-otlp` when it is malformed, without touching any stream. The returned step
   * normalizes it for a series (updating the stream of a cumulative point) and never throws, so a caller can
   * check a whole request before applying any of it.
   */
  prepare(p: MetricPointRecord): (series: SeriesKey | StreamTarget) => Normalized {
    if ((p.flags & NO_RECORDED_VALUE) !== 0) return () => SKIP_NO_VALUE;
    const rule = ruleFor(p);
    switch (rule.agg) {
      case 'number': {
        const v = numberValueOf(p);
        if (v === null) return done(SKIP_NO_VALUE);
        return done(ok({ k: 'number', count: 1, sum: v, min: v, max: v, last: v, lastTime: p.time }));
      }
      case 'summary': {
        const agg = summaryOf(p);
        return done(agg === null ? SKIP_NO_VALUE : ok(agg));
      }
      case 'counter': {
        const v = numberValueOf(p);
        if (v === null) return done(SKIP_NO_VALUE);
        if (!rule.cumulative) return done(ok({ k: 'counter', delta: v, resets: 0 }));
        return (series) => this.#cumulative(series, p, v, diffCounter, asCounter, zeroCounter);
      }
      case 'hist': {
        const h = histOf(p);
        if (h === null) return done(SKIP_NO_VALUE);
        if (!rule.cumulative) return done(h.count === 0 ? SKIP_NO_VALUE : ok(h));
        return (series) => this.#cumulative(series, p, h, diffHist, asHist, emptyHist);
      }
      case 'exp': {
        const e = expOf(p);
        if (e === null) return done(SKIP_NO_VALUE);
        if (!rule.cumulative) return done(e.count === 0 ? SKIP_NO_VALUE : ok(e));
        return (series) => this.#cumulative(series, p, e, diffExp, asExp, emptyExp);
      }
      default:
        return assertNeverKind(rule.agg);
    }
  }

  /**
   * `diff` returns null for a reset, in which case the point's own value counts. The first point of a stream
   * counts in full when the stream has a start time, and is only a baseline otherwise. A new stream that starts
   * after the series' latest point is a restart and counts as a reset; one that starts earlier is another
   * producer sharing the series identity (or a report replayed by merge) and is not, and neither is one after the
   * latest point of an earlier report in a merge (`StreamTarget.origin`): that is the next run.
   */
  #cumulative<T extends number | HistAgg | ExpAgg>(
    target: SeriesKey | StreamTarget,
    p: MetricPointRecord,
    cur: T,
    diff: (cur: T, prev: T) => T | null,
    recall: (last: number | BucketAgg) => T | null,
    zero: (cur: T) => T,
  ): Normalized {
    const t: StreamTarget = typeof target === 'object' ? target : { series: target };
    const owner = String(t.series);
    const key = `${owner}:${p.start ?? 'none'}`;
    const prev = this.#streams.get(key);
    if (prev !== undefined && p.time <= prev.time) return { kind: 'skip', reason: 'out-of-order' };
    const evicted = t.foldedIn === undefined ? false : this.#touchFolded(t.foldedIn, owner, key);
    const latest = this.#latest.get(owner);
    const sameOrigin = this.#latestOrigin.get(owner) === t.origin;
    if (latest === undefined || p.time > latest) {
      this.#latest.set(owner, p.time);
      if (t.origin === undefined) this.#latestOrigin.delete(owner);
      else this.#latestOrigin.set(owner, t.origin);
    }
    if (prev === undefined) {
      this.#streams.set(key, { time: p.time, last: cur });
      const first =
        p.start === null
          ? wrap(zero(cur), false)
          : wrap(cur, latest !== undefined && sameOrigin && p.start > latest);
      return evicted && first.kind === 'ok' ? { ...first, evicted: true } : first;
    }
    const before = recall(prev.last);
    prev.time = p.time;
    prev.last = cur;
    const delta = before === null ? null : diff(cur, before);
    return delta === null ? wrap(cur, true) : wrap(delta, false);
  }

  /**
   * Marks folded series `owner` of metric `metric` most recently used, with stream `key`. A series new to the metric
   * beyond `foldedPerMetric` drops the least recently used one's state (returns true): that series' next point is
   * a new stream again, counted by the first-point rule.
   */
  #touchFolded(metric: number, owner: string, key: string): boolean {
    let lru = this.#folded.get(metric);
    if (lru === undefined) {
      lru = new Map();
      this.#folded.set(metric, lru);
    }
    const keys = lru.get(owner);
    if (keys !== undefined) {
      lru.delete(owner);
      lru.set(owner, keys.add(key));
      return false;
    }
    let evicted = false;
    for (const [old, oldKeys] of lru) {
      if (lru.size < this.#foldedPerMetric) break;
      lru.delete(old);
      this.#latest.delete(old);
      this.#latestOrigin.delete(old);
      for (const k of oldKeys) this.#streams.delete(k);
      evicted = true;
    }
    lru.set(owner, new Set([key]));
    return evicted;
  }

  toJSON(): SerializedStreams {
    const out: SerializedStreams = {
      keys: [],
      times: [],
      lasts: [],
      seriesKeys: [],
      seriesTimes: [],
      folded: [...this.#folded].map(([metric, lru]) => [metric, [...lru.keys()]]),
    };
    for (const [key, s] of this.#streams) {
      out.keys.push(key);
      out.times.push(s.time);
      out.lasts.push(s.last);
    }
    for (const [key, t] of this.#latest) {
      out.seriesKeys.push(key);
      out.seriesTimes.push(t);
    }
    return out;
  }

  static from(input: unknown, root: string, opts: StreamNormalizerOptions = {}): StreamNormalizer {
    const s = parseWith(SerializedStreamsSchema, input, root);
    const n = new StreamNormalizer(opts);
    // A folded series' streams are the stream keys `<series key>:<start>`.
    const streamsOf = new Map<string, Set<string>>();
    for (const [, series] of s.folded) for (const owner of series) streamsOf.set(owner, new Set());
    for (const key of s.keys) streamsOf.get(key.slice(0, key.lastIndexOf(':')))?.add(key);
    for (const [metric, series] of s.folded) {
      n.#folded.set(
        metric,
        new Map(series.map((owner) => [owner, streamsOf.get(owner) ?? new Set<string>()])),
      );
    }
    s.keys.forEach((key, i) => {
      const time = s.times[i];
      const last = s.lasts[i];
      if (time !== undefined && last !== undefined) n.#streams.set(key, { time, last });
    });
    s.seriesKeys.forEach((key, i) => {
      const time = s.seriesTimes[i];
      if (time !== undefined) n.#latest.set(key, time);
    });
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
const diffCounter = (cur: number, prev: number): number | null => (cur < prev ? null : cur - prev);
const zeroCounter = (): number => 0;
/** A step that ignores the series: the point's result does not depend on stream state. */
const done =
  (n: Normalized): (() => Normalized) =>
  () =>
    n;
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
