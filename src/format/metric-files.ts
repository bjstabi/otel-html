import { z } from 'zod';
import type { Attributes } from '../model/anyvalue.js';
import { OtelHtmlError } from '../model/errors.js';
import { type BucketAgg, BucketAggSchema, mergeAgg } from '../rollups/metric-agg.js';
import {
  decodeAttributes,
  encodeAttributes,
  type JsonAny,
  JsonAnySchema,
  type SeriesDef,
} from '../rollups/metric-catalog.js';
import { parseWith } from './validate.js';

/**
 * Per-metric series files under `data/metrics/<id6>/`, named by the metric's numeric id (never its name):
 * `series.js` (series definitions, plus each series' point gaps and a summary's quantiles after compaction),
 * `seg-<n6>.js` (level-0 buckets and exemplars since the previous flush), `l<k>.js` (level k after compaction),
 * `ex.js` (exemplars after compaction, for levels 0…EXEMPLAR_BASE_LEVEL) and `ex<k>.js` (the exemplars of a coarser
 * level k, format 2). A level or exemplar file whose buckets span more than one page of PAGE_BUCKETS is written as
 * one file per page instead (format 3): `l<k>-<p6>.js`, `ex-<p6>.js`, `ex<k>-<p6>.js`, so a chart reads only the
 * pages its window touches.
 */

/** Level 0 is 1 ms × 2^10, aligned like `TimeBuckets`; level k is LEVEL_FACTOR^k times wider. */
export const LEVEL0_WIDTH_NS = 1_024_000_000;
export const LEVEL_FACTOR = 8;
export const MAX_LEVEL = 6;
/** Compaction stops at the first level with at most this many buckets over the metric's time range. */
export const LEVEL_MAX_BUCKETS = 2000;
/** Exemplars are kept per series per bucket of this width (1 ms × 2^16): level 2's width. */
export const EXEMPLAR_WIDTH_NS = 65_536_000_000;
/**
 * `ex.js` serves levels 0…EXEMPLAR_BASE_LEVEL (its buckets are this level's). Each level k above it that a metric
 * has gets `ex<k>.js`, capped per series per level-k bucket, so the exemplars a chart loads are bounded like its
 * buckets.
 */
export const EXEMPLAR_BASE_LEVEL = 2;

/**
 * Buckets per page: page p of a level holds the bucket indexes in [p × PAGE_BUCKETS, (p + 1) × PAGE_BUCKETS). A
 * level in one page is one file; the coarsest level always is (LEVEL_MAX_BUCKETS < PAGE_BUCKETS), so a full-range
 * chart reads one file and a zoomed chart the page or two under its window. Exemplar files page on the grid of the
 * level they serve. A multiple of LEVEL_FACTOR³, so a page boundary of level k is a bucket boundary of levels up to
 * k + 3 (the counter running total relies on this; see `runAtLevel`).
 */
export const PAGE_BUCKETS = 2048;

/** The page holding bucket index `bucket`. */
export const pageOf = (bucket: number): number => Math.floor(bucket / PAGE_BUCKETS);

/**
 * A metric data file's path (`parseMetricFilePath` reads it): the groups are the metric id, the file name, a
 * segment number, a level and its page, an exemplar level and its page.
 */
export const METRIC_FILE_PATH: RegExp =
  /^data\/metrics\/([0-9]{6})\/(series|seg-([0-9]{6})|l([0-6])(?:-([0-9]{6}))?|ex([3-6])?(?:-([0-9]{6}))?)\.js$/;

/** What a metric file path names. `ex.js` and its pages are the exemplars of level EXEMPLAR_BASE_LEVEL. */
export type MetricFileName =
  | { id: number; kind: 'series' }
  | { id: number; kind: 'segment'; n: number }
  | { id: number; kind: 'level'; level: number; page: number | null }
  | { id: number; kind: 'exemplars'; level: number; page: number | null };

export function parseMetricFilePath(path: string): MetricFileName | null {
  const m = METRIC_FILE_PATH.exec(path);
  if (m === null) return null;
  const id = Number(m[1]);
  if (m[2] === 'series') return { id, kind: 'series' };
  if (m[3] !== undefined) return { id, kind: 'segment', n: Number(m[3]) };
  if (m[4] !== undefined)
    return { id, kind: 'level', level: Number(m[4]), page: m[5] === undefined ? null : Number(m[5]) };
  return {
    id,
    kind: 'exemplars',
    level: m[6] === undefined ? EXEMPLAR_BASE_LEVEL : Number(m[6]),
    page: m[7] === undefined ? null : Number(m[7]),
  };
}

/** A metric's listed files: per level and per exemplar level, `null` for one whole file or its page numbers. */
export interface MetricFiles {
  series: boolean;
  segments: number[];
  levels: Map<number, number[] | null>;
  exemplars: Map<number, number[] | null>;
}

/** Listed metric files grouped by metric id, segments and pages sorted; paths that are not metric files are skipped. */
export function groupMetricFiles(listed: readonly string[]): Map<number, MetricFiles> {
  const out = new Map<number, MetricFiles>();
  const byNumber = (a: number, b: number): number => a - b;
  const paged = (into: Map<number, number[] | null>, level: number, page: number | null): void => {
    if (page === null) into.set(level, null);
    else {
      const pages = into.get(level);
      if (pages === null) return; // a whole file wins over stray pages; `prune` removes those
      if (pages === undefined) into.set(level, [page]);
      else pages.push(page);
    }
  };
  for (const p of listed) {
    const name = parseMetricFilePath(p);
    if (name === null) continue;
    let e = out.get(name.id);
    if (e === undefined) {
      e = { series: false, segments: [], levels: new Map(), exemplars: new Map() };
      out.set(name.id, e);
    }
    switch (name.kind) {
      case 'series':
        e.series = true;
        break;
      case 'segment':
        e.segments.push(name.n);
        break;
      case 'level':
        paged(e.levels, name.level, name.page);
        break;
      case 'exemplars':
        paged(e.exemplars, name.level, name.page);
        break;
    }
  }
  for (const e of out.values()) {
    e.segments.sort(byNumber);
    for (const pages of e.levels.values()) pages?.sort(byNumber);
    for (const pages of e.exemplars.values()) pages?.sort(byNumber);
  }
  return out;
}

const MAX_NUMBER = 999_999;

function sixDigits(n: number, what: string): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_NUMBER) {
    throw new OtelHtmlError('invalid-report', {
      path: what,
      expected: `an integer in [0, ${MAX_NUMBER}]`,
      actual: String(n),
    });
  }
  return String(n).padStart(6, '0');
}

export function metricDir(id: number): string {
  return `data/metrics/${sixDigits(id, 'metric id')}`;
}
export function metricSeriesPath(id: number): string {
  return `${metricDir(id)}/series.js`;
}
export function metricSegmentPath(id: number, n: number): string {
  return `${metricDir(id)}/seg-${sixDigits(n, 'segment number')}.js`;
}
export function metricLevelPath(id: number, k: number): string {
  if (!Number.isInteger(k) || k < 0 || k > MAX_LEVEL) {
    throw new OtelHtmlError('invalid-report', {
      path: 'level',
      expected: `an integer in [0, ${MAX_LEVEL}]`,
      actual: String(k),
    });
  }
  return `${metricDir(id)}/l${k}.js`;
}
export function metricExemplarPath(id: number): string {
  return `${metricDir(id)}/ex.js`;
}
/** `ex<k>.js`, the exemplars of level k > EXEMPLAR_BASE_LEVEL. */
export function metricLevelExemplarPath(id: number, k: number): string {
  return `${metricDir(id)}/ex${exemplarLevel(k)}.js`;
}
/** Page `p` of level `k`: `l<k>-<p6>.js`. */
export function metricLevelPagePath(id: number, k: number, p: number): string {
  return `${metricLevelPath(id, k).slice(0, -'.js'.length)}-${sixDigits(p, 'page')}.js`;
}
/** Page `p` of `ex.js`: `ex-<p6>.js`. */
export function metricExemplarPagePath(id: number, p: number): string {
  return `${metricDir(id)}/ex-${sixDigits(p, 'page')}.js`;
}
/** Page `p` of `ex<k>.js`: `ex<k>-<p6>.js`. */
export function metricLevelExemplarPagePath(id: number, k: number, p: number): string {
  return `${metricDir(id)}/ex${exemplarLevel(k)}-${sixDigits(p, 'page')}.js`;
}
/** The exemplar file (whole or page `p`) of level `k`: `ex.js` up to EXEMPLAR_BASE_LEVEL, else `ex<k>.js`. */
export function metricExemplarFilePath(id: number, k: number, p: number | null): string {
  if (k <= EXEMPLAR_BASE_LEVEL) return p === null ? metricExemplarPath(id) : metricExemplarPagePath(id, p);
  return p === null ? metricLevelExemplarPath(id, k) : metricLevelExemplarPagePath(id, k, p);
}
/** The level file (whole or page `p`) of level `k`. */
export function metricLevelFilePath(id: number, k: number, p: number | null): string {
  return p === null ? metricLevelPath(id, k) : metricLevelPagePath(id, k, p);
}

function exemplarLevel(k: number): number {
  if (!Number.isInteger(k) || k <= EXEMPLAR_BASE_LEVEL || k > MAX_LEVEL) {
    throw new OtelHtmlError('invalid-report', {
      path: 'exemplar level',
      expected: `an integer in [${EXEMPLAR_BASE_LEVEL + 1}, ${MAX_LEVEL}]`,
      actual: String(k),
    });
  }
  return k;
}

/** Registration key of a data file: its path without `data/` and `.js`. */
export const dataFileKey = (path: string): string => path.slice('data/'.length, -'.js'.length);
export const metricSeriesKey = (id: number): string => dataFileKey(metricSeriesPath(id));
export const metricSegmentKey = (id: number, n: number): string => dataFileKey(metricSegmentPath(id, n));
export const metricLevelKey = (id: number, k: number): string => dataFileKey(metricLevelPath(id, k));
export const metricExemplarKey = (id: number): string => dataFileKey(metricExemplarPath(id));
export const metricLevelExemplarKey = (id: number, k: number): string =>
  dataFileKey(metricLevelExemplarPath(id, k));

// ---------------------------------------------------------------------------------------------
// Resolution ladder
// ---------------------------------------------------------------------------------------------

export function levelWidthNs(k: number): number {
  return LEVEL0_WIDTH_NS * LEVEL_FACTOR ** k;
}

/** Index of the bucket of width `widthNs` holding `time`. */
export function bucketIndex(time: number, widthNs: number): number {
  return Math.floor(time / widthNs);
}

/**
 * How many levels (0…K) cover `[minT, maxT]` (ns): K is the first level with at most LEVEL_MAX_BUCKETS
 * buckets over the range, capped at MAX_LEVEL.
 */
export function levelCount(minT: number, maxT: number): number {
  for (let k = 0; k < MAX_LEVEL; k++) {
    const w = levelWidthNs(k);
    if (bucketIndex(maxT, w) - bucketIndex(minT, w) + 1 <= LEVEL_MAX_BUCKETS) return k + 1;
  }
  return MAX_LEVEL + 1;
}

/** Buckets of one series at one width: `t` holds ascending bucket indexes, `a` the aggregate of each. */
export interface BucketSeries {
  id: number;
  t: number[];
  a: BucketAgg[];
}

/** First and last bucket index over all series, or null when there are no buckets. */
export function bucketRange(series: readonly BucketSeries[]): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const s of series) {
    const first = s.t[0];
    const last = s.t[s.t.length - 1];
    if (first !== undefined && first < min) min = first;
    if (last !== undefined && last > max) max = last;
  }
  return min > max ? null : { min, max };
}

/** Level-0 series coarsened to `factor`× wider buckets, merging in time order. */
function coarsen(series: readonly BucketSeries[], factor: number, path: string): BucketSeries[] {
  return series.map((s) => {
    const t: number[] = [];
    const a: BucketAgg[] = [];
    s.t.forEach((idx, i) => {
      const agg = s.a[i];
      if (agg === undefined) return;
      const c = Math.floor(idx / factor);
      const last = a.length - 1;
      const prev = a[last];
      if (t[last] === c && prev !== undefined) a[last] = mergeAgg(prev, agg, path);
      else {
        t.push(c);
        a.push(agg);
      }
    });
    return { id: s.id, t, a };
  });
}

/** Levels 0…count-1 from level 0, each LEVEL_FACTOR× coarser than the one before. */
export function deriveLevels(l0: readonly BucketSeries[], count: number): BucketSeries[][] {
  const levels: BucketSeries[][] = [[...l0]];
  for (let k = 1; k < count; k++) levels.push(nextLevel(levels[k - 1] ?? [], k));
  return levels;
}

/** Level `k` from level `k - 1` (`deriveLevels` one step at a time). */
export function nextLevel(previous: readonly BucketSeries[], k: number): BucketSeries[] {
  return coarsen(previous, LEVEL_FACTOR, `level ${k}`);
}

/**
 * Union of several pieces of the same level (segments, or a level file and segments), by series and bucket.
 * Aggregates of one bucket merge in piece order. Series come out sorted by id.
 */
export function mergeBucketSeries(parts: readonly (readonly BucketSeries[])[], path: string): BucketSeries[] {
  const byId = new Map<number, BucketSeries[]>();
  for (const part of parts) {
    for (const s of part) {
      const list = byId.get(s.id);
      if (list === undefined) byId.set(s.id, [s]);
      else list.push(s);
    }
  }
  return [...byId.keys()].sort((x, y) => x - y).map((id) => mergePieces(id, byId.get(id) ?? [], path));
}

function mergePieces(id: number, pieces: readonly BucketSeries[], path: string): BucketSeries {
  const ts: number[] = [];
  const as: BucketAgg[] = [];
  for (const p of pieces) {
    ts.push(...p.t);
    as.push(...p.a);
  }
  let order = ts.map((_, i) => i);
  if (ts.some((x, i) => i > 0 && x < (ts[i - 1] ?? x))) {
    order = order.sort((x, y) => (ts[x] ?? 0) - (ts[y] ?? 0)); // stable: equal buckets keep piece order
  }
  const t: number[] = [];
  const a: BucketAgg[] = [];
  for (const i of order) {
    const idx = ts[i];
    const agg = as[i];
    if (idx === undefined || agg === undefined) continue;
    const last = a.length - 1;
    const prev = a[last];
    if (t[last] === idx && prev !== undefined) a[last] = mergeAgg(prev, agg, `${path}.series ${id}`);
    else {
      t.push(idx);
      a.push(agg);
    }
  }
  return { id, t, a };
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

/**
 * `series` split by page of their bucket indexes: page → each series' buckets in it (a series with none is left
 * out, so is a page with none). One entry means the level fits one file.
 */
export function levelPages(series: readonly BucketSeries[]): Map<number, BucketSeries[]> {
  const pages = new Map<number, BucketSeries[]>();
  for (const s of series) {
    let from = 0;
    while (from < s.t.length) {
      const page = pageOf(s.t[from] ?? 0);
      let to = from + 1;
      while (to < s.t.length && pageOf(s.t[to] ?? 0) === page) to++;
      const part = { id: s.id, t: s.t.slice(from, to), a: s.a.slice(from, to) };
      const list = pages.get(page);
      if (list === undefined) pages.set(page, [part]);
      else list.push(part);
      from = to;
    }
  }
  return new Map([...pages].sort(([a], [b]) => a - b));
}

/** `list` split by page of the bucket of width `widthNs` holding each exemplar's time, in the list's order. */
export function exemplarPages(
  list: readonly StoredExemplar[],
  widthNs: number,
): Map<number, StoredExemplar[]> {
  const pages = new Map<number, StoredExemplar[]>();
  for (const e of list) {
    const page = pageOf(bucketIndex(e.time, widthNs));
    const part = pages.get(page);
    if (part === undefined) pages.set(page, [e]);
    else part.push(e);
  }
  return new Map([...pages].sort(([a], [b]) => a - b));
}

/**
 * Of a file's listed pages (`null` for one whole file, returned as is), those a window over buckets of `widthNs`
 * touches; all of them without a window.
 */
export function pagesIn(
  pages: readonly number[] | null,
  window: { start: number; end: number } | undefined,
  widthNs: number,
): number[] | null {
  if (pages === null) return null;
  if (window === undefined) return [...pages];
  const first = pageOf(bucketIndex(window.start, widthNs));
  const last = pageOf(bucketIndex(window.end, widthNs));
  return pages.filter((p) => p >= first && p <= last);
}

// ---------------------------------------------------------------------------------------------
// Exemplars
// ---------------------------------------------------------------------------------------------

export interface StoredExemplar {
  series: number;
  time: number;
  value: number;
  traceId: string | null;
  spanId: string | null;
  attributes: Attributes;
}

const byTime = (a: StoredExemplar, b: StoredExemplar): number =>
  a.time - b.time || a.series - b.series || a.value - b.value;

/** Up to `k` of `list`, alternating from the largest and the smallest value (two largest, two smallest for 4). */
function extremes(list: readonly StoredExemplar[], k: number): StoredExemplar[] {
  const sorted = [...list].sort((a, b) => a.value - b.value || a.time - b.time);
  if (sorted.length <= k) return sorted;
  const out: StoredExemplar[] = [];
  let lo = 0;
  let hi = sorted.length - 1;
  for (let top = true; out.length < k && lo <= hi; top = !top) {
    const e = top ? sorted[hi--] : sorted[lo++];
    if (e !== undefined) out.push(e);
  }
  return out;
}

/**
 * The exemplars one series keeps in one bucket: up to `n`, those with a trace id first, then the most extreme
 * values. In time order.
 */
export function selectExemplars(list: readonly StoredExemplar[], n: number): StoredExemplar[] {
  if (list.length <= n) return [...list].sort(byTime);
  const traced = list.filter((e) => e.traceId !== null);
  const picked = extremes(traced, n);
  if (picked.length < n) {
    picked.push(
      ...extremes(
        list.filter((e) => e.traceId === null),
        n - picked.length,
      ),
    );
  }
  return picked.sort(byTime);
}

/** `selectExemplars` applied per series per bucket of `widthNs` (EXEMPLAR_WIDTH_NS by default). */
export function capExemplars(
  list: readonly StoredExemplar[],
  n: number,
  widthNs: number = EXEMPLAR_WIDTH_NS,
): StoredExemplar[] {
  const groups = new Map<string, StoredExemplar[]>();
  for (const e of list) {
    const key = `${e.series}:${bucketIndex(e.time, widthNs)}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [e]);
    else g.push(e);
  }
  return [...groups.values()].flatMap((g) => selectExemplars(g, n)).sort(byTime);
}

// ---------------------------------------------------------------------------------------------
// Point gaps
// ---------------------------------------------------------------------------------------------

/** The gaps a series' point interval is measured on: its first ones, so the measure costs the same at any length. */
export const GAP_SAMPLE = 32;

/**
 * A series' first gaps between consecutive level-0 buckets holding a point: how many were measured (at most
 * GAP_SAMPLE) and their upper median, in level-0 buckets (0 when none). The viewer's bucket width (R12′) reads these
 * instead of loading level 0.
 */
export interface SeriesGaps {
  n: number;
  median: number;
}

/** `SeriesGaps` of one series' ascending level-0 bucket indexes. */
export function seriesGaps(t: readonly number[]): SeriesGaps {
  const gaps: number[] = [];
  for (let j = 1; j < t.length && j <= GAP_SAMPLE; j++) gaps.push((t[j] ?? 0) - (t[j - 1] ?? 0));
  gaps.sort((a, b) => a - b);
  // The upper median: an even sample rounds up, so a bucket is never narrower than the interval it should cover.
  return { n: gaps.length, median: gaps[Math.floor(gaps.length / 2)] ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------------

export interface SeriesFile {
  metric: number;
  series: SeriesDef[];
  /**
   * Per series (by id), its point gaps from level 0. Written at compaction (format 2); absent before it (segments
   * only) and in format-1 reports, where the viewer measures them on level 0 itself.
   */
  gaps?: SeriesGaps[];
  /**
   * A summary metric's quantiles, every one any of its series ever sent (ascending). Written at compaction, so the
   * show options need no level file; absent before it and in reports from before it was recorded, where the viewer
   * reads the coarsest level and says the list may be short.
   */
  quantiles?: number[];
}
export interface SegmentFile {
  metric: number;
  widthNs: number;
  series: BucketSeries[];
  exemplars: StoredExemplar[];
}
export interface LevelFile {
  metric: number;
  level: number;
  widthNs: number;
  /** The page this file is (format 3); absent in a whole level file. */
  page?: number | undefined;
  series: BucketSeries[];
}
export interface ExemplarFile {
  metric: number;
  /** The page this file is (format 3); absent in a whole exemplar file. */
  page?: number | undefined;
  exemplars: StoredExemplar[];
}

type SerializedSeriesDef = Omit<SeriesDef, 'attributes'> & { attributes: JsonAny[] };
type SerializedExemplar = Omit<StoredExemplar, 'attributes'> & { attributes: JsonAny[] };
/** `gaps` as `[n, median]` pairs, one per series. */
export type SerializedSeriesFile = {
  metric: number;
  series: SerializedSeriesDef[];
  gaps?: [number, number][] | undefined;
  quantiles?: number[] | undefined;
};
export type SerializedSegmentFile = Omit<SegmentFile, 'exemplars'> & { exemplars: SerializedExemplar[] };
export type SerializedExemplarFile = {
  metric: number;
  page?: number | undefined;
  exemplars: SerializedExemplar[];
};

const nonNegInt = z.number().int().nonnegative();
const finite = z.number().finite();

const BucketSeriesSchema: z.ZodType<BucketSeries> = z
  .strictObject({ id: nonNegInt, t: z.array(z.number().int()), a: z.array(BucketAggSchema) })
  .superRefine((s, ctx) => {
    if (s.t.length !== s.a.length) {
      ctx.addIssue({ code: 'custom', path: ['a'], message: `${s.t.length} aggregates (one per bucket)` });
    }
    for (let i = 1; i < s.t.length; i++) {
      if ((s.t[i] ?? 0) <= (s.t[i - 1] ?? 0)) {
        ctx.addIssue({ code: 'custom', path: ['t', i], message: 'strictly ascending bucket indexes' });
        return;
      }
    }
  });

function ascendingIds<T extends { id: number }>(schema: z.ZodType<T>): z.ZodType<T[]> {
  return z.array(schema).superRefine((list, ctx) => {
    for (let i = 1; i < list.length; i++) {
      if ((list[i]?.id ?? 0) <= (list[i - 1]?.id ?? 0)) {
        ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'series ids in ascending order' });
        return;
      }
    }
  });
}

const SeriesListSchema = ascendingIds(BucketSeriesSchema);

const ExemplarSchema: z.ZodType<SerializedExemplar> = z.strictObject({
  series: nonNegInt,
  time: z.number().int(),
  value: finite,
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/, '32 lowercase hex chars')
    .nullable(),
  spanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/, '16 lowercase hex chars')
    .nullable(),
  attributes: z.array(JsonAnySchema),
});

const SeriesDefSchema: z.ZodType<SerializedSeriesDef> = z.strictObject({
  id: nonNegInt,
  resource: z.number().int().min(-1),
  scope: z.number().int().min(-1),
  attributes: z.array(JsonAnySchema),
  bounds: z.array(finite).nullable(),
  other: z.boolean(),
});

export const SeriesFileSchema: z.ZodType<SerializedSeriesFile> = z
  .strictObject({
    metric: nonNegInt,
    series: z.array(SeriesDefSchema).superRefine((list, ctx) => {
      list.forEach((s, i) => {
        if (s.id !== i) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `${i}` });
      });
    }),
    gaps: z.array(z.tuple([z.number().int().min(0).max(GAP_SAMPLE), nonNegInt])).optional(),
    quantiles: z
      .array(z.number().min(0).max(1))
      .superRefine((qs, ctx) => {
        for (let i = 1; i < qs.length; i++) {
          if ((qs[i] ?? 0) <= (qs[i - 1] ?? 0)) {
            ctx.addIssue({ code: 'custom', path: [i], message: 'quantiles in ascending order' });
            return;
          }
        }
      })
      .optional(),
  })
  .superRefine((f, ctx) => {
    if (f.gaps !== undefined && f.gaps.length !== f.series.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['gaps'],
        message: `${f.series.length} entries (one per series)`,
      });
    }
  });

export const SegmentFileSchema: z.ZodType<SerializedSegmentFile> = z.strictObject({
  metric: nonNegInt,
  widthNs: z.literal(LEVEL0_WIDTH_NS),
  series: SeriesListSchema,
  exemplars: z.array(ExemplarSchema),
});

export const LevelFileSchema: z.ZodType<LevelFile> = z
  .strictObject({
    metric: nonNegInt,
    level: z.number().int().min(0).max(MAX_LEVEL),
    widthNs: z.number().int().positive(),
    page: nonNegInt.max(MAX_NUMBER).optional(),
    series: SeriesListSchema,
  })
  .superRefine((f, ctx) => {
    if (f.widthNs !== levelWidthNs(f.level)) {
      ctx.addIssue({
        code: 'custom',
        path: ['widthNs'],
        message: `${levelWidthNs(f.level)} for level ${f.level}`,
      });
    }
    if (f.page === undefined) return;
    // A page holds only its own buckets (the first and last, as they ascend).
    for (const [i, s] of f.series.entries()) {
      for (const j of [0, s.t.length - 1]) {
        const t = s.t[j];
        if (t !== undefined && pageOf(t) !== f.page) {
          ctx.addIssue({
            code: 'custom',
            path: ['series', i, 't', j],
            message: `a bucket of page ${f.page}`,
          });
          return;
        }
      }
    }
  });

export const ExemplarFileSchema: z.ZodType<SerializedExemplarFile> = z.strictObject({
  metric: nonNegInt,
  page: nonNegInt.max(MAX_NUMBER).optional(),
  exemplars: z.array(ExemplarSchema),
});

const encodeExemplar = (e: StoredExemplar): SerializedExemplar => ({
  ...e,
  attributes: encodeAttributes(e.attributes),
});

function decodeExemplars(list: readonly SerializedExemplar[], path: string): StoredExemplar[] {
  return list.map((e, i) => ({
    ...e,
    attributes: decodeAttributes(e.attributes, `${path}[${i}].attributes`),
  }));
}

export function encodeSeriesFile(f: SeriesFile): SerializedSeriesFile {
  return {
    metric: f.metric,
    series: f.series.map((s) => ({
      id: s.id,
      resource: s.resource,
      scope: s.scope,
      attributes: encodeAttributes(s.attributes),
      bounds: s.bounds === null ? null : [...s.bounds],
      other: s.other,
    })),
    ...(f.gaps === undefined ? {} : { gaps: f.gaps.map((g): [number, number] => [g.n, g.median]) }),
    ...(f.quantiles === undefined ? {} : { quantiles: [...f.quantiles] }),
  };
}

export function parseSeriesFile(input: unknown, root: string): SeriesFile {
  const f = parseWith(SeriesFileSchema, input, root);
  return {
    metric: f.metric,
    series: f.series.map((s, i) => ({
      ...s,
      attributes: decodeAttributes(s.attributes, `${root}.series[${i}].attributes`),
    })),
    ...(f.gaps === undefined ? {} : { gaps: f.gaps.map(([n, median]) => ({ n, median })) }),
    ...(f.quantiles === undefined ? {} : { quantiles: f.quantiles }),
  };
}

/** The quantiles of every summary bucket in `series`, ascending: what `SeriesFile.quantiles` records. */
export function summaryQuantilesOf(series: readonly BucketSeries[]): number[] {
  const qs = new Set<number>();
  for (const s of series)
    for (const a of s.a) if (a.k === 'summary') for (const q of a.quantiles) qs.add(q.q);
  return [...qs].sort((a, b) => a - b);
}

export function encodeSegmentFile(f: SegmentFile): SerializedSegmentFile {
  return { ...f, exemplars: f.exemplars.map(encodeExemplar) };
}

export function parseSegmentFile(input: unknown, root: string): SegmentFile {
  const f = parseWith(SegmentFileSchema, input, root);
  return { ...f, exemplars: decodeExemplars(f.exemplars, `${root}.exemplars`) };
}

/**
 * A segment file the running writer wrote itself, read back for compaction: decoded like `parseSegmentFile` without
 * validating it again (it was encoded from validated buckets moments before). Segments of an earlier session, read on
 * append or merge, go through `parseSegmentFile`. Demoted segments count as this session's own too: they are built
 * from level and exemplar files that were zod-validated when read, so skipping validation stays sound.
 */
export function decodeOwnSegmentFile(input: unknown, root: string): SegmentFile {
  const f = input as SerializedSegmentFile;
  return { ...f, exemplars: decodeExemplars(f.exemplars, `${root}.exemplars`) };
}

export function parseLevelFile(input: unknown, root: string): LevelFile {
  return parseWith(LevelFileSchema, input, root);
}

export function encodeExemplarFile(f: ExemplarFile): SerializedExemplarFile {
  return {
    metric: f.metric,
    ...(f.page === undefined ? {} : { page: f.page }),
    exemplars: f.exemplars.map(encodeExemplar),
  };
}

export function parseExemplarFile(input: unknown, root: string): ExemplarFile {
  const f = parseWith(ExemplarFileSchema, input, root);
  return {
    metric: f.metric,
    ...(f.page === undefined ? {} : { page: f.page }),
    exemplars: decodeExemplars(f.exemplars, `${root}.exemplars`),
  };
}
