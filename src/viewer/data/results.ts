import type { TraceId } from '../../model/ids.js';
import type { ResourceRecord, ScopeRecord, SpanRecord } from '../../model/records.js';
import type { FacetCounts } from '../../rollups/facets.js';
import type { SpanStatusKey } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import { DEFAULT_LOG_FACETS, DEFAULT_SPAN_FACETS } from '../../semconv/default-facets.js';
import type { LogSeverityKey } from '../../semconv/severity.js';
import type { LogMode, LogRow, LogTraceRow, PatternRow } from './log-query.js';
import type { TimeWindow } from './time-window.js';

/** The core facet keys: what the Traces page asks for under a long window, where attribute facets wait for the reader. */
export const CORE_SPAN_FACET_KEYS: readonly string[] = DEFAULT_SPAN_FACETS.map((f) => f.key);
export const CORE_LOG_FACET_KEYS: readonly string[] = DEFAULT_LOG_FACETS.map((f) => f.key);

/**
 * Request-rate, error and latency-percentile series on a shared bucket grid (the RED view). Under a long window the
 * percentiles come from the duration buckets of the rollups (spec 6.3): within 4.43 % of the exact ones, and inside the
 * bucket's minimum and maximum.
 */
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

/** Exact under a short window; under a long one `p50`, `p95` and `p99` are read from the duration buckets (within 4.43 %). */
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
 * latency. Asked together, `timeline` covers both. `total` fills `total` with one count and reads no row; asked with
 * `rows`, the rows statement sets it.
 */
export type SpanNeed = 'rows' | 'facets' | 'timeline' | 'buckets' | 'total' | 'durations' | 'groups';

/**
 * Which parts of a `LogQueryResult` to compute; absent parts come back empty. `total` fills `total` and `matched` with
 * one count and reads no row; in logs mode, asked with `rows`, the rows statement sets them. In traces mode `rows` sets
 * `total` (the traces) only: `matched` (the logs that carry a trace id) is `total`'s.
 */
export type LogNeed = 'rows' | 'facets' | 'timeline' | 'total';

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
   * Matches before the row limit. With a residual condition in spans mode and `rows` as the only need it is exact when
   * every candidate was read; when the page budget (8 pages of `limit`) ended first it is the candidate count, an upper
   * bound. With an aggregate need (`total` among them) the condition goes through its id table and the count is exact.
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
