import type { Attributes } from '../model/anyvalue.js';
import type { BucketAgg } from '../rollups/metric-agg.js';

/** Types and constants the viewer's metric modules still share; the per-metric file layout of formats 1 to 3 is gone. */

/** Level 0 is 1 ms × 2^10, aligned like `TimeBuckets`; level k is LEVEL_FACTOR^k times wider. */
export const LEVEL0_WIDTH_NS = 1_024_000_000;

/**
 * A metric data file's path (`parseMetricFilePath` reads it): the groups are the metric id, the file name, a
 * segment number, a level and its page, an exemplar level and its page.
 */
export const METRIC_FILE_PATH: RegExp =
  /^data\/metrics\/([0-9]{6})\/(series|seg-([0-9]{6})|l([0-6])(?:-([0-9]{6}))?|ex([3-6])?(?:-([0-9]{6}))?)\.js$/;

/** Buckets of one series at one width: `t` holds ascending bucket indexes, `a` the aggregate of each. */
export interface BucketSeries {
  id: number;
  t: number[];
  a: BucketAgg[];
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

/** The quantiles of every summary bucket in `series`, ascending: what `SeriesFile.quantiles` records. */
export function summaryQuantilesOf(series: readonly BucketSeries[]): number[] {
  const qs = new Set<number>();
  for (const s of series)
    for (const a of s.a) if (a.k === 'summary') for (const q of a.quantiles) qs.add(q.q);
  return [...qs].sort((a, b) => a - b);
}
