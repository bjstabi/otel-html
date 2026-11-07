import type { ManifestV4 } from '../../format/manifest.js';
import type { TraceId } from '../../model/ids.js';
import type { ResourceRecord, ScopeRecord, SpanRecord } from '../../model/records.js';
import type { FacetCounts } from '../../rollups/facets.js';
import type { MetricCatalog, MetricEntry } from '../../rollups/metric-catalog.js';
import type { SpanStatusKey } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import type { LogSeverityKey } from '../../semconv/severity.js';
import type { TraceDetail } from './data-source.js';
import type { LogMode, LogRow, LogTraceRow } from './log-query.js';
import type { LoadedMetric } from './metric-load.js';
import type { TimeWindow } from './span-query.js';

/** Request-rate, error and latency-percentile series on a shared bucket grid (the RED view). */
export interface RedBuckets {
  startNs: number;
  widthNs: number;
  counts: readonly number[];
  errors: readonly number[];
  p50: readonly (number | null)[];
  p95: readonly (number | null)[];
  p99: readonly (number | null)[];
  max: readonly (number | null)[];
}

export interface DurationSummary {
  count: number;
  min: number;
  max: number;
  sum: number;
  p50: number;
  p95: number;
  p99: number;
}

/** One duration bin: `[fromNs, toNs)` with the span count inside it. */
export interface DurationBin {
  fromNs: number;
  toNs: number;
  count: number;
}

interface Durations {
  summary: DurationSummary | null;
  bins: readonly DurationBin[];
}

export interface GroupStats {
  group: string;
  count: number;
  sum: number;
  avg: number;
  max: number;
  p95: number;
  p99: number;
}

export interface GroupStatsResult {
  groups: readonly GroupStats[];
  cap: number;
  /** 0 or 1: 1 means more groups than `cap` exist (the query cannot count them). */
  dropped: number;
}

/** Which parts of a `SpanQueryResult` to compute; absent parts come back empty. */
export type SpanNeed = 'rows' | 'facets' | 'timeline' | 'durations' | 'groups';

/** Which parts of a `LogQueryResult` to compute; absent parts come back empty. */
export type LogNeed = 'rows' | 'facets' | 'timeline';

export interface LogQuery {
  condition: string | null;
  text: string;
  window: TimeWindow | null;
  mode: LogMode;
  sort: { column: string; dir: 'asc' | 'desc' };
  limit: number;
  /** Only this trace's logs (on top of `condition`). */
  traceId?: TraceId | null;
  /** What to compute; absent parts are empty. */
  needs: readonly LogNeed[];
  /** Restrict facets to these keys; null means every core facet plus attributes. */
  facetKeys: readonly string[] | null;
}

export type LogQueryResult = {
  /** Matched logs; traces in traces mode. */
  total: number;
  /** Logs that matched the filter; in traces mode only those carrying a trace id. */
  matched: number;
  facets: FacetCounts;
  buckets: TimeBuckets<LogSeverityKey>;
  /** True when the residual OTTL terms (D5) were applied to the result. */
  residual: boolean;
} & ({ mode: 'logs'; rows: readonly LogRow[] } | { mode: 'traces'; rows: readonly LogTraceRow[] });

export interface ServiceStats {
  service: string;
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  buckets: TimeBuckets<'count'>;
}

export interface ServicesResult {
  services: readonly ServiceStats[];
  /** The services found; `limit + 1` when more than `limit` exist (the query does not count past that). */
  total: number;
}

export interface SpanQuery {
  condition: string | null;
  text: string;
  window: TimeWindow | null;
  mode: 'spans' | 'traces';
  sort: { column: string; dir: 'asc' | 'desc' };
  limit: number;
  /** Carried for the UI; grouping is a presentation concern and is not applied by the data layer. */
  groupBy: string | null;
  /** The facet key to aggregate span durations by (`SpanQueryResult.groups`); null for none. */
  measureBy: string | null;
  /** What to compute; absent parts are empty. */
  needs: readonly SpanNeed[];
  /** Restrict facets to these keys; null means every core facet plus attributes. */
  facetKeys: readonly string[] | null;
}

/** `span`'s resource and scope refs index the `RowTables` returned beside the rows. */
export interface SpanRow {
  span: SpanRecord;
  service: string;
  resource: string;
  /** `end - start` in RelNanos units (nanoseconds, a safe-integer number like the span times), never negative. */
  durationNs: number;
}

export interface TraceRow {
  traceId: TraceId;
  /** The root's service, span name and resource; null when the trace has no root span. */
  rootSummary: { service: string; name: string; resource: string } | null;
  start: number;
  durationNs: number;
  spans: number;
  errors: number;
}

export interface RowTables {
  resources: readonly ResourceRecord[];
  scopes: readonly ScopeRecord[];
}

export interface SpanQueryResult {
  rows: readonly (SpanRow | TraceRow)[];
  /**
   * Matches before the row limit. With a residual condition in spans mode it is exact when every candidate was read;
   * when the page budget (8 pages of `limit`) ended first it is the candidate count, an upper bound.
   */
  total: number;
  facets: FacetCounts;
  buckets: TimeBuckets<SpanStatusKey>;
  red: RedBuckets | null;
  durations: Durations;
  groups: GroupStatsResult | null;
  /** True when the residual OTTL terms (D5) were applied to the result. */
  residual: boolean;
  tables: RowTables;
}

/**
 * The format-4 data source. This is the span half plus the stubs the viewer needs until plan 3 (D11); the log half
 * (`queryLogs`, `getLog`, `traceLogs`, `surroundingLogs`, `patterns`, `metricPoints`, `resourceValues`) is added in PR 4.
 */
export interface DataSource {
  readonly manifest: ManifestV4;
  readonly epoch: bigint;
  querySpans(q: SpanQuery, signal?: AbortSignal): Promise<SpanQueryResult>;
  /** Memoised for the last id. Rejects with a `usage` error for a trace the report does not hold. */
  getTrace(traceId: TraceId): Promise<TraceDetail>;
  /** Bound: consumers pass it unbound. */
  hasTrace(traceId: TraceId): Promise<boolean>;
  /** 0 to 100 within the unfiltered spans of that service and resource; null when there are none. */
  percentileOf(service: string, resource: string, durationNs: number): Promise<number | null>;
  /** Exclusive time per service of one trace, largest first (D7). */
  serviceShare(traceId: TraceId): Promise<readonly { service: string; ns: number }[]>;
  /** The busiest `limit` services; `total` is `limit + 1` when more exist. */
  services(
    opts: { window: TimeWindow | null; condition: string | null; limit: number },
    signal?: AbortSignal,
  ): Promise<ServicesResult>;
  /** Rejects with a `usage` error naming plan 3 until metrics are queryable (D11). */
  metricCatalog(): Promise<MetricCatalog>;
  metric(id: number): Promise<LoadedMetric>;
  metricsForResources(resources: readonly ResourceRecord[]): Promise<readonly MetricEntry[]>;
  close(): Promise<void>;
}
