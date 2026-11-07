import type { ResolvedConfig } from '../config/schema.js';
import type { ManifestV4, PartitionEntry } from '../format/manifest.js';
import type { PointNormalization } from '../format/parquet/rows.js';
import { TABLES, type Table } from '../format/parquet/schema.js';
import type { Signal, StateSlot } from '../format/paths.js';
import type { SessionStateV2 } from '../format/state.js';
import { PARTITION_FORMAT_VERSION } from '../format/version.js';
import type { MetricPointRecord } from '../model/records.js';
import type { Drain } from '../rollups/drain.js';
import type { Normalized } from '../rollups/metric-streams.js';
import type { SpanHandle } from './ports.js';

/** The DuckDB-WASM version the report's engine files must match; Task 7.1 moves this to `engine-assets.ts`. */
const ENGINE_VERSION = '1.32.0';

/** What a checkpoint writes, decided at prepare time under the serial queue. */
export interface Prepared {
  complete: boolean;
  span: SpanHandle;
  /** Started at prepare, which takes the held rows; awaited by the write. */
  cut: Promise<PartitionEntry | null>;
  slot: StateSlot;
  /** `null` when nothing but the manifest changed. */
  state: { epoch: string | null; dedupe: string[]; metricStreams: unknown } | null;
  updatedAt: string;
  epoch: string;
  totals: Record<Signal, number>;
  range: { start: bigint; end: bigint } | null;
}

/** What `buildState` needs of the session. */
interface StateInputs {
  version: string;
  nextPartition: number;
  flushed: readonly number[];
  drain: ReturnType<Drain['toJSON']>;
  statisticsKeys: Record<Table, string[]>;
}

export function buildState(
  inputs: StateInputs,
  s: { epoch: string | null; dedupe: string[]; metricStreams: unknown },
  checkpoint: number,
): SessionStateV2 {
  return {
    formatVersion: 2,
    otelHtmlVersion: inputs.version,
    epochUnixNano: s.epoch,
    nextPartition: inputs.nextPartition,
    checkpoint,
    flushPartitions: [...inputs.flushed],
    dedupe: s.dedupe,
    metricStreams: s.metricStreams,
    drain: inputs.drain,
    statisticsKeys: inputs.statisticsKeys,
  };
}

/**
 * Earlier partitions (an append under another config) may lack values for a listed key: they get `null`, which
 * means unknown and prunes nothing. Values for keys no longer listed stay. Only the manifest entry changes.
 */
function withKeys(e: PartitionEntry, statisticsKeys: Record<Table, string[]>): PartitionEntry {
  const files: PartitionEntry['files'] = {};
  for (const t of TABLES) {
    const f = e.files[t];
    if (f === undefined) continue;
    const values = { ...f.values };
    for (const k of statisticsKeys[t]) if (!(k in values)) values[k] = null;
    files[t] = { ...f, values };
  }
  return { ...e, files };
}

/** What `buildManifest` needs of the session. */
interface ManifestInputs {
  version: string;
  title: string;
  createdAt: string;
  /** Committed and pending, in ascending n. */
  partitions: readonly PartitionEntry[];
  statisticsKeys: Record<Table, string[]>;
  config: ResolvedConfig;
}

export function buildManifest(m: ManifestInputs, p: Prepared): ManifestV4 {
  return {
    formatVersion: PARTITION_FORMAT_VERSION,
    otelHtmlVersion: m.version,
    title: m.title,
    epochUnixNano: p.epoch,
    createdAt: m.createdAt,
    updatedAt: p.updatedAt,
    complete: p.complete,
    range: p.range === null ? null : { start: p.range.start.toString(), end: p.range.end.toString() },
    totals: p.totals,
    partitions: m.partitions.map((e) => withKeys(e, m.statisticsKeys)),
    statisticsKeys: m.statisticsKeys,
    engine: {
      version: ENGINE_VERSION,
      format: m.config.writer.format === 'site' ? 'site' : 'local',
      assetsBase: m.config.writer.assetsBase,
    },
    config: {
      viewer: { ...m.config.viewer },
      dashboards: m.config.dashboards,
      views: m.config.views,
    },
  };
}

export const UNNORMALIZED = { deltaValue: null, deltaCount: null, reset: false, outOfOrder: false } as const;

/**
 * The normalization columns of a point from what the stream normalizer reported. Deltas exist for every counter (the
 * counter delta), every histogram (the count and sum deltas) and every delta-temporality sum, monotonic or not (its
 * own value); a reset restarts them at the point's own value, as the normalizer says. Gauges, summaries, and
 * cumulative or unspecified non-monotonic sums have none, and neither does a skipped point.
 */
export function pointNormalization(
  point: MetricPointRecord,
  n: Normalized,
  seriesId: string,
): PointNormalization {
  if (n.kind === 'skip') return { ...UNNORMALIZED, seriesId, outOfOrder: n.reason === 'out-of-order' };
  const { agg } = n;
  const base = { ...UNNORMALIZED, seriesId, reset: n.reset };
  if (agg.k === 'counter') return { ...base, deltaValue: agg.delta };
  if (agg.k === 'hist' || agg.k === 'exp') return { ...base, deltaValue: agg.sum, deltaCount: agg.count };
  if (agg.k === 'number' && point.type === 'sum' && point.temporality === 'delta') {
    return { ...base, deltaValue: agg.sum };
  }
  return base;
}
