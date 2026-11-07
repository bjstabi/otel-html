import type { ManifestV4 } from '../../format/manifest.js';
import type { TraceId } from '../../model/ids.js';
import type { ResourceRecord, ResourceRef, ScopeRecord, ScopeRef } from '../../model/records.js';
import type { MetricCatalog, MetricEntry } from '../../rollups/metric-catalog.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import type { FacetValueKind } from '../components/filter-tokens.js';
import type { LogRef, LogRow } from './log-query.js';
import type { LoadedMetric } from './metric-load.js';
import type {
  LogQuery,
  LogQueryResult,
  PatternQuery,
  PatternsResult,
  ServicesResult,
  SpanQuery,
  SpanQueryResult,
  SpanRow,
  SurroundingLogs,
} from './results.js';
import type { TimeWindow } from './time-window.js';
import type { TraceTree } from './trace-tree.js';

/** A trace with report-wide resource and scope refs. */
export interface TraceDetail {
  traceId: TraceId;
  spans: readonly SpanRow[];
  tree: TraceTree;
  resources: (r: ResourceRef) => ResourceRecord;
  scopes: (s: ScopeRef) => ScopeRecord;
  /** Log records carrying this trace id. */
  logCount: number;
}

export interface ResourceValues {
  values: string[];
  kind: FacetValueKind;
  capped: boolean;
}

/**
 * The format-4 data source: the span half, the log half (`queryLogs`, `getLog`, `traceLogs`, `surroundingLogs`,
 * `patterns`, `metricPoints`, `resourceValues`) and the stubs the viewer needs until plan 3 (D11).
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
  serviceShare(traceId: TraceId, signal?: AbortSignal): Promise<readonly { service: string; ns: number }[]>;
  /** The busiest `limit` services; `total` is `limit + 1` when more exist. */
  services(
    opts: { window: TimeWindow | null; condition: string | null; limit: number },
    signal?: AbortSignal,
  ): Promise<ServicesResult>;
  queryLogs(q: LogQuery, signal?: AbortSignal): Promise<LogQueryResult>;
  /** Rejects with a `usage` error when the report has no such log. */
  getLog(ref: LogRef): Promise<LogRow>;
  /** The trace's logs, time-ascending (ref tiebreak); [] when there are none. Works for traces without spans. */
  traceLogs(traceId: TraceId, signal?: AbortSignal): Promise<readonly LogRow[]>;
  /** Up to `n` logs on each side of `ref` from the same service and host, in time order with the ref tiebreak. */
  surroundingLogs(ref: LogRef, n: number): Promise<SurroundingLogs>;
  /** Log patterns combined by template across partitions. */
  patterns(q: PatternQuery, signal?: AbortSignal): Promise<PatternsResult>;
  /** Data points over time across every resource (the unfiltered table). */
  metricPoints(signal?: AbortSignal): Promise<TimeBuckets<'points'>>;
  /** The values of one resource attribute over spans, logs and points, sorted; `capped` when more than the cap exist. */
  resourceValues(key: string, signal?: AbortSignal): Promise<ResourceValues>;
  /** Rejects with a `usage` error naming plan 3 until metrics are queryable (D11). */
  metricCatalog(): Promise<MetricCatalog>;
  metric(id: number): Promise<LoadedMetric>;
  metricsForResources(resources: readonly ResourceRecord[]): Promise<readonly MetricEntry[]>;
  close(): Promise<void>;
}
