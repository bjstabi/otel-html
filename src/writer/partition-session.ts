import type { ResolvedConfig } from '../config/schema.js';
import { widgetTraceConditions } from '../config/widget-traces.js';
import {
  type PartitionEntry,
  type PartitionFile,
  ROLLUP_GRAIN_NS,
  type RollupDescription,
} from '../format/manifest.js';
import { batchFromRows, type ColumnBatch } from '../format/parquet/batch.js';
import { checkRow, encodeColumns } from '../format/parquet/codec.js';
import {
  ROLLUP_OF,
  type RollupTable,
  STATISTICS_TABLES,
  type StatisticsTable,
  TABLE_COLUMNS,
  TABLES,
  type Table,
} from '../format/parquet/columns.js';
import { applyNormalization, logRow, pointRow, type Row, spanRow } from '../format/parquet/rows.js';
import {
  completeStatistics,
  fileStatistics,
  statisticsKeysFor,
  statisticsKeysOf,
  widgetOnlyKeysFor,
} from '../format/parquet/stats.js';
import { type PanicGuard, readColumns } from '../format/parquet/stream.js';
import {
  DEFAULT_ASSETS_BASE,
  LOCK_PATH,
  partitionDir,
  partitionFilePath,
  partitionKey,
  partitionWrapperPath,
  type Signal,
  STATE_DIR,
  type StateSlot,
} from '../format/paths.js';
import { OtelHtmlError } from '../model/errors.js';
import { parseUnixNanos, type UnixNanos } from '../model/ids.js';
import {
  createNormalizeContext,
  earliestTimestamp,
  type NormalizeContext,
  normalizeLogs,
  normalizeTraces,
} from '../model/normalize.js';
import type { OtlpRequest } from '../model/otlp-json.js';
import { metricPointsOf } from '../model/otlp-json-metrics.js';
import { type LogRecordRecord, logTime, type MetricPointRecord, type SpanRecord } from '../model/records.js';
import type { LogTarget, SpanTarget } from '../ottl/contexts.js';
import { Drain } from '../rollups/drain.js';
import { StreamNormalizer } from '../rollups/metric-streams.js';
import { severityKey } from '../semconv/severity.js';
import { assetsInside, linkedAssetsHint, pruneOwnAssets } from './assets-cleanup.js';
import {
  at,
  loadPartitionCheckpoint,
  wipeReportData,
  writeManifest,
  writeStateSlotV2,
} from './checkpoint.js';
import { compactPartitions, latestTemplates, timeGroups, timeRangeOf } from './compaction.js';
import { DedupeSet } from './dedupe.js';
import { renderIndexHtml } from './html.js';
import { inheritDashboards } from './inherit-config.js';
import { acquireLock, type LockHandle } from './lock.js';
import { DEFAULT_TITLE, type Drops, type FolderState, iso, warnIfLocalLarge } from './open-common.js';
import {
  buildManifest,
  buildState,
  type Prepared,
  pointNormalization,
  UNNORMALIZED,
} from './partition-checkpoint.js';
import { type Derived, PartitionWriter } from './partition-writer.js';
import { patternRows } from './pattern-rows.js';
import { prunePartitions } from './prune.js';
import { rebaseBatch } from './rebase.js';
import {
  logRollupRows,
  rollupAllowed,
  rollupDimensions,
  rollupKeyAllowed,
  rollupSumsFit,
  spanRollupRows,
  widestDimension,
} from './rollup-rows.js';
import { seriesIdOf } from './series-id.js';
import type {
  AddOptions,
  AddResult,
  PartitionCopy,
  RecordBatch,
  ReportSummary,
  SessionOptions,
  WriterDeps,
  WriterSession,
} from './session.js';
import { traceRows } from './trace-summaries.js';
import { writeViewerAssets } from './viewer-assets.js';
import { watchWasmPanics } from './wasm-panic.js';
import {
  type CompiledWidgetIndex,
  compileWidgetIndex,
  encodeWidgetTraces,
  WidgetTraceSet,
  widgetIndexAllowed,
  widgetIndexInexact,
  widgetIndexTooLarge,
} from './widget-trace-rows.js';
import { writeWrapper } from './wrapper-file.js';

interface Restored {
  lock: LockHandle;
  /** The anchor the restored stream state's times are relative to (the checkpoint's); `null` when it has none. */
  streamAnchor: UnixNanos | null;
  dedupe: DedupeSet;
  drain: Drain;
  normalizer: StreamNormalizer;
  nextPartition: number;
  checkpoint: number;
  flushed: number[];
  committed: PartitionEntry[];
  totals: Record<Signal, number>;
  range: { start: bigint; end: bigint } | null;
  createdAt: string;
  title: string;
  slot: StateSlot;
  /** Resumed from an existing report. */
  resumed: boolean;
  /** An existing report is being replaced; its data goes just before this session first writes. */
  replacing: boolean;
}

/** The format-5 half of `openSession`: the folder checks and the drop conditions have passed already. */
export async function openPartitionSession(
  deps: WriterDeps,
  options: SessionOptions,
  drop: Drops,
  folder: FolderState,
): Promise<WriterSession> {
  const { out } = options;
  let { config } = options;
  const { fs } = deps;
  // The viewer files would be deleted and recreated through the link: its target is not this report's to rewrite.
  if (config.writer.assetsBase === DEFAULT_ASSETS_BASE && !(await assetsInside(fs, out))) {
    const recorded = folder.appending
      ? await loadPartitionCheckpoint(fs, out, deps.version, config.writer.format).then(
          (cp) => cp.manifest.engine.assetsBase,
          () => DEFAULT_ASSETS_BASE,
        )
      : DEFAULT_ASSETS_BASE;
    const target = await fs.realpath(at(out, 'assets')).catch(() => undefined);
    const where = target === undefined ? '' : ` (it points at ${target})`;
    const shared = recorded !== DEFAULT_ASSETS_BASE;
    throw new OtelHtmlError('invalid-report', {
      message: `${out}/assets links out of the report${where}, and writing the report's viewer files would rewrite the link's target`,
      hint: shared
        ? linkedAssetsHint(out, { recorded })
        : linkedAssetsHint(out, { replacing: !folder.appending }),
    });
  }
  await fs.mkdirp(at(out, STATE_DIR));
  const lock = await acquireLock(deps, at(out, LOCK_PATH));
  try {
    let restored: Restored;
    if (!folder.appending) {
      restored = {
        lock,
        streamAnchor: null,
        dedupe: new DedupeSet(config.writer.dedupeCapacity),
        drain: new Drain(),
        normalizer: new StreamNormalizer(),
        nextPartition: 0,
        checkpoint: 0,
        flushed: [],
        committed: [],
        totals: { spans: 0, logs: 0, metrics: 0 },
        range: null,
        createdAt: iso(deps.clock),
        title: config.title ?? DEFAULT_TITLE,
        slot: 1, // the first checkpoint goes to slot 0
        resumed: false,
        replacing: folder.preexisting,
      };
    } else {
      const cp = await loadPartitionCheckpoint(fs, out, deps.version, config.writer.format);
      config = inheritDashboards(config, cp.manifest.config);
      // The partitions already written have (local) or lack (site) their base64 scripts, and the engine files differ.
      // The report's own assets/ (about 46 MB of engine files) would be left behind, and index.html rewritten past it.
      if (
        cp.manifest.engine.assetsBase === DEFAULT_ASSETS_BASE &&
        config.writer.assetsBase !== DEFAULT_ASSETS_BASE
      ) {
        throw new OtelHtmlError('usage', {
          message: `cannot append with writer.assetsBase ${config.writer.assetsBase} to a report that carries its own assets/`,
          hint: `append with --assets-base ${DEFAULT_ASSETS_BASE}, or move the report with \`otel-html upgrade ${out} --assets-base ${config.writer.assetsBase}\``,
        });
      }
      if (cp.manifest.engine.format !== config.writer.format) {
        throw new OtelHtmlError('usage', {
          message: `cannot append as writer.format ${config.writer.format} to a ${cp.manifest.engine.format} report`,
          hint: `append with --format ${cp.manifest.engine.format}, or switch the report with \`otel-html upgrade ${out} --format ${config.writer.format}\``,
        });
      }
      // Before any write: what an interrupted session left unlisted must not meet this session's cuts.
      const pruned = await prunePartitions(fs, out, cp.manifest.partitions);
      if (pruned > 0)
        deps.logger.info('removed unlisted partition data left by an interrupted session', { pruned });
      restored = {
        lock,
        streamAnchor:
          cp.state.epochUnixNano === null
            ? null
            : parseUnixNanos(cp.state.epochUnixNano, 'state.epochUnixNano'),
        dedupe: DedupeSet.from(cp.state.dedupe, config.writer.dedupeCapacity),
        drain: cp.state.drain === null ? new Drain() : Drain.from(cp.state.drain, 'state.drain'),
        normalizer:
          cp.state.metricStreams === null
            ? new StreamNormalizer()
            : StreamNormalizer.from(cp.state.metricStreams, 'state.metricStreams'),
        nextPartition: cp.state.nextPartition,
        checkpoint: cp.state.checkpoint,
        // A report left incomplete was interrupted: its flush partitions still await compaction. A closed one
        // handed them over already, so this session's list starts empty.
        flushed: cp.manifest.complete ? [] : [...cp.state.flushPartitions],
        committed: [...cp.manifest.partitions],
        totals: { ...cp.manifest.totals },
        range:
          cp.manifest.range === null
            ? null
            : { start: BigInt(cp.manifest.range.start), end: BigInt(cp.manifest.range.end) },
        createdAt: cp.manifest.createdAt,
        title: config.title ?? cp.manifest.title,
        slot: cp.slot,
        resumed: true,
        replacing: false,
      };
    }
    await fs.mkdirp(at(out, 'data/partitions'));
    return new PartitionSession(deps, out, config, drop, restored);
  } catch (e) {
    await lock.release();
    throw e;
  }
}

/** Every column of a base table file, decoded into one batch. */
async function decodeBatch(
  base: 'spans' | 'logs',
  bytes: Uint8Array,
  path: string,
  guard: PanicGuard,
): Promise<ColumnBatch> {
  const names = TABLE_COLUMNS[base].map((c) => c.name);
  const cells = new Map<string, unknown[]>(names.map((name) => [name, []]));
  let length = 0;
  for await (const cols of readColumns(
    base,
    new Blob([bytes as Uint8Array<ArrayBuffer>]),
    path,
    undefined,
    guard,
  )) {
    length += cols[0]?.length ?? 0;
    for (const [i, name] of names.entries()) {
      const into = cells.get(name);
      if (into !== undefined) for (const v of cols[i] ?? []) into.push(v);
    }
  }
  return { length, cells: Object.fromEntries(cells) };
}

/** The spans or logs file as chunks of its row groups, each a batch of every column. */
async function* streamBatches(
  base: 'spans' | 'logs',
  bytes: Uint8Array,
  path: string,
  guard: PanicGuard,
): AsyncGenerator<ColumnBatch> {
  const names = TABLE_COLUMNS[base].map((c) => c.name);
  for await (const cols of readColumns(
    base,
    new Blob([bytes as Uint8Array<ArrayBuffer>]),
    path,
    undefined,
    guard,
  )) {
    const cells: Record<string, unknown[]> = {};
    for (const [i, name] of names.entries()) cells[name] = cols[i] ?? [];
    yield { length: cols[0]?.length ?? 0, cells };
  }
}

async function* wholeOf(batch: Promise<ColumnBatch>): AsyncGenerator<ColumnBatch> {
  yield await batch;
}

/** `chunks`, each passed to `tap` before it is yielded. */
async function* tapped(
  chunks: AsyncIterable<ColumnBatch>,
  tap: (chunk: ColumnBatch) => void,
): AsyncGenerator<ColumnBatch> {
  for await (const chunk of chunks) {
    tap(chunk);
    yield chunk;
  }
}

/** Whether a copied file's index (undefined for a format 5 or 6 file) holds every condition and variable `index` writes. */
function coversIndex(
  have: { conditions: string[]; variables: string[] } | undefined,
  index: CompiledWidgetIndex,
): boolean {
  if (have === undefined) return false;
  const c = new Set(have.conditions);
  const v = new Set(have.variables);
  return (
    index.description.conditions.every((x) => c.has(x)) && index.description.variables.every((x) => v.has(x))
  );
}

class PartitionSession implements WriterSession {
  readonly #deps: WriterDeps;
  readonly #out: string;
  readonly #config: ResolvedConfig;
  readonly #drop: Drops;
  readonly #lock: LockHandle;
  #dedupe: DedupeSet | null;
  /** Cumulative-stream state of the points accepted so far (held ones included); frozen at each prepare. */
  #normalizer: StreamNormalizer | null;
  /** The committed log-template state: swapped in only after a cut's files were written. */
  #drain: Drain | null;
  /** The state `release` serialised before it dropped the live structures; the final checkpoint writes these. */
  #frozen: { dedupe: string; metricStreams: string; drain: string } | null = null;
  readonly #writer: PartitionWriter;
  readonly #statisticsKeys: Record<StatisticsTable, string[]>;
  /** The statistics keys only a widget condition asked for, per table: a rollup keeps one while it is cheap (`rollupKeyAllowed`). */
  readonly #widgetKeys: Record<StatisticsTable, string[]>;
  /** The (table, key) pairs a widget key was left out of a rollup for, already warned about this session. */
  readonly #toldKeys = new Set<string>();
  /** The widget trace index of this report's config, null when it has no indexed traces widget. */
  readonly #widgetIndex: CompiledWidgetIndex | null;
  /** The widget index messages already told this session (a partition that refuses its index says so once). */
  readonly #toldIndex = new Set<string>();
  readonly #createdAt: string;
  readonly #title: string;
  /** The anchor this session's own records are relative to: its own first record's time, fixed once data is accepted. Times in files are absolute. */
  #ownAnchor: UnixNanos | null = null;
  /** The anchor the held stream state's times (and the checkpointed `epoch`) are relative to: the checkpoint's until this session picks its own, then equal to `#ownAnchor`. */
  #streamAnchor: UnixNanos | null;
  #ctx: NormalizeContext | null = null;
  #committed: PartitionEntry[];
  /** Cut partitions the committed manifest does not list yet (a checkpoint failed after the cut). */
  #pending: PartitionEntry[] = [];
  #flushed: number[];
  /** The partition numbers `copyPartitions` took, by merge input: what `writer.compactOnMerge` compacts, per input. */
  readonly #copied = new Map<number, number[]>();
  #totals: Record<Signal, number>;
  #range: { start: bigint; end: bigint } | null;
  #slot: StateSlot;
  #dirty: boolean;
  #everCommitted: boolean;
  #shellWritten = false;
  #warnedLarge = false;
  #lastFlushMs: number;
  #backoffUntilMs = 0;
  #closed: ReportSummary | null = null;
  /** The finished report's summary, kept when the lock release after it failed, so a second close retries only that. */
  #closeSummary: ReportSummary | null = null;
  #aborted = false;
  /** The lock is gone after an abort: a rejected release leaves this false, and the next `abort()` retries it. */
  #lockReleased = false;
  /** Set when close released the live state: only `close` (again) and `abort` remain. */
  #closing = false;
  #replacing: boolean;
  #partial = false;
  /** `WriterDeps.beforeMetrics` runs once, when the first metric points arrive. */
  #metricsSeen = false;
  /** The `checkpoint` counter of the last committed state write. */
  #checkpointSeq: number;
  #tail: Promise<unknown> = Promise.resolve();
  #inflight: Promise<void> | null = null;
  #sinceCheckpoint = false;
  #cancelIdle: (() => void) | null = null;

  constructor(deps: WriterDeps, out: string, config: ResolvedConfig, drop: Drops, r: Restored) {
    this.#deps = deps;
    this.#out = out;
    this.#config = config;
    this.#drop = drop;
    this.#lock = r.lock;
    this.#dedupe = r.dedupe;
    this.#normalizer = r.normalizer;
    this.#drain = r.drain;
    this.#statisticsKeys = Object.fromEntries(
      STATISTICS_TABLES.map((t) => [t, statisticsKeysFor(t, config)]),
    ) as Record<StatisticsTable, string[]>;
    this.#widgetKeys = Object.fromEntries(
      STATISTICS_TABLES.map((t) => [t, widgetOnlyKeysFor(t, config)]),
    ) as Record<StatisticsTable, string[]>;
    const spec = widgetTraceConditions(config.dashboards);
    this.#widgetIndex = compileWidgetIndex(spec);
    for (const source of spec.notRowLocal) {
      deps.logger.warn(
        'a traces widget condition is not indexed: it calls a converter that is not row local, so its partitions are scanned',
        { condition: source },
      );
    }
    this.#writer = new PartitionWriter(deps.fs, {
      out,
      rowGroupRows: deps.rowGroupRows ?? config.writer.rowGroupRows,
      statisticsKeys: this.#statisticsKeys,
      facetValueCap: config.writer.facetValueCap,
      nextPartition: r.nextPartition,
      format: config.writer.format,
      derive: (taken) => {
        const p = patternRows(this.#live(this.#drain), taken.logs, this.#streamAnchor ?? 0n);
        const r = this.#rollups(taken);
        return {
          rows: { traces: traceRows(taken.spans, taken.logs), patterns: p.rows, ...r.rows },
          rollups: r.descriptions,
          ...this.#widgetRows(taken.spans),
          commit: () => {
            this.#drain = p.drain;
          },
        };
      },
    });
    this.#createdAt = r.createdAt;
    this.#title = r.title;
    this.#streamAnchor = r.streamAnchor;
    this.#committed = r.committed;
    this.#flushed = r.flushed;
    this.#totals = r.totals;
    this.#range = r.range;
    this.#slot = r.slot;
    this.#checkpointSeq = r.checkpoint;
    this.#dirty = r.resumed;
    this.#replacing = r.replacing;
    this.#everCommitted = r.resumed;
    this.#lastFlushMs = deps.clock.monotonicMs();
  }

  /**
   * The rollup rows of `batch` (rows of `base`) with this report's dimensions and their description; null, with a
   * warning, when the guard refuses them (a duration sum beyond int64, or a rollup that does not shrink the table).
   * A key only a widget condition asked for is added to the dimensions one at a time, and dropped, with a warning
   * naming it, when the rollup with it would exceed the row guard or weigh over 15 % of the encoded `batch`
   * (`rollupKeyAllowed`): a widget on a dropped key reads the partition's raw file, as before.
   * `baseBytes` is the size of the base file when the caller has it; otherwise it is measured by encoding `batch`.
   */
  #rollupOf(
    base: 'spans' | 'logs',
    batch: ColumnBatch,
    baseBytes?: number,
  ): { rows: Row[]; description: RollupDescription } | null {
    const make = (dims: readonly string[]): Row[] =>
      (base === 'spans' ? spanRollupRows : logRollupRows)(batch, dims);
    const widget = new Set(this.#widgetKeys[base]);
    const fixed = this.#statisticsKeys[base].filter((k) => !widget.has(k));
    let kept: string[] = fixed;
    let dimensions = rollupDimensions(base, kept);
    let made = make(dimensions);
    if (!rollupSumsFit(made)) {
      this.#deps.logger.warn(
        `the ${base} rollup has a duration sum beyond the int64 range, so it is not written`,
        {
          rollupRows: made.length,
          baseRows: batch.length,
        },
      );
      return null;
    }
    if (!rollupAllowed(made.length, batch.length)) {
      const widest = widestDimension(made, dimensions);
      this.#deps.logger.warn(`the ${base} rollup does not shrink this partition, so it is not written`, {
        rollupRows: made.length,
        baseRows: batch.length,
        widestDimension: widest?.dimension,
        distinctValues: widest?.distinct,
      });
      return null;
    }
    const rollupTable = base === 'spans' ? 'span_rollups' : 'log_rollups';
    let size = baseBytes;
    let current: number | undefined;
    const refused: string[] = [];
    const encodedSize = (rows: readonly Row[]): number =>
      encodeColumns(rollupTable, batchFromRows(rollupTable, rows), this.#encodeOptions()).length;
    for (const key of this.#statisticsKeys[base].filter((k) => widget.has(k))) {
      const tryDimensions = rollupDimensions(base, [...kept, key]);
      const tried = make(tryDimensions);
      let why: string | null = null;
      let rollupBytes: number | undefined;
      if (!rollupSumsFit(tried) || !rollupAllowed(tried.length, batch.length)) why = 'does not shrink';
      else {
        size ??= encodeColumns(base, batch, this.#encodeOptions()).length;
        current ??= encodedSize(made);
        rollupBytes = encodedSize(tried);
        // the key's own contribution: a rollup has a fixed cost (schema, statistics) that the key does not add
        if (!rollupKeyAllowed(rollupBytes - current, size)) why = 'too large';
      }
      if (why !== null) {
        // once per session and (table, key): every later flush would say the same
        const told = `${base}\0${key}`;
        const log = this.#toldKeys.has(told) ? 'debug' : 'warn';
        this.#toldKeys.add(told);
        refused.push(key);
        this.#deps.logger[log](
          `the ${base} rollup does not group by ${key}, which a widget condition tests: the rollup would be ${why}`,
          {
            key,
            rollupRows: tried.length,
            baseRows: batch.length,
            rollupBytes,
            rollupBytesWithout: current,
            baseBytes: size,
          },
        );
        continue;
      }
      kept = [...kept, key];
      current = rollupBytes;
      dimensions = tryDimensions;
      made = tried;
    }
    return {
      rows: made,
      description: {
        grainNs: ROLLUP_GRAIN_NS,
        dimensions,
        ...(base === 'spans' ? { durationBuckets: 'log2x8' as const } : {}),
        ...(refused.length === 0 ? {} : { refused: refused.sort() }),
      },
    };
  }

  #encodeOptions(): { rowGroupRows: number } {
    return { rowGroupRows: this.#deps.rowGroupRows ?? this.#config.writer.rowGroupRows };
  }

  /** Tells `message` once per session when it is a widget index refusal, every time otherwise. */
  #warnOnce(message: string, attrs: Record<string, unknown>): void {
    if (message.startsWith('the widget trace index')) {
      if (this.#toldIndex.has(message)) return;
      this.#toldIndex.add(message);
    }
    this.#deps.logger.warn(message, attrs);
  }

  /** The `widget_traces` rows of a cut's spans; nothing for a cut without spans or a set that is not exact. */
  #widgetRows(spans: ColumnBatch): Pick<Derived, 'widgetIndex'> {
    const index = this.#widgetIndex;
    if (index === null || spans.length === 0) return {};
    const set = new WidgetTraceSet(index);
    set.add(spans);
    return this.#widgetRowsOf(set, index);
  }

  /** The `widget_traces` rows of a filled set, with the guard and the inexact warning. */
  #widgetRowsOf(set: WidgetTraceSet, index: CompiledWidgetIndex): Pick<Derived, 'widgetIndex'> {
    if (!set.exact) {
      this.#warnOnce(...widgetIndexInexact(index));
      return {};
    }
    return {
      widgetIndex: {
        rows: set.rows(),
        index,
        allowed: (indexBytes, emptyBytes, spansBytes) => {
          if (widgetIndexAllowed(indexBytes, emptyBytes, spansBytes)) return true;
          this.#warnOnce(...widgetIndexTooLarge(index, indexBytes - emptyBytes, spansBytes));
          return false;
        },
      },
    };
  }

  /** The rollup rows of a cut and their descriptions; a table whose rollup the guard refuses gets neither, and a warning. */
  #rollups(taken: Readonly<Record<Table, ColumnBatch>>): {
    rows: Partial<Record<RollupTable, Row[]>>;
    descriptions: Partial<Record<RollupTable, RollupDescription>>;
  } {
    const rows: Partial<Record<RollupTable, Row[]>> = {};
    const descriptions: Partial<Record<RollupTable, RollupDescription>> = {};
    const plans = [
      { table: 'span_rollups', base: 'spans' },
      { table: 'log_rollups', base: 'logs' },
    ] as const;
    for (const { table, base } of plans) {
      const batch = taken[base];
      if (batch.length === 0) continue;
      const made = this.#rollupOf(base, batch);
      if (made === null) continue;
      rows[table] = made.rows;
      descriptions[table] = made.description;
    }
    return { rows, descriptions };
  }

  #beforeMetrics(): void {
    if (this.#metricsSeen) return;
    this.#metricsSeen = true;
    this.#deps.beforeMetrics?.();
  }

  // -- public API ------------------------------------------------------------------------------

  /**
   * Stages the request's rows and returns once they are accepted. Back-pressure: when the held rows reach
   * `writer.chunkTargetBytes` while a background checkpoint is still being written, the call waits for that write
   * (the held rows were taken by it, so the next checkpoint starts at once). While checkpoints succeed the writer therefore
   * never holds more than `2 × chunkTargetBytes` plus one request's rows (a failed write is logged and retried after a
   * back-off, and rows keep accumulating until one succeeds). A partial input is unchanged: it cuts at the size rule.
   */
  add(input: OtlpRequest, source: string, options?: AddOptions): Promise<AddResult> {
    return this.#serial(async () => {
      this.#assertOpen();
      this.#partial = options?.partial === true;
      const result = this.#anchoredBy((): AddResult => {
        const ctx = this.#ensureEpoch(earliestTimestamp(input));
        const first = input.first ?? 0;
        if (input.signal === 'metrics') {
          this.#beforeMetrics();
          const points = [...metricPointsOf(input, ctx, source)];
          this.#settleEpoch(points.length);
          return this.#acceptPoints(points);
        }
        if (input.signal === 'traces') {
          const rows = normalizeTraces(input.request, ctx, source, first);
          this.#settleEpoch(rows.length);
          return this.#acceptSpans(rows);
        }
        const rows = normalizeLogs(input.request, ctx, source, first);
        this.#settleEpoch(rows.length);
        return this.#acceptLogs(rows, source);
      });
      if (result.accepted > 0) this.#sinceCheckpoint = true;
      if (!this.#partial) {
        if (this.#inflight !== null && this.#writer.pendingBytes >= this.#config.writer.chunkTargetBytes) {
          await this.#inflight; // never rejects: a failed write is logged and backed off, and its rows are held for the next checkpoint
        }
        await this.#maybeCheckpoint();
      } else if (!this.#replacing) await this.#cutPartial();
      this.#armIdle();
      return result;
    });
  }

  endInput(): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      this.#partial = false;
      // The input has been read without error: the replaced report can go, which bounds the in-memory hold.
      if (this.#replacing) await this.#wipeReplaced();
      await this.#maybeCheckpoint();
      this.#armIdle();
    });
  }

  addRecords(batch: RecordBatch): Promise<AddResult> {
    return this.#serial(async () => {
      this.#assertOpen();
      this.#partial = false;
      const result = this.#anchoredBy((): AddResult => {
        const rebased = rebaseBatch(batch, (epoch) => this.#ensureEpoch(epoch));
        if (rebased === null) return { accepted: 0, dropped: 0, duplicates: 0 };
        switch (rebased.signal) {
          case 'spans':
            return this.#acceptSpans(rebased.rows);
          case 'logs':
            return this.#acceptLogs(rebased.rows, 'records');
          case 'metrics':
            this.#beforeMetrics();
            return this.#acceptPoints(Array.from(rebased.rows()), batch.origin);
        }
      });
      if (result.accepted > 0) this.#sinceCheckpoint = true;
      await this.#maybeCheckpoint();
      this.#armIdle();
      return result;
    });
  }

  copyPartitions(copy: PartitionCopy): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      this.#partial = false;
      // A background write may be cutting: partition numbers are taken only between cuts.
      await this.#inflight;
      await this.#wipeReplaced();
      // Copied files hold absolute times: the copy neither needs nor sets this session's anchor.
      const taken = this.#copied.get(copy.origin) ?? [];
      this.#copied.set(copy.origin, taken);
      for (const src of copy.partitions) {
        const n = this.#writer.nextPartition;
        const entry = await this.#copyPartition(copy, src, n);
        this.#writer.skipTo(n + 1);
        this.#pending.push(entry);
        taken.push(n);
      }
      for (const signal of ['spans', 'logs', 'metrics'] as const) this.#totals[signal] += copy.totals[signal];
      if (copy.range !== null) {
        const start = BigInt(copy.range.start);
        const end = BigInt(copy.range.end);
        if (this.#range === null) this.#range = { start, end };
        else {
          if (start < this.#range.start) this.#range.start = start;
          if (end > this.#range.end) this.#range.end = end;
        }
      }
      this.#dirty = true;
      this.#sinceCheckpoint = true;
      await this.#maybeCheckpoint();
      this.#armIdle();
    });
  }

  flush(): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      await this.#checkpoint(false);
    });
  }

  close(): Promise<ReportSummary> {
    return this.#serial(async () => {
      if (this.#closed !== null) return this.#closed;
      if (this.#aborted) throw new Error(`session for ${this.#out} is closed`);
      if (this.#closeSummary !== null) {
        // The report is complete and only the lock release failed: retry just that.
        await this.#lock.release();
        this.#closed = this.#closeSummary;
        return this.#closed;
      }
      if (!this.#closing) this.#assertOpen();
      this.#disarmIdle();
      await this.#checkpoint(false);
      if (!this.#shellWritten) await this.#writeShell();
      this.#release();
      await this.#compact();
      await this.#checkpoint(true);
      this.#warnIfLarge(); // after the compaction is committed: the total close leaves behind
      await this.#pruneCommitted();
      const summary = this.#summary();
      this.#closeSummary = summary;
      await this.#lock.release();
      this.#closed = summary;
      return summary;
    });
  }

  abort(): Promise<void> {
    return this.#serial(async () => {
      if (this.#closed !== null || this.#lockReleased) return;
      this.#aborted = true;
      this.#disarmIdle();
      await this.#inflight;
      await this.#lock.release();
      this.#lockReleased = true;
    });
  }

  // -- internals -------------------------------------------------------------------------------

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#tail.then(fn);
    this.#tail = p.catch(() => undefined);
    return p;
  }

  #assertOpen(): void {
    if (this.#closed !== null || this.#aborted) throw new Error(`session for ${this.#out} is closed`);
    if (this.#closing) throw new Error(`session for ${this.#out} is closing`);
  }

  #summary(): ReportSummary {
    const all = [...this.#committed, ...this.#pending];
    let bytes = 0;
    for (const p of all) for (const f of Object.values(p.files)) bytes += f.bytes;
    return { out: this.#out, totals: { ...this.#totals }, chunks: all.length, bytes };
  }

  /**
   * Runs one request's acceptance. The anchor it may pick is provisional: when the request throws, or accepts
   * nothing, the session goes back to the state before it (anchor, context, stream times, dirty flag), so the next
   * request picks its own. The stream shift back is exact, so nothing is lost by the round trip.
   */
  #anchoredBy(accept: () => AddResult): AddResult {
    if (this.#ownAnchor !== null) return accept();
    const saved = { ctx: this.#ctx, stream: this.#streamAnchor, dirty: this.#dirty };
    const undo = (): void => {
      if (this.#ownAnchor === null && this.#ctx === saved.ctx) return;
      this.#ownAnchor = null;
      this.#ctx = saved.ctx;
      this.#dirty = saved.dirty;
      if (saved.stream === null) this.#streamAnchor = null;
      else this.#reanchorStreams(saved.stream);
    };
    let result: AddResult;
    try {
      result = accept();
    } catch (e) {
      undo();
      throw e;
    }
    if (result.accepted === 0) undo();
    return result;
  }

  /** The epoch rule: the earliest timestamp of the first data that has one, never changed. */
  #ensureEpoch(candidate: UnixNanos | null): NormalizeContext {
    if (this.#ownAnchor !== null && this.#ctx !== null) return this.#ctx;
    if (candidate === null) {
      this.#ctx ??= createNormalizeContext(this.#deps.clock.nowUnixNano());
      return this.#ctx;
    }
    const fresh = createNormalizeContext(candidate);
    this.#ownAnchor = candidate;
    this.#ctx =
      this.#ctx === null ? fresh : { ...fresh, resources: this.#ctx.resources, scopes: this.#ctx.scopes };
    this.#reanchorStreams(candidate);
    this.#dirty = true;
    return this.#ctx;
  }

  /** A resumed session's stream times move from the checkpoint's anchor to this session's own. */
  #reanchorStreams(to: UnixNanos): void {
    const from = this.#streamAnchor;
    this.#streamAnchor = to;
    if (from === null || from === to || this.#normalizer === null) return;
    this.#normalizer.shift(from - to);
  }

  #settleEpoch(records: number): void {
    if (records === 0 || this.#ownAnchor !== null || this.#ctx === null) return;
    this.#ownAnchor = this.#ctx.epoch;
    this.#reanchorStreams(this.#ctx.epoch);
    this.#dirty = true;
  }

  #context(): NormalizeContext {
    if (this.#ctx === null) throw new Error('invariant violated: records accepted before the epoch was set');
    return this.#ctx;
  }

  #extend(ctx: NormalizeContext, start: number, end: number): void {
    const s = ctx.epoch + BigInt(start);
    const e = ctx.epoch + BigInt(end);
    if (this.#range === null) this.#range = { start: s, end: e };
    else {
      if (s < this.#range.start) this.#range.start = s;
      if (e > this.#range.end) this.#range.end = e;
    }
  }

  /**
   * All or nothing: everything that can fail (drop conditions, row conversion) runs on
   * staged rows first; the commit that follows is synchronous.
   */
  #acceptSpans(rows: readonly SpanRecord[]): AddResult {
    const ctx = this.#context();
    const rowCtx = {
      epoch: ctx.epoch,
      resources: ctx.resources.get.bind(ctx.resources),
      scopes: ctx.scopes.get.bind(ctx.scopes),
    };
    let dropped = 0;
    let duplicates = 0;
    const seenInRequest = new Set<string>();
    const staged: { span: SpanRecord; row: Row }[] = [];
    for (const span of rows) {
      const target: SpanTarget = {
        span,
        resource: ctx.resources.get(span.resource),
        scope: ctx.scopes.get(span.scope),
        epoch: ctx.epoch,
      };
      if (this.#drop.span.test(target)) {
        dropped++;
        continue;
      }
      const key = span.traceId + span.spanId;
      if (seenInRequest.has(key) || this.#live(this.#dedupe).has(span.traceId, span.spanId)) {
        duplicates++;
        continue;
      }
      seenInRequest.add(key);
      staged.push({ span, row: this.#checked('spans', spanRow(span, rowCtx)) });
    }
    for (const { span, row } of staged) {
      this.#live(this.#dedupe).seen(span.traceId, span.spanId);
      this.#writer.add('spans', row);
      this.#totals.spans++;
      this.#extend(ctx, span.start, Math.max(span.start, span.end));
    }
    if (staged.length > 0) this.#dirty = true;
    return { accepted: staged.length, dropped, duplicates };
  }

  /**
   * A row the codec could not encode would fail every later cut and lose the records accepted after it, so it is
   * rejected here with its request (nothing of the request is committed yet).
   */
  #checked(table: Table, row: Row): Row {
    try {
      checkRow(table, row);
    } catch (e) {
      if (!(e instanceof OtelHtmlError)) throw e;
      throw new OtelHtmlError('invalid-otlp', {
        path: `${table} record`,
        expected: 'a record the report format can store',
        actual: e.message,
      });
    }
    return row;
  }

  /**
   * Every accepted point is one `points` row, normalized now: the stream state advances here, and a cut that fails
   * restores its rows without touching it. All or nothing: parsing and the row check run on the whole request before
   * any stream is stepped (the check uses a row without deltas, which only the stepped normalizer can fill in).
   */
  #acceptPoints(points: readonly MetricPointRecord[], origin?: number): AddResult {
    const ctx = this.#context();
    const rowCtx = {
      epoch: ctx.epoch,
      resources: ctx.resources.get.bind(ctx.resources),
      scopes: ctx.scopes.get.bind(ctx.scopes),
    };
    let dropped = 0;
    const staged: {
      point: MetricPointRecord;
      seriesId: string;
      row: Row;
      step: (id: string) => ReturnType<ReturnType<StreamNormalizer['prepare']>>;
    }[] = [];
    for (const point of points) {
      const resource = ctx.resources.get(point.resource);
      const scope = ctx.scopes.get(point.scope);
      if (this.#drop.point.test({ point, resource, scope, epoch: ctx.epoch })) {
        dropped++;
        continue;
      }
      const seriesId = seriesIdOf(point, resource, scope);
      const prepared = this.#live(this.#normalizer).prepare(point);
      const step = (id: string) => prepared({ series: id, origin });
      const row = this.#checked('points', pointRow(point, { ...UNNORMALIZED, seriesId }, rowCtx));
      staged.push({ point, seriesId, row, step });
    }
    for (const { point, seriesId, row, step } of staged) {
      applyNormalization(row, pointNormalization(point, step(seriesId), seriesId));
      this.#writer.add('points', row);
      this.#totals.metrics++;
      this.#extend(ctx, Math.min(point.start ?? point.time, point.time), point.time);
    }
    if (staged.length > 0) this.#dirty = true;
    return { accepted: staged.length, dropped, duplicates: 0 };
  }

  #acceptLogs(rows: readonly LogRecordRecord[], source: string): AddResult {
    const ctx = this.#context();
    const rowCtx = {
      epoch: ctx.epoch,
      resources: ctx.resources.get.bind(ctx.resources),
      scopes: ctx.scopes.get.bind(ctx.scopes),
    };
    rows.forEach((l, i) => {
      try {
        severityKey(l.severityNumber);
      } catch {
        throw new OtelHtmlError('invalid-otlp', {
          path: `${source}: logRecords[${i}].severityNumber`,
          expected: 'an integer 0..24',
          actual: String(l.severityNumber),
        });
      }
    });
    let dropped = 0;
    const staged: { log: LogRecordRecord; row: Row }[] = [];
    for (const log of rows) {
      const target: LogTarget = {
        log,
        resource: ctx.resources.get(log.resource),
        scope: ctx.scopes.get(log.scope),
        epoch: ctx.epoch,
      };
      if (this.#drop.log.test(target)) {
        dropped++;
        continue;
      }
      staged.push({ log, row: this.#checked('logs', logRow(log, rowCtx)) });
    }
    for (const { log, row } of staged) {
      const t = logTime(log);
      this.#writer.add('logs', row);
      this.#totals.logs++;
      this.#extend(ctx, t, t);
    }
    if (staged.length > 0) this.#dirty = true;
    return { accepted: staged.length, dropped, duplicates: 0 };
  }

  /**
   * A checkpoint is due at `writer.flushIntervalMs` or when the held rows reach `writer.chunkTargetBytes`. It is
   * prepared under the serial queue (which takes the held rows) and written in the background, one at a time.
   */
  async #maybeCheckpoint(): Promise<void> {
    const { clock } = this.#deps;
    if (this.#inflight !== null) return;
    const now = clock.monotonicMs();
    if (now < this.#backoffUntilMs) return;
    const due =
      now - this.#lastFlushMs >= this.#config.writer.flushIntervalMs ||
      this.#writer.pendingBytes >= this.#config.writer.chunkTargetBytes;
    if (due) await this.#startBackgroundCheckpoint();
  }

  /**
   * During a partial input (a `convert` file read entry by entry) that replaces no report, rows are cut into
   * partition files at the size rule, so memory stays bounded by the target. No state or manifest is written until
   * the input completes: the next commit lists these partitions, and an abandoned input leaves them unlisted.
   */
  async #cutPartial(): Promise<void> {
    if (this.#writer.pendingBytes < this.#config.writer.chunkTargetBytes) return;
    // A background checkpoint numbers and lists its partition first, so the list stays in order.
    await this.#inflight;
    try {
      const entry = await this.#writer.cut(`flush:${this.#writer.nextPartition}`);
      if (entry !== null) {
        this.#pending.push(entry);
        this.#flushed.push(entry.n);
        this.#sinceCheckpoint = true;
      }
    } catch (e) {
      // The records are accepted already, so the request must not fail; the rows are held again for the next cut.
      this.#deps.logger.error('partition cut failed; will retry', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async #startBackgroundCheckpoint(): Promise<void> {
    const failed = (e: unknown): void => {
      // The records that triggered this are accepted already, so the request must not fail. The interval and the
      // size rule restart; the next flush surfaces a persistent fault.
      const now = this.#deps.clock.monotonicMs();
      this.#lastFlushMs = now;
      this.#backoffUntilMs = now + this.#config.writer.flushIntervalMs;
      this.#deps.logger.error('checkpoint failed; will retry at the next flush', {
        error: e instanceof Error ? e.message : String(e),
      });
      this.#sinceCheckpoint = true;
      this.#armIdle();
    };
    let prepared: Prepared | null;
    try {
      prepared = await this.#prepareCheckpoint(false);
    } catch (e) {
      failed(e);
      return;
    }
    if (prepared === null) {
      this.#lastFlushMs = this.#deps.clock.monotonicMs();
      return;
    }
    this.#inflight = this.#writeCheckpoint(prepared).then(
      () => {
        this.#inflight = null;
      },
      (e: unknown) => {
        this.#inflight = null;
        failed(e);
      },
    );
  }

  #armIdle(): void {
    this.#disarmIdle();
    if (!this.#sinceCheckpoint || this.#closed !== null || this.#aborted) return;
    this.#cancelIdle = this.#deps.timers.after(this.#config.writer.flushIntervalMs, () => {
      this.#cancelIdle = null;
      this.#serial(() => this.#idleCheckpoint()).catch((e: unknown) => {
        this.#deps.logger.error('checkpoint failed; will retry at the next flush', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    });
  }

  #disarmIdle(): void {
    this.#cancelIdle?.();
    this.#cancelIdle = null;
  }

  async #idleCheckpoint(): Promise<void> {
    if (this.#closed !== null || this.#aborted || !this.#sinceCheckpoint) return;
    if (this.#inflight !== null || this.#partial) {
      this.#armIdle();
      return;
    }
    await this.#startBackgroundCheckpoint();
  }

  /** Remove the replaced report's data, once, immediately before this session's first write. */
  async #wipeReplaced(): Promise<void> {
    if (!this.#replacing) return;
    await wipeReportData(this.#deps.fs, this.#out);
    this.#replacing = false;
  }

  /**
   * With the default base the report carries its own `assets/`. A shared base (a site that publishes the viewer
   * once for many reports) is the publisher's to upload, so no copy is written beside the report.
   */
  async #writeShell(): Promise<void> {
    const { fs, viewerAssets } = this.#deps;
    const { assetsBase } = this.#config.writer;
    const { format } = this.#config.writer;
    const sharedBase = assetsBase !== DEFAULT_ASSETS_BASE;
    if (!sharedBase) await writeViewerAssets(fs, this.#out, viewerAssets, format);
    // Files an earlier session left that this one does not load (engine files of another format or version; with a
    // shared base, the viewer files too) are dead weight, tens of MB.
    if (!(await pruneOwnAssets(fs, this.#out, { format, sharedBase }))) {
      this.#deps.logger.debug('assets/ links out of the report; left alone', { out: this.#out });
    }
    await fs.writeTextAtomic(
      at(this.#out, 'index.html'),
      renderIndexHtml(viewerAssets.entry(), this.#title, { assetsBase }),
    );
    await fs.writeTextAtomic(at(this.#out, '.nojekyll'), '');
    this.#shellWritten = true;
  }

  /**
   * A `local` report loads every partition into the page at once, so one past `localWarnBytes` is better served as a
   * `site` report. Called once close has committed the final manifest, so it counts what the report holds then (a
   * compaction's output, not the flush partitions it merged).
   */
  #warnIfLarge(): void {
    const { format, localWarnBytes } = this.#config.writer;
    if (format !== 'local' || this.#warnedLarge) return;
    let bytes = 0;
    for (const e of this.#committed) for (const f of Object.values(e.files)) bytes += f.bytes;
    this.#warnedLarge = warnIfLocalLarge(this.#deps.logger, bytes, localWarnBytes);
  }

  #live<T>(v: T | null): T {
    if (v === null) throw new Error('invariant violated: the session state was released');
    return v;
  }

  /**
   * Called at close, after the held rows are durable: keeps what the final state write needs as JSON text and drops
   * the live dedupe set, Drain, stream normalizer and interners, so compaction runs without them. The state written
   * is the same as without the release.
   */
  #release(): void {
    this.#frozen ??= {
      dedupe: JSON.stringify(this.#live(this.#dedupe).toJSON()),
      metricStreams: JSON.stringify(this.#live(this.#normalizer).toJSON()),
      drain: JSON.stringify(this.#live(this.#drain).toJSON()),
    };
    this.#closing = true;
    this.#dedupe = null;
    this.#normalizer = null;
    this.#drain = null;
    this.#ctx = null;
  }

  /** A copied partition's file written under number `n`, with its wrapper in a `local` report. */
  async #putFile(n: number, table: Table, bytes: Uint8Array): Promise<void> {
    const { fs } = this.#deps;
    await fs.writeBytes(at(this.#out, partitionFilePath(n, table)), bytes);
    if (this.#config.writer.format === 'local') {
      await writeWrapper(fs, at(this.#out, partitionWrapperPath(n, table)), partitionKey(n, table), bytes);
    }
  }

  /** The `widget_traces` of a copied partition's decoded spans, with the flush's guard and warnings; null when none is written. */
  #computedIndex(
    index: CompiledWidgetIndex,
    set: WidgetTraceSet,
    spansBytes: number,
  ): { bytes: Uint8Array; file: PartitionFile } | null {
    const wi = this.#widgetRowsOf(set, index).widgetIndex;
    if (wi === undefined) return null;
    const rowGroupRows = this.#encodeOptions().rowGroupRows;
    const bytes = encodeWidgetTraces(wi.rows, index, rowGroupRows);
    const empty = encodeWidgetTraces([], index, rowGroupRows).length;
    if (!wi.allowed(bytes.length, empty, spansBytes)) return null;
    return {
      bytes,
      file: {
        path: '',
        bytes: bytes.length,
        ...fileStatistics(
          'widget_traces',
          batchFromRows('widget_traces', wi.rows, index.columns),
          [],
          this.#config.writer.facetValueCap,
        ),
        widgetIndex: index.description,
      },
    };
  }

  /**
   * The base table whose rows a copied rollup `f` of `table` must be computed again from (its description lacks a
   * dimension this report lists), or null when it is copied as it is. `src` is the partition, whose base file must exist.
   */
  #staleRollupBase(table: Table, f: PartitionFile, src: PartitionEntry): 'spans' | 'logs' | null {
    if ((table !== 'span_rollups' && table !== 'log_rollups') || f.rollup === undefined) return null;
    const base = ROLLUP_OF[table];
    if (src.files[base] === undefined) return null;
    const wanted = rollupDimensions(base, this.#statisticsKeys[base]);
    const have = f.rollup.dimensions;
    // A widget-only key the rollup lacks is skipped only when the writer recorded that it weighed and refused it
    // (`refused`): weighing it again would decode the partition on every merge only to drop it again. A rollup
    // that merely lacks the key (an older writer, or a compaction that never weighed it) is computed again.
    const refused = new Set(f.rollup.refused);
    const widget = new Set(this.#widgetKeys[base]);
    const have0 = new Set(have);
    const need = wanted.filter((d) => have0.has(d) || !(widget.has(d) && refused.has(d)));
    return have.length === need.length && have.every((d, i) => d === need[i]) ? null : base;
  }

  /**
   * The rollup file of a copied partition computed again from its base rows, when the copy's rollup description lacks
   * the dimensions this report's statistics keys give; null when it is to be copied as it is; 'refused' when the guard
   * refuses the new rollup (the partition then has none).
   */
  async #recomputedRollup(
    table: Table,
    f: PartitionFile,
    src: PartitionEntry,
    baseBytes: ReadonlyMap<Table, Uint8Array>,
    path: string,
    decode: (base: 'spans' | 'logs') => Promise<ColumnBatch>,
  ): Promise<{ bytes: Uint8Array; file: PartitionFile } | 'refused' | null> {
    if (table !== 'span_rollups' && table !== 'log_rollups') return null;
    const base = this.#staleRollupBase(table, f, src);
    const bytes = base === null ? undefined : baseBytes.get(base);
    if (base === null || bytes === undefined) return null;
    const batch0 = await decode(base);
    const made = this.#rollupOf(base, batch0, bytes.length);
    if (made === null) return 'refused';
    for (const [i, row] of made.rows.entries()) checkRow(table, row, i);
    const batch = batchFromRows(table, made.rows);
    const out = encodeColumns(table, batch, this.#encodeOptions());
    return {
      bytes: out,
      file: {
        path,
        bytes: out.length,
        ...fileStatistics(table, batch, this.#statisticsKeys[table], this.#config.writer.facetValueCap),
        rollup: made.description,
      },
    };
  }

  /**
   * One partition of a merge input, copied under partition number `n`: each file's bytes as they are (never decoded; a rollup lacking a dimension this report lists is computed again, `#recomputedRollup`),
   * its wrapper written afterwards in a `local` report (the key names the new number, so a copied wrapper would be
   * wrong), and its statistics cut to this report's keys (a key the input did not keep is unknown). The entry is the
   * caller's to list; the folder is removed again if a file fails.
   */
  async #copyPartition(copy: PartitionCopy, src: PartitionEntry, n: number): Promise<PartitionEntry> {
    const { fs } = this.#deps;
    const files: Partial<Record<Table, PartitionFile>> = {};
    let made = false;
    const baseBytes = new Map<Table, Uint8Array>();
    const watch = watchWasmPanics();
    // A base table is decoded whole only for a rollup repair (and then once, shared with the statistics and the index
    // below); the memo is dropped as soon as the repair is done. Otherwise `spans` is streamed in one pass.
    const decoded = new Map<'spans' | 'logs', Promise<ColumnBatch>>();
    const decode = (base: 'spans' | 'logs'): Promise<ColumnBatch> => {
      let d = decoded.get(base);
      if (d === undefined) {
        const bytes = baseBytes.get(base);
        const path = src.files[base]?.path ?? '';
        d =
          bytes === undefined
            ? Promise.reject(new Error(`no ${base} bytes`))
            : decodeBatch(base, bytes, path, watch.guard);
        decoded.set(base, d);
      }
      return d;
    };
    const index = this.#widgetIndex;
    // The index is computed from the spans unless a copied `widget_traces` already covers this report's.
    const indexSet =
      index !== null &&
      src.files.spans !== undefined &&
      !coversIndex(src.files.widget_traces?.widgetIndex, index)
        ? new WidgetTraceSet(index)
        : null;
    const spansRepair =
      src.files.span_rollups !== undefined &&
      this.#staleRollupBase('span_rollups', src.files.span_rollups, src) === 'spans';
    try {
      for (const table of TABLES) {
        const f = src.files[table];
        if (f === undefined) continue;
        // A `widget_traces` is copied only when this report's ids and variables are within its own; else it is computed below.
        if (table === 'widget_traces' && (index === null || !coversIndex(f.widgetIndex, index))) continue;
        const from = at(copy.dir, f.path);
        let bytes: Uint8Array;
        try {
          bytes = await fs.readBytes(from);
        } catch (e) {
          throw new OtelHtmlError('invalid-report', {
            message: `${from}: cannot read partition file ${f.path} listed in the manifest (${e instanceof Error ? e.message : String(e)})`,
          });
        }
        if (!made) {
          await fs.mkdirp(at(this.#out, partitionDir(n)));
          made = true;
        }
        const path = partitionFilePath(n, table);
        if (table === 'spans' || table === 'logs') baseBytes.set(table, bytes);
        // A rollup that lacks a dimension this report lists is computed again from the partition's rows (a rollup with this
        // report's description is copied as it is, like a partition without one).
        const own = await this.#recomputedRollup(table, f, src, baseBytes, path, decode);
        if (table === 'span_rollups') decoded.delete('spans');
        if (table === 'log_rollups') decoded.delete('logs');
        if (own === 'refused') continue;
        const out = own === null ? { bytes, file: f } : own;
        await this.#putFile(n, table, out.bytes);
        if (own !== null) {
          files[table] = { ...own.file, path };
          continue;
        }
        if (table === 'widget_traces') {
          files[table] = { ...f, path };
          continue;
        }
        // The input may not have recorded a key this report lists (another config wrote it): compute it from the bytes.
        // For `spans` one pass over the file also feeds the widget index (no more than a chunk is held at a time),
        // or the whole decode a rollup repair needs.
        let chunks: (() => AsyncIterable<ColumnBatch>) | undefined;
        if (table === 'spans' && (indexSet !== null || spansRepair)) {
          const set = indexSet;
          chunks = () =>
            tapped(
              spansRepair ? wholeOf(decode('spans')) : streamBatches('spans', bytes, f.path, watch.guard),
              (chunk) => set?.add(chunk),
            );
        }
        const done = await completeStatistics(
          table,
          f,
          statisticsKeysOf(this.#statisticsKeys, table),
          this.#config.writer.facetValueCap,
          () => Promise.resolve(bytes),
          watch.guard,
          chunks,
        );
        const values: Record<string, string[] | null> = Object.create(null) as Record<
          string,
          string[] | null
        >;
        for (const k of statisticsKeysOf(this.#statisticsKeys, table)) values[k] = done.values[k] ?? null;
        files[table] = {
          path,
          bytes: f.bytes,
          rows: f.rows,
          timeMin: f.timeMin,
          timeMax: f.timeMax,
          values,
          ...(f.timeEndMax === undefined ? {} : { timeEndMax: f.timeEndMax }),
          ...(f.rollup === undefined ? {} : { rollup: f.rollup }),
          ...(f.serviceShare === undefined ? {} : { serviceShare: f.serviceShare }),
        };
      }
      const spansFile = files.spans;
      if (
        index !== null &&
        indexSet !== null &&
        spansFile !== undefined &&
        files.widget_traces === undefined
      ) {
        const own = this.#computedIndex(index, indexSet, spansFile.bytes);
        if (own !== null) {
          const path = partitionFilePath(n, 'widget_traces');
          await this.#putFile(n, 'widget_traces', own.bytes);
          files.widget_traces = { ...own.file, path };
        }
      }
    } catch (e) {
      if (made) await fs.removeDir(at(this.#out, partitionDir(n))).catch(() => undefined);
      throw e;
    } finally {
      watch.stop();
    }
    return { n, source: `merge:${copy.origin}#${src.n}`, files };
  }

  /**
   * At close, after the held rows and any copies are committed: compacts the flush partitions, and with
   * `writer.compactOnMerge` each merge input's copies (compacted per input, so a lineage is never summed with
   * another's, and in each input per time group, so no output spans more than 24 h; see `#compactGroup`).
   */
  async #compact(): Promise<void> {
    const flushed = new Set(this.#flushed);
    await this.#compactGroup(
      this.#committed.filter((e) => flushed.has(e.n) && e.source.startsWith('flush:')),
    );
    if (!this.#config.writer.compactOnMerge) return;
    for (const group of this.#copied.values()) {
      const taken = new Set(group);
      // Each input is its own Drain lineage: cluster ids collide across inputs, so patterns match by template too.
      await this.#compactGroup(
        this.#committed.filter((e) => taken.has(e.n)),
        'cluster-template',
      );
    }
  }

  /**
   * Compacts `picks` group by group (`timeGroups` of their time ranges: no output spans more than 24 h unless one
   * input does), each as `#compactOne` says.
   */
  async #compactGroup(
    picks: readonly PartitionEntry[],
    patternKey: 'cluster' | 'cluster-template' = 'cluster',
  ): Promise<void> {
    const ranged = picks.map((entry) => ({ entry, ...timeRangeOf(entry) }));
    const groups = timeGroups(ranged);
    // A cluster keeps the template of the highest partition across all the groups, as one compaction would write it.
    const latest =
      groups.length > 1 && patternKey === 'cluster'
        ? await latestTemplates(
            this.#deps.fs,
            this.#out,
            [...picks].sort((a, b) => a.n - b.n),
          ).catch((error: unknown) => {
            // each group then keeps its own latest template: the Patterns page may show a pattern once per template
            this.#deps.logger.warn(
              'could not read the patterns to share templates across compaction groups',
              {
                error: error instanceof Error ? error.message : String(error),
              },
            );
            return undefined;
          })
        : undefined;
    for (const group of groups) {
      const members = group.map((g) => g.entry).sort((a, b) => a.n - b.n);
      // a lone partition is rewritten only to bring its patterns to the latest templates
      const rewrite = members.length === 1 && members.some((m) => latest?.stale.has(m.n));
      await this.#compactOne(members, patternKey, latest?.templates, rewrite);
    }
  }

  /**
   * Compacts `picks` into one partition when there are two or more, as `compactPartitions` says. Writes only the new
   * partition's folder; the next checkpoint commits it, in this order: the state (numbering past it, no flush
   * partitions left), then the manifest (listing it in place of the picks). The folders it replaces are removed by
   * `#pruneCommitted` after that commit. Compaction is an optimisation, so a failure keeps the picks and is logged.
   */
  async #compactOne(
    picks: readonly PartitionEntry[],
    patternKey: 'cluster' | 'cluster-template',
    templates?: ReadonlyMap<string, string>,
    rewriteOne = false,
  ): Promise<void> {
    const first = picks[0];
    const last = picks.at(-1);
    if (first === undefined || last === undefined || (picks.length < 2 && !rewriteOne)) return;
    const span = this.#deps.tracer.startSpan('otel-html.compact', { partitions: picks.length });
    try {
      const n = this.#writer.nextPartition;
      const entry = await compactPartitions(this.#deps.fs, this.#out, picks, {
        nextPartition: n,
        rowGroupRows: this.#deps.rowGroupRows ?? this.#config.writer.rowGroupRows,
        statisticsKeys: this.#statisticsKeys,
        widgetKeys: this.#widgetKeys,
        facetValueCap: this.#config.writer.facetValueCap,
        format: this.#config.writer.format,
        // the group's first and last partition numbers, not every number between (a group is made by time)
        source: `compact:${first.n}..${last.n}`,
        patternKey,
        ...(templates === undefined ? {} : { templates }),
        ...(this.#widgetIndex === null ? {} : { widgetIndex: this.#widgetIndex }),
        warn: (message, attrs) => this.#warnOnce(message, attrs),
      });
      this.#writer.skipTo(n + 1);
      const replaced = new Set(picks.map((e) => e.n));
      // Ascending n, as the manifest requires: the compacted partition is the newest number.
      this.#committed = [...this.#committed.filter((e) => !replaced.has(e.n)), entry].sort(
        (a, b) => a.n - b.n,
      );
      this.#flushed = this.#flushed.filter((p) => !replaced.has(p));
      this.#dirty = true;
    } catch (e) {
      span.recordError(e);
      this.#deps.logger.error('compaction failed; keeping the partitions it would replace', {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      span.end();
    }
  }

  /**
   * After the final manifest commit: removes what it does not list (the folders a compaction replaced, a half-written
   * one, leftovers of a failed earlier attempt), so a report that is never reopened carries no dead data. The report
   * is committed already, so a failure is logged.
   */
  async #pruneCommitted(): Promise<void> {
    try {
      await prunePartitions(this.#deps.fs, this.#out, this.#committed);
    } catch (error) {
      this.#deps.logger.warn(
        'could not remove unlisted partition data; it is pruned when the report is opened',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /** A foreground flush: waits for a background write, then prepares and writes. */
  async #checkpoint(complete: boolean): Promise<void> {
    await this.#inflight;
    const prepared = await this.#prepareCheckpoint(complete);
    if (prepared !== null) await this.#writeCheckpoint(prepared);
  }

  /**
   * The first half, under the serial queue: starts the cut (which takes the held rows at once, so the adds that
   * follow land in the next partition) and freezes everything the second half writes. `null` when nothing is held
   * and nothing changed since the last checkpoint.
   */
  async #prepareCheckpoint(complete: boolean): Promise<Prepared | null> {
    const held = this.#writer.pendingRows > 0 || this.#pending.length > 0;
    const writeState = this.#dirty || held || !this.#everCommitted;
    if (!writeState && !complete) return null;
    const span = this.#deps.tracer.startSpan('otel-html.flush', { complete });
    try {
      await this.#wipeReplaced();
      const prepared: Prepared = {
        complete,
        span,
        cut: Promise.resolve(null),
        slot: this.#slot === 0 ? 1 : 0,
        state: writeState
          ? {
              epoch: this.#streamAnchor?.toString() ?? null,
              dedupe:
                this.#frozen === null
                  ? this.#live(this.#dedupe).toJSON()
                  : (JSON.parse(this.#frozen.dedupe) as string[]),
              // With the cut below, in this synchronous segment: points accepted later are not in this state.
              metricStreams:
                this.#frozen === null
                  ? this.#live(this.#normalizer).toJSON()
                  : (JSON.parse(this.#frozen.metricStreams) as unknown),
            }
          : null,
        updatedAt: iso(this.#deps.clock),
        epoch: this.#streamAnchor?.toString() ?? '0',
        totals: { ...this.#totals },
        range: this.#range === null ? null : { ...this.#range },
      };
      // Last: nothing after it can throw, so a failed prepare never leaves rows taken.
      prepared.cut = this.#writer.cut(`flush:${this.#writer.nextPartition}`);
      prepared.cut.catch(() => undefined); // the write awaits it; this only marks it handled meanwhile
      this.#dirty = false;
      this.#sinceCheckpoint = false;
      this.#disarmIdle();
      return prepared;
    } catch (e) {
      span.recordError(e);
      span.end();
      throw e;
    }
  }

  /**
   * The second half: the cut finishes, then the state slot, then (atomically) the manifest. Anything written before
   * the manifest is invisible to readers, so an interrupted checkpoint leaves the previous manifest valid. A cut
   * partition whose state or manifest write failed stays pending and is listed by the next checkpoint.
   */
  async #writeCheckpoint(p: Prepared): Promise<void> {
    const { fs, clock } = this.#deps;
    try {
      const entry = await p.cut;
      if (entry !== null) {
        this.#pending.push(entry);
        this.#flushed.push(entry.n);
      }
      if (!this.#shellWritten && !p.complete) await this.#writeShell();
      if (p.state !== null) {
        await writeStateSlotV2(
          fs,
          this.#out,
          p.slot,
          buildState(
            {
              version: this.#deps.version,
              nextPartition: this.#writer.nextPartition,
              flushed: this.#flushed,
              drain:
                this.#frozen === null
                  ? this.#live(this.#drain).toJSON()
                  : (JSON.parse(this.#frozen.drain) as ReturnType<Drain['toJSON']>),
              statisticsKeys: this.#statisticsKeys,
            },
            p.state,
            this.#checkpointSeq + 1,
          ),
        );
      }
      await writeManifest(
        fs,
        this.#out,
        buildManifest(
          {
            version: this.#deps.version,
            title: this.#title,
            createdAt: this.#createdAt,
            partitions: [...this.#committed, ...this.#pending],
            statisticsKeys: this.#statisticsKeys,
            config: this.#config,
          },
          p,
        ),
      );
      if (p.state !== null) {
        this.#slot = p.slot;
        this.#checkpointSeq++;
      }
      this.#committed.push(...this.#pending);
      this.#pending = [];
      this.#everCommitted = true;
      this.#lastFlushMs = clock.monotonicMs();
      try {
        p.span.setAttributes({
          partitions: entry === null ? 0 : 1,
          records: p.totals.spans + p.totals.logs + p.totals.metrics,
        });
      } catch (error) {
        this.#deps.logger.warn('flush telemetry failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (e) {
      // Whatever the prepare cleared is waiting again.
      this.#dirty = true;
      p.span.recordError(e);
      throw e;
    } finally {
      try {
        p.span.end();
      } catch (error) {
        this.#deps.logger.warn('flush telemetry failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
