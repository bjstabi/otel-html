import type { Manifest } from '../../format/manifest.js';
import type { TraceId } from '../../model/ids.js';
import type { ResourceRecord, ResourceRef, ScopeRecord, ScopeRef } from '../../model/records.js';
import type { ExpHistogram } from '../../rollups/exp-histogram.js';
import type { FacetCounts } from '../../rollups/facets.js';
import type { LogRollups } from '../../rollups/log-rollups.js';
import type { RedSeries } from '../../rollups/red.js';
import type { LogSeverityKey } from '../../rollups/signal-counts.js';
import type { SpanRollups } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
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
  /** True when the windowed scan stopped at its neighbor-chunk cap before finding `n` on a side. */
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
}

/** What each span strategy provides; `createDataSource` adds the landing, percentile and log-count parts. */
export interface SpanStrategy extends Pick<DataSource, 'querySpans' | 'hasTrace'> {
  getTrace(traceId: TraceId): Promise<SpanTrace>;
}

/** What each log strategy provides; `createDataSource` adds the landing. */
export interface LogStrategy
  extends Pick<DataSource, 'queryLogs' | 'getLog' | 'traceLogs' | 'surroundingLogs'> {
  /** Log records carrying the trace id (for `TraceDetail.logCount`). */
  logCount(traceId: TraceId): Promise<number>;
}

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
    logCount: async (traceId) => (await get()).logCount(traceId),
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
      const [trace, logCount] = await Promise.all([spanStrategy.getTrace(traceId), logs.logCount(traceId)]);
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
  };
}
