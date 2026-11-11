import type { TraceId } from '../../model/ids.js';
import type { ResourceRecord, ScopeRecord, SpanRecord } from '../../model/records.js';
import type { FacetCounts } from '../../rollups/facets.js';
import type { SpanStatusKey } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import type { LogSeverityKey } from '../../semconv/severity.js';
import type { LogMode, LogRow, LogTraceRow, PatternRow } from './log-query.js';
import type { TimeWindow } from './time-window.js';

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

/**
 * Which parts of a `SpanQueryResult` to compute; absent parts come back empty. `timeline` fills the status buckets and
 * the RED series (which reads `duration_ns`); `buckets` fills the status buckets only, for a caller that never draws
 * latency. Asked together, `timeline` covers both.
 */
export type SpanNeed = 'rows' | 'facets' | 'timeline' | 'buckets' | 'total' | 'durations' | 'groups';

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
  /** The residual OTTL text (D5) evaluated in the browser; null when the whole condition ran in SQL. */
  residual: string | null;
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
  /**
   * Contiguous `[fromNs, toNs)` bins the `durations` need counts into (exact per bin); absent, the bins span the
   * matching spans' own min to max.
   */
  durationAxis?: readonly { fromNs: number; toNs: number }[];
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
  /** The residual OTTL text (D5) evaluated in the browser; null when the whole condition ran in SQL. */
  residual: string | null;
  tables: RowTables;
}

/** Up to `n` same-stream logs on each side of `log`, in time order with the ref tiebreak. */
export interface SurroundingLogs {
  before: readonly LogRow[];
  log: LogRow;
  after: readonly LogRow[];
}

export interface PatternQuery {
  /** Keeps the templates whose combined first-to-last range overlaps the window. */
  window: TimeWindow | null;
  sort: { column: 'count' | 'first' | 'last'; dir: 'asc' | 'desc' };
  limit: number;
}

export interface PatternsResult {
  /** `id` is the row's position in the whole sorted list; a template without a time has `first` and `last` null. */
  rows: readonly PatternRow[];
  /** The templates before the limit. */
  total: number;
}
