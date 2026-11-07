import type { ResolvedConfig } from '../config/schema.js';
import type { PartitionEntry } from '../format/manifest.js';
import { checkRow } from '../format/parquet/codec.js';
import { applyNormalization, logRow, pointRow, type Row, spanRow } from '../format/parquet/rows.js';
import { TABLES, type Table } from '../format/parquet/schema.js';
import { statisticsKeysFor } from '../format/parquet/stats.js';
import { DEFAULT_ASSETS_BASE, LOCK_PATH, type Signal, STATE_DIR, type StateSlot } from '../format/paths.js';
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
import {
  at,
  loadPartitionCheckpoint,
  wipeReportData,
  writeManifest,
  writeStateSlotV2,
} from './checkpoint.js';
import { compactPartitions } from './compaction.js';
import { DedupeSet } from './dedupe.js';
import { renderIndexHtml } from './html.js';
import { inheritDashboards } from './inherit-config.js';
import { acquireLock, type LockHandle } from './lock.js';
import { DEFAULT_TITLE, type Drops, type FolderState, iso } from './open-common.js';
import {
  buildManifest,
  buildState,
  type Prepared,
  pointNormalization,
  UNNORMALIZED,
} from './partition-checkpoint.js';
import { PartitionWriter } from './partition-writer.js';
import { patternRows } from './pattern-rows.js';
import { prunePartitions } from './prune.js';
import { seriesIdOf } from './series-id.js';
import type {
  AddOptions,
  AddResult,
  RecordBatch,
  ReportSummary,
  SessionOptions,
  WriterDeps,
  WriterSession,
} from './session.js';
import { traceRows } from './trace-summaries.js';
import { wantsAsset, writeViewerAssets } from './viewer-assets.js';

interface Restored {
  lock: LockHandle;
  epoch: UnixNanos | null;
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

/** The format-4 half of `openSession`: the folder checks and the drop conditions have passed already. */
export async function openPartitionSession(
  deps: WriterDeps,
  options: SessionOptions,
  drop: Drops,
  folder: FolderState,
): Promise<WriterSession> {
  const { out } = options;
  let { config } = options;
  const { fs } = deps;
  await fs.mkdirp(at(out, STATE_DIR));
  const lock = await acquireLock(deps, at(out, LOCK_PATH));
  try {
    let restored: Restored;
    if (!folder.appending) {
      restored = {
        lock,
        epoch: null,
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
      const cp = await loadPartitionCheckpoint(fs, out, deps.version);
      config = inheritDashboards(config, cp.manifest.config);
      // The partitions already written have (local) or lack (site) their base64 scripts, and the engine files differ.
      // The report's own assets/ (about 46 MB of engine files) would be left behind, and index.html rewritten past it.
      if (
        cp.manifest.engine.assetsBase === DEFAULT_ASSETS_BASE &&
        config.writer.assetsBase !== DEFAULT_ASSETS_BASE
      ) {
        throw new OtelHtmlError('usage', {
          message: `cannot append with writer.assetsBase ${config.writer.assetsBase} to a report that carries its own assets/`,
          hint: `append with --assets-base ${DEFAULT_ASSETS_BASE}, or start the report over with --replace`,
        });
      }
      if (cp.manifest.engine.format !== config.writer.format) {
        throw new OtelHtmlError('usage', {
          message: `cannot append as writer.format ${config.writer.format} to a ${cp.manifest.engine.format} report`,
          hint: `append with --format ${cp.manifest.engine.format}, or start the report over with --replace`,
        });
      }
      // Before any write: what an interrupted session left unlisted must not meet this session's cuts.
      const pruned = await prunePartitions(fs, out, cp.manifest.partitions);
      if (pruned > 0)
        deps.logger.info('removed unlisted partition data left by an interrupted session', { pruned });
      restored = {
        lock,
        epoch:
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
  readonly #statisticsKeys: Record<Table, string[]>;
  readonly #createdAt: string;
  readonly #title: string;
  #epoch: UnixNanos | null;
  #ctx: NormalizeContext | null = null;
  #committed: PartitionEntry[];
  /** Cut partitions the committed manifest does not list yet (a checkpoint failed after the cut). */
  #pending: PartitionEntry[] = [];
  #flushed: number[];
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
  #aborted = false;
  /** Set when close released the live state: only `close` (again) and `abort` remain. */
  #closing = false;
  #replacing: boolean;
  #partial = false;
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
    this.#statisticsKeys = Object.fromEntries(TABLES.map((t) => [t, statisticsKeysFor(t, config)])) as Record<
      Table,
      string[]
    >;
    this.#writer = new PartitionWriter(deps.fs, {
      out,
      rowGroupRows: config.writer.rowGroupRows,
      statisticsKeys: this.#statisticsKeys,
      facetValueCap: config.writer.facetValueCap,
      nextPartition: r.nextPartition,
      format: config.writer.format,
      derive: (taken) => {
        const p = patternRows(this.#live(this.#drain), taken.logs, this.#epoch ?? 0n);
        return {
          rows: { traces: traceRows(taken.spans, taken.logs), patterns: p.rows },
          commit: () => {
            this.#drain = p.drain;
          },
        };
      },
    });
    this.#createdAt = r.createdAt;
    this.#title = r.title;
    this.#epoch = r.epoch;
    if (r.epoch !== null) this.#ctx = createNormalizeContext(r.epoch);
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

  // -- public API ------------------------------------------------------------------------------

  add(input: OtlpRequest, source: string, options?: AddOptions): Promise<AddResult> {
    return this.#serial(async () => {
      this.#assertOpen();
      this.#partial = options?.partial === true;
      const ctx = this.#ensureEpoch(earliestTimestamp(input));
      const first = input.first ?? 0;
      let result: AddResult;
      if (input.signal === 'metrics') {
        const points = [...metricPointsOf(input, ctx, source)];
        this.#settleEpoch(points.length);
        result = this.#acceptPoints(points);
      } else if (input.signal === 'traces') {
        const rows = normalizeTraces(input.request, ctx, source, first);
        this.#settleEpoch(rows.length);
        result = this.#acceptSpans(rows);
      } else {
        const rows = normalizeLogs(input.request, ctx, source, first);
        this.#settleEpoch(rows.length);
        result = this.#acceptLogs(rows, source);
      }
      if (result.accepted > 0) this.#sinceCheckpoint = true;
      if (!this.#partial) await this.#maybeCheckpoint();
      else if (!this.#replacing) await this.#cutPartial();
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

  addRecords(_batch: RecordBatch): Promise<AddResult> {
    return this.#serial(() => {
      this.#assertOpen();
      return Promise.reject(
        new OtelHtmlError('usage', {
          message: 'merging into a format-4 report is not supported yet',
          hint: 'use --format chunks until format-4 merge arrives',
        }),
      );
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
      if (!this.#closing) this.#assertOpen();
      this.#disarmIdle();
      await this.#checkpoint(false);
      if (!this.#shellWritten) await this.#writeShell();
      this.#release();
      await this.#compact();
      await this.#checkpoint(true);
      await this.#pruneCommitted();
      this.#closed = this.#summary();
      await this.#lock.release();
      return this.#closed;
    });
  }

  abort(): Promise<void> {
    return this.#serial(async () => {
      if (this.#closed !== null || this.#aborted) return;
      this.#aborted = true;
      this.#disarmIdle();
      await this.#inflight;
      await this.#lock.release();
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

  /** The epoch rule of the chunk session: the earliest timestamp of the first data that has one, never changed. */
  #ensureEpoch(candidate: UnixNanos | null): NormalizeContext {
    if (this.#epoch !== null && this.#ctx !== null) return this.#ctx;
    if (candidate === null) {
      this.#ctx ??= createNormalizeContext(this.#deps.clock.nowUnixNano());
      return this.#ctx;
    }
    const fresh = createNormalizeContext(candidate);
    this.#epoch = candidate;
    this.#ctx =
      this.#ctx === null ? fresh : { ...fresh, resources: this.#ctx.resources, scopes: this.#ctx.scopes };
    this.#dirty = true;
    return this.#ctx;
  }

  #settleEpoch(records: number): void {
    if (records === 0 || this.#epoch !== null || this.#ctx === null) return;
    this.#epoch = this.#ctx.epoch;
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
   * All or nothing, like the chunk session: everything that can fail (drop conditions, row conversion) runs on
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
  #acceptPoints(points: readonly MetricPointRecord[]): AddResult {
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
      step: ReturnType<StreamNormalizer['prepare']>;
    }[] = [];
    for (const point of points) {
      const resource = ctx.resources.get(point.resource);
      const scope = ctx.scopes.get(point.scope);
      if (this.#drop.point.test({ point, resource, scope, epoch: ctx.epoch })) {
        dropped++;
        continue;
      }
      const seriesId = seriesIdOf(point, resource, scope);
      const step = this.#live(this.#normalizer).prepare(point);
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
    if (assetsBase === DEFAULT_ASSETS_BASE) {
      const { format } = this.#config.writer;
      await writeViewerAssets(fs, this.#out, viewerAssets, format);
      // Engine files of another format or ENGINE_VERSION, left by an earlier session, are dead weight (tens of MB).
      const assets = at(this.#out, 'assets');
      for (const name of await fs.list(assets)) {
        if (!wantsAsset(`assets/${name}`, format)) await fs.remove(at(assets, name));
      }
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
   * `site` report. Warns once. Counts the listed partitions, so a compaction's output replaces the flush partitions it merged.
   */
  #warnIfLarge(): void {
    const { format, localWarnBytes } = this.#config.writer;
    if (format !== 'local' || this.#warnedLarge) return;
    let bytes = 0;
    for (const e of this.#committed) for (const f of Object.values(e.files)) bytes += f.bytes;
    if (bytes <= localWarnBytes) return;
    this.#warnedLarge = true;
    this.#deps.logger.warn(
      `this local report's partitions total ${bytes} bytes of Parquet (their base64 scripts add about a third on top); it loads them all when opened. Use --format site and serve the report over http for large reports`,
      { bytes, localWarnBytes },
    );
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

  /**
   * Compacts this session's flush partitions into one when there are two or more (a copy made by merge is never one
   * of them), as `compactPartitions` says. Writes only the new partition's folder; the next checkpoint commits it, in
   * this order: the state (numbering past it, no flush partitions left), then the manifest (listing it in place of the
   * flush partitions). The folders it replaces are removed by `#pruneCommitted` after that commit.
   * Compaction is an optimisation, so a failure keeps the flush partitions and is logged.
   */
  async #compact(): Promise<void> {
    const flushed = new Set(this.#flushed);
    const picks = this.#committed.filter((e) => flushed.has(e.n) && e.source.startsWith('flush:'));
    const first = picks[0];
    const last = picks.at(-1);
    if (first === undefined || last === undefined || picks.length < 2) return;
    const span = this.#deps.tracer.startSpan('otel-html.compact', { partitions: picks.length });
    try {
      const n = this.#writer.nextPartition;
      const entry = await compactPartitions(this.#deps.fs, this.#out, picks, {
        nextPartition: n,
        rowGroupRows: this.#config.writer.rowGroupRows,
        statisticsKeys: this.#statisticsKeys,
        facetValueCap: this.#config.writer.facetValueCap,
        format: this.#config.writer.format,
        source: `compact:${first.n}..${last.n}`,
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
      this.#deps.logger.error('compaction failed; keeping the flush partitions', {
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
              epoch: this.#epoch === null ? null : this.#epoch.toString(),
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
        epoch: this.#epoch === null ? '0' : this.#epoch.toString(),
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
      this.#warnIfLarge();
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
