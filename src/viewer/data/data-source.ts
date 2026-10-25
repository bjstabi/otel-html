import type { Manifest } from '../../format/manifest.js';
import type { TraceId } from '../../model/ids.js';
import type { ResourceRecord, ResourceRef, ScopeRecord, ScopeRef } from '../../model/records.js';
import type { ExpHistogram } from '../../rollups/exp-histogram.js';
import type { FacetCounts } from '../../rollups/facets.js';
import type { RedSeries } from '../../rollups/red.js';
import type { SpanRollups } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import { createEagerSource } from './eager.js';
import { loadSpanRollups } from './load.js';
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
}

export interface DataSource {
  readonly manifest: Manifest;
  readonly strategy: 'eager' | 'windowed';
  landing(): Promise<Landing>;
  querySpans(
    q: SpanQuery,
    onProgress?: (scanned: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<SpanQueryResult>;
  getTrace(traceId: TraceId): Promise<TraceDetail>;
  /** Percentile (0-100) of `durationNs` within the unfiltered rollup of that service and resource, or null if unknown. */
  percentileOf(service: string, resource: string, durationNs: number): number | null;
}

/** What each strategy provides; `createDataSource` adds the shared landing and percentile parts. */
export type StrategySource = Pick<DataSource, 'querySpans' | 'getTrace'>;

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
 * Pick a strategy by the manifest's decoded size: within `budgetBytes` every span chunk is loaded once and
 * queries are exact; above it chunks are scanned on demand. Landing data and percentiles come from the
 * unfiltered rollup file in both cases.
 */
export async function createDataSource(
  loader: ScriptLoader,
  manifest: Manifest,
  budgetBytes: number,
): Promise<DataSource> {
  const rollups = await loadSpanRollups(loader, manifest);
  const eager = manifest.decodedBytes <= budgetBytes;
  const strategy = eager ? await createEagerSource(loader, manifest) : createWindowedSource(loader, manifest);
  return {
    manifest,
    strategy: eager ? 'eager' : 'windowed',
    landing: () => Promise.resolve(landingOf(rollups)),
    querySpans: strategy.querySpans,
    getTrace: strategy.getTrace,
    percentileOf(service, resource, durationNs) {
      const h = rollups.durations.get(`${service}${DURATION_KEY_SEP}${resource}`);
      return h === undefined ? null : percentile(h, durationNs);
    },
  };
}
