import type { ResourceRecord, ScopeRecord } from '../../model/records.js';
import type { MetricQuery } from '../../query/metric-query.js';
import type { MetricCatalogData, MetricEntry } from './metric-catalog.js';
import type { TimeWindow } from './time-window.js';

/** Request and result shapes of the metric data layer (copied from `metric-query.ts`; the originals go in PR 5). */

export interface SeriesPoints {
  key: string;
  label: string;
  group: Record<string, string>;
  unit: string;
  /** [bucket start (RelNanos), value]; null is a gap. */
  points: [number, number | null][];
  resourceService: string | null;
}

export interface MetricQueryResult {
  queryId: string;
  /** The series' bucket width: the rollup interval when a rollup ƒ applies. `heat.widthNs` is the cells'. */
  widthNs: number;
  series: SeriesPoints[];
  exemplars: {
    time: number;
    value: number;
    traceId: string | null;
    spanId: string | null;
    seriesKey: string;
  }[];
  heat: { bounds: number[]; cells: [number, number, number][]; widthNs: number } | null;
  distribution: { bounds: number[]; counts: number[] } | null;
  notes: string[];
}

export interface RunInfo {
  id: string;
  /** RelNanos: the start of the bucket holding the run's last point. */
  time: number;
  revision: string | null;
}

interface RunPoint {
  value: number;
  failed: boolean;
}

export interface RunLine {
  key: string;
  label: string;
  unit: string;
  /** Aligned with `runs`; null where the line has no point in that run. */
  points: (RunPoint | null)[];
}

export interface RunQueryResult {
  queryId: string;
  runs: RunInfo[];
  lines: RunLine[];
  /** Series with data that no run could be read for: no run id. */
  leftOut: number;
  /** The window the query covered, echoed so a chart can tell when it changed. */
  window: TimeWindow;
  notes: string[];
}

/** One decoded row of `seriesQuery`. */
export interface SeriesRow {
  seriesId: number;
  attributes: Record<string, unknown>;
  resource: ResourceRecord;
  scope: ScopeRecord;
  bounds: number[] | null;
  groups: (string | null)[];
}

export interface MetricQueryRequest {
  entry: MetricEntry;
  query: MetricQuery;
  window: TimeWindow;
  maxPoints: number;
  widthNs?: number;
  resources?: readonly number[];
  exemplars: boolean;
}

export interface MetricRunQueryRequest {
  entry: MetricEntry;
  query: MetricQuery;
  window: TimeWindow;
  runBy: string;
  failedWhen: string | null;
  resources?: readonly number[];
}

export interface MetricMethods {
  metricCatalog(): Promise<MetricCatalogData>;
  metricShowOptions(entryId: number): Promise<readonly string[]>;
  metricQuery(req: MetricQueryRequest, signal?: AbortSignal): Promise<MetricQueryResult>;
  metricRunQuery(req: MetricRunQueryRequest, signal?: AbortSignal): Promise<RunQueryResult>;
  metricsForResources(resources: readonly ResourceRecord[]): Promise<readonly MetricEntry[]>;
}

export function resolveMetric(
  catalog: MetricCatalogData,
  q: Pick<MetricQuery, 'metric' | 'kind' | 'unit'>,
): { entry: MetricEntry } | { ambiguous: MetricEntry[] } | { missing: true } {
  const found = catalog.entries.filter(
    (e) =>
      e.name === q.metric && (q.kind === null || e.type === q.kind) && (q.unit === null || e.unit === q.unit),
  );
  const [only] = found;
  if (only === undefined) return { missing: true };
  return found.length === 1 ? { entry: only } : { ambiguous: found };
}

const BASE_WIDTH_NS = 1e6;
/** Fewer gaps than this leave the bucket width to the pick alone (one outage would read as a slow scrape). */
const INTERVAL_MIN_GAPS = 8;

/** Buckets of `widthNs` a window touches; both ends are inclusive. */
const bucketsOver = (w: TimeWindow, widthNs: number): number =>
  Math.floor(w.end / widthNs) - Math.floor(w.start / widthNs) + 1;

/** D24: the smallest 1 ms x 2^k whose buckets over the window number at most `maxPoints`. */
export function pickWidthNs(window: TimeWindow, maxPoints: number): number {
  let width = BASE_WIDTH_NS;
  while (bucketsOver(window, width) > maxPoints) width *= 2;
  return width;
}

/** D24: the pick, or the interval rounded up to a whole multiple of the pick when the points are sparser. */
export function chartWidthNs(pick: number, intervalNs: number): number {
  return intervalNs <= pick ? pick : Math.ceil(intervalNs / pick) * pick;
}

/** The upper median of the gaps (an even count rounds up); 0 under `INTERVAL_MIN_GAPS` gaps. */
export function upperMedian(gaps: readonly number[]): number {
  if (gaps.length < INTERVAL_MIN_GAPS) return 0;
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
