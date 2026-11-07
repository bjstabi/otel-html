import type { TraceId } from '../../model/ids.js';
import type { ResourceRecord, ScopeRecord, SpanRecord } from '../../model/records.js';
import type { FacetCounts } from '../../rollups/facets.js';
import type { SpanStatusKey } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
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

export interface Durations {
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
  dropped: number;
}

/** Which parts of a `SpanQueryResult` to compute; absent parts come back empty. */
export type SpanNeed = 'rows' | 'facets' | 'timeline' | 'durations' | 'groups';

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
