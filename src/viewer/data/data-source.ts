import type { Manifest } from '../../format/manifest.js';
import { chunkKey } from '../../format/paths.js';
import { anyValueToDisplay } from '../../model/anyvalue.js';
import type { TraceId } from '../../model/ids.js';
import type { ResourceRecord, ResourceRef, ScopeRecord, ScopeRef } from '../../model/records.js';
import type { ExpHistogram } from '../../rollups/exp-histogram.js';
import type { FacetCounts } from '../../rollups/facets.js';
import { LOG_RESOURCE_FACET_KEYS, type LogRollups } from '../../rollups/log-rollups.js';
import type { MetricCatalog, MetricEntry } from '../../rollups/metric-catalog.js';
import type { RedSeries } from '../../rollups/red.js';
import { SPAN_RESOURCE_FACET_KEYS, type SpanRollups } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import type { LogSeverityKey } from '../../semconv/severity.js';
import type { FacetValueKind } from '../components/filter-tokens.js';
import { Lru } from './chunk-window.js';
import { createEagerSource } from './eager.js';
import { createTraceIndex, loadSpanRollups } from './load.js';
import { createEagerLogSource } from './log-eager.js';
import { loadLogRollups } from './log-load.js';
import {
  checkSurroundingCount,
  type LogQuery,
  type LogQueryResult,
  type LogRef,
  type LogRow,
  type PatternRow,
  patternRowsOf,
} from './log-query.js';
import { createWindowedLogSource } from './log-windowed.js';
import {
  type LoadedMetric,
  loadMetric,
  loadMetricCatalog,
  loadMetricPoints,
  metricsOnResources,
} from './metric-load.js';
import type { ScriptLoader } from './script-loader.js';
import type { SpanQuery, SpanQueryResult, SpanRow } from './span-query.js';
import type { TraceTree } from './trace-tree.js';
import { createWindowedSource } from './windowed.js';

export type { SpanQuery, SpanQueryResult, SpanRow, TimeWindow, TraceRow } from './span-query.js';
export type { TraceNode, TraceTree } from './trace-tree.js';
export { buildTraceTree } from './trace-tree.js';

export interface Landing {
  facets: FacetCounts;
  buckets: TimeBuckets<'ok' | 'error' | 'unset'>;
  red: RedSeries;
  durations: Map<string, ExpHistogram>;
}

/** Spans have report-wide resource/scope refs here (chunk-local refs are rebased). */
export interface TraceDetail {
  traceId: TraceId;
  spans: readonly SpanRow[];
  tree: TraceTree;
  resources: (r: ResourceRef) => ResourceRecord;
  scopes: (s: ScopeRef) => ScopeRecord;
  /** Log records carrying this trace id. */
  logCount: number;
}

/** A trace as the span strategy assembles it; `createDataSource` adds the log count. */
export type SpanTrace = Omit<TraceDetail, 'logCount'>;

export interface LogLanding {
  facets: FacetCounts;
  buckets: TimeBuckets<LogSeverityKey>;
  /** The writer's clusters over every log. */
  patterns: readonly PatternRow[];
}

export interface SurroundingLogs {
  before: readonly LogRow[];
  log: LogRow;
  after: readonly LogRow[];
  /** True when the windowed scan stopped at its chunk budget with unread chunks that could hold nearer logs. */
  partial: boolean;
}

export type Strategy = 'eager' | 'windowed';

export interface DataSource {
  readonly manifest: Manifest;
  /** The span strategy. */
  readonly strategy: Strategy;
  readonly logStrategy: Strategy;
  landing(): Promise<Landing>;
  logLanding(): Promise<LogLanding>;
  querySpans(
    q: SpanQuery,
    onProgress?: (scanned: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<SpanQueryResult>;
  getTrace(traceId: TraceId): Promise<TraceDetail>;
  /** Whether the report holds the trace. An index lookup only: no span chunk is loaded. Rejects on load failures. */
  hasTrace(traceId: TraceId): Promise<boolean>;
  /** Percentile (0-100) of `durationNs` within the unfiltered rollup of that service and resource, or null if unknown. */
  percentileOf(service: string, resource: string, durationNs: number): number | null;
  queryLogs(
    q: LogQuery,
    onProgress?: (scanned: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<LogQueryResult>;
  /** Rejects with a `usage` error when the report has no such log. */
  getLog(ref: LogRef): Promise<LogRow>;
  /** The trace's logs, time-ascending (ref tiebreak); [] when there are none. Works for traces without spans. */
  traceLogs(traceId: TraceId, signal?: AbortSignal): Promise<readonly LogRow[]>;
  /** Up to `n` logs on each side of `ref` from the same service and host, in time order with the ref tiebreak. */
  surroundingLogs(ref: LogRef, n: number): Promise<SurroundingLogs>;
  /** The metric catalog, loaded on first use. */
  metricCatalog(): Promise<MetricCatalog>;
  /** Data points over time across every resource (the unfiltered rollup), loaded on first use. */
  metricPoints(): Promise<TimeBuckets<'points'>>;
  /** One metric's series and levels, loaded on demand (the 32 most recent are kept). */
  metric(id: number): Promise<LoadedMetric>;
  /** Metrics with a series on one of `resources`, matched by canonical resource equality. */
  metricsForResources(resources: readonly ResourceRecord[]): Promise<readonly MetricEntry[]>;
  /**
   * The values of one resource attribute across the report: the union of the span and log facets that hold resource
   * attributes (service, host, environment) and the metric catalog's resources, sorted. `kind` is `mixed` when the sources disagree; `capped` when a facet kept
   * only its first values (the rest are counted in "other").
   */
  resourceValues(key: string): Promise<ResourceValues>;
}

export interface ResourceValues {
  values: string[];
  kind: FacetValueKind;
  capped: boolean;
}

/** What each span strategy provides; `createDataSource` adds the landing, percentile and log-count parts. */
export interface SpanStrategy extends Pick<DataSource, 'querySpans' | 'hasTrace'> {
  getTrace(traceId: TraceId): Promise<SpanTrace>;
}

/** What each log strategy provides; `createDataSource` adds the landing. */
export type LogStrategy = Pick<DataSource, 'queryLogs' | 'getLog' | 'traceLogs' | 'surroundingLogs'>;

/** Metrics kept decoded in memory. */
/** `ds.metricCatalog()` as a stable function, for `useKeyedAsync(dataSource, catalogOf)`. */
export const catalogOf = (ds: DataSource): Promise<MetricCatalog> => ds.metricCatalog();

export const METRIC_LRU_SIZE = 32;

const DURATION_KEY_SEP = '\u0000';

function percentile(h: ExpHistogram, durationNs: number): number {
  if (h.count === 0 || durationNs < h.min) return 0;
  if (durationNs >= h.max) return 100;
  // Largest q whose quantile does not exceed the duration, by bisection (quantile is monotonic).
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (h.quantile(mid) <= durationNs) lo = mid;
    else hi = mid;
  }
  return Math.round(lo * 1000) / 10;
}

/** The attribute kinds a facet records; anything else (an array, a map) has no filterable value. */
function scalarKindOf(kind: string): FacetValueKind | null {
  return kind === 'string' || kind === 'int' || kind === 'double' || kind === 'bool' ? kind : null;
}

function mergeKinds(kinds: readonly FacetValueKind[]): FacetValueKind {
  const [first, ...rest] = kinds;
  if (first === undefined) return 'string'; // nothing recorded the key: a typed filter has nothing to match anyway
  return rest.every((k) => k === first) ? first : 'mixed';
}

/**
 * `facets` pairs each signal's rollup facets with the keys whose values there are resource attributes: any other key
 * of the same name is a span or log attribute, not a resource one, so only the metric catalog's resources answer it.
 */
function resourceValuesOf(
  key: string,
  facets: readonly { facets: FacetCounts; resourceKeys: ReadonlySet<string> }[],
  catalog: MetricCatalog,
): ResourceValues {
  const values = new Set<string>();
  const kinds: FacetValueKind[] = [];
  let capped = false;
  for (const { facets: f, resourceKeys } of facets) {
    if (!resourceKeys.has(key)) continue;
    const kind = f.kind(key);
    if (kind === undefined) continue;
    kinds.push(kind);
    for (const { value } of f.top(key, f.valueCap)) values.add(value);
    if (f.other(key) > 0) capped = true;
  }
  for (const r of catalog.resources()) {
    const v = r.attributes.get(key);
    const kind = v === undefined ? null : scalarKindOf(v.kind);
    if (v === undefined || kind === null) continue;
    kinds.push(kind);
    values.add(anyValueToDisplay(v));
  }
  return {
    values: [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    kind: mergeKinds(kinds),
    capped,
  };
}

function landingOf(rollups: SpanRollups): Landing {
  return { facets: rollups.facets, buckets: rollups.buckets, red: rollups.red, durations: rollups.durations };
}

/**
 * Each signal's strategy. Its decoded size is estimated as `decodedBytes × (its chunk bytes ÷ all chunk bytes)`
 * and compared with the budget on its own; a signal with no chunks is eager.
 */
export function signalBudgets(manifest: Manifest, budgetBytes: number): Record<'spans' | 'logs', Strategy> {
  const allBytes = manifest.chunks.reduce((n, c) => n + c.bytes, 0);
  const pick = (signal: 'spans' | 'logs'): Strategy => {
    const bytes = manifest.chunks.reduce((n, c) => (c.signal === signal ? n + c.bytes : n), 0);
    if (bytes === 0) return 'eager';
    return (manifest.decodedBytes * bytes) / allBytes <= budgetBytes ? 'eager' : 'windowed';
  };
  return { spans: pick('spans'), logs: pick('logs') };
}

/**
 * A strategy built on its first call, so a page that never touches logs (the Traces explorer) does not wait for
 * them. Concurrent calls share the build; a failed build is retried on the next call.
 */
function lazyLogStrategy(build: () => Promise<LogStrategy>): LogStrategy {
  let built: Promise<LogStrategy> | undefined;
  const get = (): Promise<LogStrategy> => {
    built ??= build().catch((e: unknown) => {
      built = undefined;
      throw e;
    });
    return built;
  };
  return {
    queryLogs: async (q, onProgress, signal) => (await get()).queryLogs(q, onProgress, signal),
    getLog: async (ref) => (await get()).getLog(ref),
    traceLogs: async (traceId, signal) => (await get()).traceLogs(traceId, signal),
    surroundingLogs: async (ref, n) => {
      checkSurroundingCount(n); // a bad count fails before any chunk loads
      return (await get()).surroundingLogs(ref, n);
    },
  };
}

/**
 * Pick each signal's strategy with `signalBudgets`: within budget every chunk of the signal is loaded once and
 * queries are exact; above it chunks are scanned on demand. Landing data and percentiles come from the
 * unfiltered rollup files in both cases (the log rollup is loaded on first use). Eager log chunks are likewise
 * loaded on the first log call, not before the first page renders.
 */
export async function createDataSource(
  loader: ScriptLoader,
  manifest: Manifest,
  budgetBytes: number,
): Promise<DataSource> {
  const budgets = signalBudgets(manifest, budgetBytes);
  const index = createTraceIndex(loader, manifest);
  const listedLogChunks = new Set(
    manifest.chunks.flatMap((c) => (c.signal === 'logs' ? [chunkKey('logs', c.n)] : [])),
  );
  let logRollups: Promise<LogRollups> | undefined;
  const getLogRollups = (): Promise<LogRollups> => {
    logRollups ??= loadLogRollups(loader, manifest).catch((e: unknown) => {
      logRollups = undefined; // a failed load is retried on the next use
      throw e;
    });
    return logRollups;
  };
  const logs =
    budgets.logs === 'eager'
      ? lazyLogStrategy(() => createEagerLogSource(loader, manifest))
      : createWindowedLogSource(loader, manifest, getLogRollups, index);
  let metricCatalog: Promise<MetricCatalog> | undefined;
  const getMetricCatalog = (): Promise<MetricCatalog> => {
    metricCatalog ??= loadMetricCatalog(loader, manifest).catch((e: unknown) => {
      metricCatalog = undefined; // a failed load is retried on the next use
      throw e;
    });
    return metricCatalog;
  };
  let metricPoints: Promise<TimeBuckets<'points'>> | undefined;
  const getMetricPoints = (): Promise<TimeBuckets<'points'>> => {
    metricPoints ??= loadMetricPoints(loader, manifest).catch((e: unknown) => {
      metricPoints = undefined; // a failed load is retried on the next use
      throw e;
    });
    return metricPoints;
  };
  const metrics = new Lru<number, LoadedMetric>(METRIC_LRU_SIZE);
  const [rollups, spans] = await Promise.all([
    loadSpanRollups(loader, manifest),
    budgets.spans === 'eager' ? createEagerSource(loader, manifest) : null,
  ]);
  const spanStrategy = spans ?? createWindowedSource(loader, manifest, rollups, index);
  return {
    manifest,
    strategy: budgets.spans,
    logStrategy: budgets.logs,
    landing: () => Promise.resolve(landingOf(rollups)),
    async logLanding() {
      const r = await getLogRollups();
      return { facets: r.facets, buckets: r.buckets, patterns: patternRowsOf(r.patterns) };
    },
    querySpans: spanStrategy.querySpans,
    async getTrace(traceId) {
      // The count comes from the trace index, so opening a trace never waits on the log load, with one exception
      // below, and never fails with it.
      // Under the eager span strategy the spans are already in memory, so a shard that fails to load costs only the
      // log count (0); under the windowed strategy getTrace needs the same shard, so its failure stands.
      const [trace, entry] = await Promise.all([
        spanStrategy.getTrace(traceId),
        budgets.spans === 'eager' ? index.entry(traceId).catch(() => null) : index.entry(traceId),
      ]);
      if (entry === null || entry.logs === 0) return { ...trace, logCount: 0 };
      if (entry.logChunks.every((k) => listedLogChunks.has(k))) return { ...trace, logCount: entry.logs };
      // Crash only: a crash between a flush's shard write and its manifest commit leaves the shard counting logs in
      // chunks the manifest never listed. Count the committed rows instead; this waits on the log load, and if that
      // load fails the index count stands, so the trace still opens.
      const logCount = await logs.traceLogs(traceId).then(
        (rows) => rows.length,
        () => entry.logs,
      );
      return { ...trace, logCount };
    },
    hasTrace: spanStrategy.hasTrace,
    percentileOf(service, resource, durationNs) {
      const h = rollups.durations.get(`${service}${DURATION_KEY_SEP}${resource}`);
      return h === undefined ? null : percentile(h, durationNs);
    },
    queryLogs: logs.queryLogs,
    getLog: logs.getLog,
    traceLogs: logs.traceLogs,
    surroundingLogs: logs.surroundingLogs,
    metricCatalog: getMetricCatalog,
    metricPoints: getMetricPoints,
    metric: (id) => metrics.get(id, async () => loadMetric(loader, manifest, id, await getMetricCatalog())),
    metricsForResources: async (resources) => metricsOnResources(await getMetricCatalog(), resources),
    async resourceValues(key) {
      const [logsLanding, catalog] = await Promise.all([getLogRollups(), getMetricCatalog()]);
      return resourceValuesOf(
        key,
        [
          { facets: rollups.facets, resourceKeys: SPAN_RESOURCE_FACET_KEYS },
          { facets: logsLanding.facets, resourceKeys: LOG_RESOURCE_FACET_KEYS },
        ],
        catalog,
      );
    },
  };
}
