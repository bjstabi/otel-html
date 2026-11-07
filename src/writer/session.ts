import type { ResolvedConfig } from '../config/schema.js';
import type { PartitionEntry } from '../format/manifest.js';
import type { Signal } from '../format/paths.js';
import type { UnixNanos } from '../model/ids.js';
import type { OtlpRequest } from '../model/otlp-json.js';
import type {
  LogRecordRecord,
  MetricPointRecord,
  ResourceRecord,
  ScopeRecord,
  SpanRecord,
} from '../model/records.js';
import { compileDrops, inspectFolder, type OpenMode } from './open-common.js';
import type { Clock, FileSystem, Logger, ProcessInfo, Timers, Tracer } from './ports.js';
import type { ViewerAssets } from './viewer-assets.js';

export interface WriterDeps {
  fs: FileSystem;
  clock: Clock;
  /** Arms the idle checkpoint; a timer must not keep the process alive. */
  timers: Timers;
  logger: Logger;
  tracer: Tracer;
  process: ProcessInfo;
  viewerAssets: ViewerAssets;
  /** The otel-html version recorded in the report; append requires the same one. */
  version: string;
  /**
   * Called once, before the session takes its first metric points: the CLI tunes V8 for the long, steady
   * allocation of a large metrics run there, so trace and log conversions are not slowed down by it.
   */
  beforeMetrics?: () => void;
}

/** `open` appends when the folder holds a report and creates one otherwise; `replace` starts a new report over any report. */
export type SessionMode = OpenMode;

/** The partitions of one format-4 merge input, as `WriterSession.copyPartitions` takes them. */
export interface PartitionCopy {
  /** The input's position among the sorted merge inputs; it names the copies' `source` and groups `--compact`. */
  origin: number;
  /** The input report's folder: where its partition files are read from. */
  dir: string;
  epoch: UnixNanos;
  totals: Record<Signal, number>;
  /** Absolute int64 nanosecond text, as in the manifest. */
  range: { start: string; end: string } | null;
  partitions: readonly PartitionEntry[];
}

export interface SessionOptions {
  out: string;
  config: ResolvedConfig;
  mode: SessionMode;
}

export interface AddResult {
  accepted: number;
  dropped: number;
  duplicates: number;
}

/**
 * Normalized rows with their own resource/scope tables and epoch, as read from another report. `origin` numbers
 * the report when a merge replays several, so a cumulative series' streams in the next report are not counted as
 * restarts of the previous report's.
 */
export type RecordBatch = (
  | {
      signal: 'spans';
      rows: readonly SpanRecord[];
      resources: readonly ResourceRecord[];
      scopes: readonly ScopeRecord[];
      epoch: UnixNanos;
    }
  | {
      signal: 'logs';
      rows: readonly LogRecordRecord[];
      resources: readonly ResourceRecord[];
      scopes: readonly ScopeRecord[];
      epoch: UnixNanos;
    }
  | {
      signal: 'metrics';
      rows: readonly MetricPointRecord[];
      resources: readonly ResourceRecord[];
      scopes: readonly ScopeRecord[];
      epoch: UnixNanos;
    }
) & { origin?: number };

export interface AddOptions {
  /**
   * More of the same input follows (a file read one resource entry at a time). Until `endInput`, no periodic
   * checkpoint runs and a report being replaced is not wiped, so a bad entry later in the input leaves the
   * committed report as it was. In append and fresh-create mode, partitions written before a failing entry stay on
   * disk outside the manifest: never read, and pruned when the next session opens the report.
   *
   * While a partial input goes into a report being replaced, no partition or checkpoint is written before
   * `endInput`: every accepted row stays in memory, outside the flush budget.
   * `endInput` then wipes the replaced report, so only the first input is held; later inputs are written as they
   * arrive. The first input into a replaced report should therefore fit in memory; otherwise empty the folder first.
   */
  readonly partial?: boolean;
}

export interface ReportSummary {
  out: string;
  totals: Record<Signal, number>;
  /** The number of partitions the report lists. */
  chunks: number;
  bytes: number;
}

export interface WriterSession {
  add(input: OtlpRequest, source: string, options?: AddOptions): Promise<AddResult>;
  /** The input fed through `partial` adds is complete: write held rows and checkpoint if one is due. */
  endInput(): Promise<void>;
  addRecords(batch: RecordBatch): Promise<AddResult>;
  /**
   * Merge only: adopts a format-4 report's partitions into this one, copying their files byte for byte. Only the
   * partition session has it; the only session there is.
   */
  copyPartitions?(copy: PartitionCopy): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<ReportSummary>;
  /**
   * Give up: release the lock without a final checkpoint. Used when a multi-step job (merge) fails midway;
   * whatever was committed by earlier checkpoints stays, marked incomplete.
   */
  abort(): Promise<void>;
}

export async function openSession(deps: WriterDeps, options: SessionOptions): Promise<WriterSession> {
  const { config } = options;
  const out = options.out.replace(/\/+$/, '') || options.out;
  const drop = compileDrops(config);
  const { appending, preexisting } = await inspectFolder(deps.fs, out, options.mode);
  // Lazy: the partition session pulls in parquet-wasm, which the other commands never need.
  const { openPartitionSession } = await import('./partition-session.js');
  return openPartitionSession(deps, { out, config, mode: options.mode }, drop, { appending, preexisting });
}
