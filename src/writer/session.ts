import type { ResolvedConfig } from '../config/schema.js';
import { wrapDataFile } from '../format/data-file.js';
import type { Manifest, ManifestChunk } from '../format/manifest.js';
import {
  LOCK_PATH,
  MANIFEST_PATH,
  rollupKey,
  rollupPath,
  type Signal,
  STATE_DIR,
  type StateSlot,
  traceShardKey,
  traceShardPath,
} from '../format/paths.js';
import type { SessionState } from '../format/state.js';
import { OtelHtmlError } from '../model/errors.js';
import { parseUnixNanos, type UnixNanos } from '../model/ids.js';
import {
  createNormalizeContext,
  earliestTimestamp,
  type NormalizeContext,
  normalizeLogs,
  normalizeMetrics,
  normalizeTraces,
} from '../model/normalize.js';
import type { OtlpRequest } from '../model/otlp-json.js';
import type {
  LogRecordRecord,
  MetricPointRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
  SpanRecord,
} from '../model/records.js';
import type { CompiledCondition } from '../ottl/compile.js';
import { compileAny } from '../ottl/compile.js';
import type { SpanTarget } from '../ottl/contexts.js';
import {
  createRollups,
  deserializeRollups,
  type ReportRollups,
  serializeRollups,
} from '../rollups/report-rollups.js';
import { severityKey } from '../rollups/signal-counts.js';
import {
  at,
  isReportFolder,
  loadCheckpoint,
  wipeReportData,
  writeManifest,
  writeStateSlot,
} from './checkpoint.js';
import { type BuiltChunk, ChunkBuffer, LOG_SIGNAL, logTime, METRIC_SIGNAL, SPAN_SIGNAL } from './chunker.js';
import { DedupeSet } from './dedupe.js';
import { renderIndexHtml } from './html.js';
import { acquireLock, type LockHandle } from './lock.js';
import type { Clock, FileSystem, Logger, ProcessInfo, Tracer } from './ports.js';
import { type Refs, rebaseLog, rebasePoint, rebaseSpan } from './rebase.js';
import { TraceIndex } from './trace-index.js';
import { type ViewerAssets, writeViewerAssets } from './viewer-assets.js';

export interface WriterDeps {
  fs: FileSystem;
  clock: Clock;
  logger: Logger;
  tracer: Tracer;
  process: ProcessInfo;
  viewerAssets: ViewerAssets;
  /** The otel-html version recorded in the report; append requires the same one. */
  version: string;
}

export interface SessionOptions {
  out: string;
  config: ResolvedConfig;
  mode: 'create' | 'append';
}

export interface AddResult {
  accepted: number;
  dropped: number;
  duplicates: number;
}

/** Normalized rows with their own resource/scope tables and epoch, as read from another report. */
export type RecordBatch =
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
    };

export interface ReportSummary {
  out: string;
  totals: Record<Signal, number>;
  chunks: number;
  bytes: number;
}

export interface WriterSession {
  add(input: OtlpRequest, source: string): Promise<AddResult>;
  addRecords(batch: RecordBatch): Promise<AddResult>;
  flush(): Promise<void>;
  close(): Promise<ReportSummary>;
}

/** Encoded chunks allowed to queue behind failing writes before `add` itself fails. */
const MAX_UNWRITTEN = 8;
const ROLLUP_NAMES = ['spans', 'logs', 'metrics'] as const;
const DEFAULT_TITLE = 'otel-html report';

interface Restored {
  lock: LockHandle;
  epoch: UnixNanos | null;
  rollups: ReportRollups;
  dedupe: DedupeSet;
  traceIndex: TraceIndex;
  nextChunk: Record<Signal, number>;
  committed: ManifestChunk[];
  totals: Record<Signal, number>;
  range: { start: number; end: number } | null;
  decodedBytes: number;
  createdAt: string;
  title: string;
  slot: StateSlot;
  /** Output files on disk may be ahead of the committed manifest (resumed after a crash). */
  resumed: boolean;
}

function iso(clock: Clock): string {
  return new Date(Number(clock.nowUnixNano() / 1_000_000n)).toISOString();
}

export async function openSession(deps: WriterDeps, options: SessionOptions): Promise<WriterSession> {
  const { config } = options;
  const out = options.out.replace(/\/+$/, '') || options.out;
  // Bad OTTL must fail before anything is written (or locked).
  const drop = {
    span: compileAny(config.writer.drop.traces.span, 'span'),
    log: compileAny(config.writer.drop.logs.log_record, 'log_record'),
    point: compileAny(config.writer.drop.metrics.datapoint, 'datapoint'),
  };
  const rollupOpts = { facetValueCap: config.writer.facetValueCap, facetKeyCap: config.writer.facetKeyCap };
  const { fs } = deps;

  let preexisting = false;
  if (options.mode === 'create') {
    if (await fs.exists(out)) {
      const names = await fs.list(out);
      preexisting = names.length > 0;
      if (preexisting && !(await isReportFolder(fs, out))) {
        throw new OtelHtmlError('usage', {
          message: `refusing to write into ${out}: the folder is not empty and is not an otel-html report`,
          hint: 'choose an empty or new folder, or an existing report folder to replace it',
        });
      }
    }
  }
  if (options.mode === 'append' && !(await fs.exists(at(out, MANIFEST_PATH)))) {
    // Checked before creating any directory or taking the lock, so a wrong folder is left untouched.
    throw new OtelHtmlError('usage', {
      message: `cannot append: no report found at ${out} (missing ${MANIFEST_PATH})`,
      hint: 'use mode create to start a new report',
    });
  }
  await fs.mkdirp(at(out, STATE_DIR));
  const lock = await acquireLock(deps, at(out, LOCK_PATH));
  try {
    let restored: Restored;
    if (options.mode === 'create') {
      if (preexisting) await wipeReportData(fs, out);
      restored = {
        lock,
        epoch: null,
        rollups: createRollups(rollupOpts),
        dedupe: new DedupeSet(config.writer.dedupeCapacity),
        traceIndex: new TraceIndex(),
        nextChunk: { spans: 0, logs: 0, metrics: 0 },
        committed: [],
        totals: { spans: 0, logs: 0, metrics: 0 },
        range: null,
        decodedBytes: 0,
        createdAt: iso(deps.clock),
        title: config.title ?? DEFAULT_TITLE,
        slot: 1, // the first checkpoint goes to slot 0
        resumed: false,
      };
    } else {
      const cp = await loadCheckpoint(fs, out, deps.version);
      restored = {
        lock,
        epoch:
          cp.state.epochUnixNano === null
            ? null
            : parseUnixNanos(cp.state.epochUnixNano, 'state.epochUnixNano'),
        rollups: deserializeRollups(cp.state.rollups, rollupOpts),
        dedupe: DedupeSet.from(cp.state.dedupe, config.writer.dedupeCapacity),
        traceIndex: TraceIndex.load(cp.state.traceIndex),
        nextChunk: { ...cp.state.nextChunk },
        committed: [...cp.manifest.chunks],
        totals: { ...cp.manifest.totals },
        range: cp.manifest.range,
        decodedBytes: cp.manifest.decodedBytes,
        createdAt: cp.manifest.createdAt,
        title: config.title ?? cp.manifest.title,
        slot: cp.slot,
        resumed: true,
      };
    }
    for (const d of ['chunks/spans', 'chunks/logs', 'chunks/metrics', 'traces', 'rollups']) {
      await fs.mkdirp(at(out, `data/${d}`));
    }
    return new Session(deps, out, config, drop, restored);
  } catch (e) {
    await lock.release();
    throw e;
  }
}

interface Drops {
  span: CompiledCondition<'span'>;
  log: CompiledCondition<'log_record'>;
  point: CompiledCondition<'datapoint'>;
}

class Session implements WriterSession {
  readonly #deps: WriterDeps;
  readonly #out: string;
  readonly #config: ResolvedConfig;
  readonly #drop: Drops;
  readonly #lock: LockHandle;
  readonly #rollups: ReportRollups;
  readonly #dedupe: DedupeSet;
  readonly #traceIndex: TraceIndex;
  readonly #spans: ChunkBuffer<SpanRecord>;
  readonly #logs: ChunkBuffer<LogRecordRecord>;
  readonly #metrics: ChunkBuffer<MetricPointRecord>;
  readonly #createdAt: string;
  readonly #title: string;
  #epoch: UnixNanos | null;
  #ctx: NormalizeContext | null = null;
  #committed: ManifestChunk[];
  #pending: ManifestChunk[] = [];
  #unwritten: BuiltChunk[] = [];
  #totals: Record<Signal, number>;
  #range: { start: number; end: number } | null;
  #decodedBytes: number;
  #slot: StateSlot;
  #dirty: boolean;
  #everCommitted: boolean;
  #shellWritten = false;
  #lastFlushMs: number;
  #closed: ReportSummary | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(deps: WriterDeps, out: string, config: ResolvedConfig, drop: Drops, r: Restored) {
    this.#deps = deps;
    this.#out = out;
    this.#config = config;
    this.#drop = drop;
    this.#lock = r.lock;
    this.#rollups = r.rollups;
    this.#dedupe = r.dedupe;
    this.#traceIndex = r.traceIndex;
    this.#spans = new ChunkBuffer(SPAN_SIGNAL, r.nextChunk.spans);
    this.#logs = new ChunkBuffer(LOG_SIGNAL, r.nextChunk.logs);
    this.#metrics = new ChunkBuffer(METRIC_SIGNAL, r.nextChunk.metrics);
    this.#createdAt = r.createdAt;
    this.#title = r.title;
    this.#epoch = r.epoch;
    if (r.epoch !== null) this.#ctx = createNormalizeContext(r.epoch);
    this.#committed = r.committed;
    this.#totals = r.totals;
    this.#range = r.range;
    this.#decodedBytes = r.decodedBytes;
    this.#slot = r.slot;
    this.#dirty = r.resumed;
    this.#everCommitted = r.resumed;
    this.#lastFlushMs = deps.clock.monotonicMs();
  }

  // -- public API ------------------------------------------------------------------------------

  add(input: OtlpRequest, source: string): Promise<AddResult> {
    return this.#serial(async () => {
      this.#assertOpen();
      const ctx = this.#ensureEpoch(earliestTimestamp(input));
      let result: AddResult;
      switch (input.signal) {
        case 'traces':
          result = await this.#acceptSpans(normalizeTraces(input.request, ctx, source));
          break;
        case 'logs':
          result = await this.#acceptLogs(normalizeLogs(input.request, ctx, source), source);
          break;
        case 'metrics':
          result = await this.#acceptPoints(normalizeMetrics(input.request, ctx, source));
          break;
      }
      await this.#maybeCheckpoint();
      return result;
    });
  }

  addRecords(batch: RecordBatch): Promise<AddResult> {
    return this.#serial(async () => {
      this.#assertOpen();
      if (batch.rows.length === 0) return { accepted: 0, dropped: 0, duplicates: 0 };
      const ctx = this.#ensureEpoch(batch.epoch);
      const shift = batch.epoch - ctx.epoch;
      const resources = new Map<number, ResourceRef>();
      const scopes = new Map<number, ScopeRef>();
      const refsOf = (r: number, s: number, path: string): Refs => {
        let resource = resources.get(r);
        if (resource === undefined) {
          const rec = batch.resources[r];
          if (rec === undefined) throw badRef(`${path}.resource`, r, batch.resources.length);
          resource = ctx.resources.intern(rec) as ResourceRef;
          resources.set(r, resource);
        }
        let scope = scopes.get(s);
        if (scope === undefined) {
          const rec = batch.scopes[s];
          if (rec === undefined) throw badRef(`${path}.scope`, s, batch.scopes.length);
          scope = ctx.scopes.intern(rec) as ScopeRef;
          scopes.set(s, scope);
        }
        return { resource, scope };
      };
      let result: AddResult;
      switch (batch.signal) {
        case 'spans':
          result = await this.#acceptSpans(
            batch.rows.map((s, i) =>
              rebaseSpan(s, shift, refsOf(s.resource, s.scope, `rows[${i}]`), `rows[${i}]`),
            ),
          );
          break;
        case 'logs':
          result = await this.#acceptLogs(
            batch.rows.map((l, i) =>
              rebaseLog(l, shift, refsOf(l.resource, l.scope, `rows[${i}]`), `rows[${i}]`),
            ),
            'records',
          );
          break;
        case 'metrics':
          result = await this.#acceptPoints(
            batch.rows.map((p, i) =>
              rebasePoint(p, shift, refsOf(p.resource, p.scope, `rows[${i}]`), `rows[${i}]`),
            ),
          );
          break;
      }
      await this.#maybeCheckpoint();
      return result;
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
      await this.#checkpoint(false);
      await this.#writeShell();
      await this.#checkpoint(true);
      await this.#lock.release();
      this.#closed = this.#summary();
      return this.#closed;
    });
  }

  // -- internals -------------------------------------------------------------------------------

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#tail.then(fn);
    this.#tail = p.catch(() => undefined);
    return p;
  }

  #assertOpen(): void {
    if (this.#closed !== null) throw new Error(`session for ${this.#out} is closed`);
  }

  #summary(): ReportSummary {
    const all = [...this.#committed, ...this.#pending];
    return {
      out: this.#out,
      totals: { ...this.#totals },
      chunks: all.length,
      bytes: all.reduce((n, c) => n + c.bytes, 0),
    };
  }

  /** The epoch is the earliest timestamp of the first data seen and never changes afterwards. */
  #ensureEpoch(candidate: UnixNanos | null): NormalizeContext {
    if (this.#ctx === null || this.#epoch === null) {
      const epoch = candidate ?? this.#deps.clock.nowUnixNano();
      this.#epoch = epoch;
      this.#ctx = createNormalizeContext(epoch);
      this.#dirty = true;
    }
    return this.#ctx;
  }

  #context(): NormalizeContext {
    if (this.#ctx === null) throw new Error('invariant violated: records accepted before the epoch was set');
    return this.#ctx;
  }

  #extend(start: number, end: number): void {
    this.#range =
      this.#range === null
        ? { start, end }
        : { start: Math.min(this.#range.start, start), end: Math.max(this.#range.end, end) };
  }

  /**
   * Accepting a request is all-or-nothing: everything that can fail (drop conditions, severity checks)
   * runs first against staged rows; the commit that follows is synchronous. Chunk files are written after
   * the commit; a failed write leaves the encoded chunk queued for retry, so in-memory state is never
   * half-applied and a request is never partially counted.
   */
  async #acceptSpans(rows: readonly SpanRecord[]): Promise<AddResult> {
    const ctx = this.#context();
    let dropped = 0;
    let duplicates = 0;
    const seenInRequest = new Set<string>();
    const staged: { span: SpanRecord; resource: ResourceRecord; target: SpanTarget }[] = [];
    for (const span of rows) {
      const resource = ctx.resources.get(span.resource);
      const target = { span, resource, scope: ctx.scopes.get(span.scope), epoch: ctx.epoch };
      if (this.#drop.span.test(target)) {
        dropped++;
        continue;
      }
      const key = span.traceId + span.spanId;
      if (seenInRequest.has(key) || this.#dedupe.has(span.traceId, span.spanId)) {
        duplicates++;
        continue;
      }
      seenInRequest.add(key);
      staged.push({ span, resource, target });
    }
    for (const { span, resource, target } of staged) {
      this.#dedupe.seen(span.traceId, span.spanId);
      this.#traceIndex.add(span, this.#spans.pendingKey, resource);
      this.#rollups.spans.add(target);
      this.#spans.push(span);
      this.#totals.spans++;
      this.#extend(span.start, Math.max(span.start, span.end));
      if (this.#spans.isFull(this.#config.writer.chunkTargetBytes)) this.#cutSync(this.#spans);
    }
    if (staged.length > 0) this.#dirty = true;
    await this.#drainUnwritten(false);
    return { accepted: staged.length, dropped, duplicates };
  }

  async #acceptLogs(rows: readonly LogRecordRecord[], source: string): Promise<AddResult> {
    const ctx = this.#context();
    // Validate every severity first so a bad record rejects the whole request before anything is stored.
    const keys = rows.map((l, i) => {
      try {
        return severityKey(l.severityNumber);
      } catch {
        throw new OtelHtmlError('invalid-otlp', {
          path: `${source}: logRecords[${i}].severityNumber`,
          expected: 'an integer 0..24',
          actual: String(l.severityNumber),
        });
      }
    });
    let dropped = 0;
    const staged: { log: LogRecordRecord; key: (typeof keys)[number] }[] = [];
    for (const [i, log] of rows.entries()) {
      const target = {
        log,
        resource: ctx.resources.get(log.resource),
        scope: ctx.scopes.get(log.scope),
        epoch: ctx.epoch,
      };
      if (this.#drop.log.test(target)) {
        dropped++;
        continue;
      }
      const key = keys[i];
      if (key === undefined) throw new Error('invariant violated: severity key missing');
      staged.push({ log, key });
    }
    for (const { log, key } of staged) {
      const t = logTime(log);
      this.#rollups.logs.add(t, key);
      this.#logs.push(log);
      this.#totals.logs++;
      this.#extend(t, t);
      if (this.#logs.isFull(this.#config.writer.chunkTargetBytes)) this.#cutSync(this.#logs);
    }
    if (staged.length > 0) this.#dirty = true;
    await this.#drainUnwritten(false);
    return { accepted: staged.length, dropped, duplicates: 0 };
  }

  async #acceptPoints(rows: readonly MetricPointRecord[]): Promise<AddResult> {
    const ctx = this.#context();
    let dropped = 0;
    const staged: MetricPointRecord[] = [];
    for (const point of rows) {
      const target = {
        point,
        resource: ctx.resources.get(point.resource),
        scope: ctx.scopes.get(point.scope),
        epoch: ctx.epoch,
      };
      if (this.#drop.point.test(target)) dropped++;
      else staged.push(point);
    }
    for (const point of staged) {
      this.#rollups.metrics.add(point.time, 'points');
      this.#metrics.push(point);
      this.#totals.metrics++;
      this.#extend(Math.min(point.start ?? point.time, point.time), point.time);
      if (this.#metrics.isFull(this.#config.writer.chunkTargetBytes)) this.#cutSync(this.#metrics);
    }
    if (staged.length > 0) this.#dirty = true;
    await this.#drainUnwritten(false);
    return { accepted: staged.length, dropped, duplicates: 0 };
  }

  /** Encode the buffer into a chunk now (synchronously) and queue it for writing. */
  #cutSync<R>(buffer: ChunkBuffer<R>): void {
    if (buffer.length === 0) return;
    const ctx = this.#context();
    const chunk = buffer.build(ctx.resources.entries(), ctx.scopes.entries());
    if (chunk === null) return;
    buffer.commit(chunk);
    this.#unwritten.push(chunk);
    this.#dirty = true;
  }

  /**
   * Write queued chunk files in order. They become visible (listed in the manifest) at the next checkpoint.
   * During `add` (`strict` false) a write error is logged and the chunk stays queued for the next flush,
   * which fails if the problem persists; only a backlog of more than MAX_UNWRITTEN chunks fails the add.
   */
  async #drainUnwritten(strict: boolean): Promise<void> {
    try {
      while (this.#unwritten.length > 0) {
        const chunk = this.#unwritten[0];
        if (chunk === undefined) break;
        await this.#deps.fs.writeBytes(at(this.#out, chunk.entry.path), chunk.bytes);
        this.#unwritten.shift();
        this.#pending.push(chunk.entry);
        this.#decodedBytes += chunk.decodedBytes;
      }
    } catch (e) {
      if (strict || this.#unwritten.length > MAX_UNWRITTEN) throw e;
      this.#deps.logger.error('chunk write failed; will retry at the next flush', {
        error: e instanceof Error ? e.message : String(e),
        queued: this.#unwritten.length,
      });
    }
  }

  /**
   * Interval flushes are only evaluated here, inside `add`: an idle session never flushes by itself, so
   * long-running callers (serve, exporters) must call `flush()` on their own timer.
   */
  async #maybeCheckpoint(): Promise<void> {
    const { clock } = this.#deps;
    if (clock.monotonicMs() - this.#lastFlushMs >= this.#config.writer.flushIntervalMs) {
      await this.#checkpoint(false);
    }
  }

  async #writeShell(): Promise<void> {
    const { fs, viewerAssets } = this.#deps;
    await writeViewerAssets(fs, this.#out, viewerAssets);
    await fs.writeTextAtomic(at(this.#out, 'index.html'), renderIndexHtml(viewerAssets.entry(), this.#title));
    await fs.writeTextAtomic(at(this.#out, '.nojekyll'), '');
    this.#shellWritten = true;
  }

  /**
   * One flush: chunks, then trace shards, rollups, the state checkpoint and, last and atomically, the
   * manifest. Anything written before the manifest is invisible to readers and is overwritten or replaced
   * by the next successful flush, so an interrupted flush leaves the previous manifest valid.
   */
  async #checkpoint(complete: boolean): Promise<void> {
    const { fs, tracer, clock } = this.#deps;
    const span = tracer.startSpan('otel-html.flush', { complete });
    try {
      this.#cutSync(this.#spans);
      this.#cutSync(this.#logs);
      this.#cutSync(this.#metrics);
      await this.#drainUnwritten(true);
      if (this.#dirty || !this.#everCommitted) {
        for (const shard of this.#traceIndex.dirtyShards()) {
          await fs.writeTextAtomic(
            at(this.#out, traceShardPath(shard)),
            wrapDataFile(traceShardKey(shard), this.#traceIndex.shardPayload(shard)),
          );
        }
        const rollups = serializeRollups(this.#rollups);
        for (const name of ROLLUP_NAMES) {
          await fs.writeTextAtomic(
            at(this.#out, rollupPath(name)),
            wrapDataFile(rollupKey(name), rollups[name]),
          );
        }
        await writeStateSlot(fs, this.#out, this.#nextSlot(), this.#state(rollups));
      }
      if (!this.#shellWritten && !complete) await this.#writeShell();
      await writeManifest(fs, this.#out, this.#manifest(complete));
      // Committed: only now does in-memory bookkeeping move forward.
      if (this.#dirty || !this.#everCommitted) this.#slot = this.#nextSlot();
      this.#committed.push(...this.#pending);
      span.setAttributes({
        chunks: this.#pending.length,
        records: this.#totals.spans + this.#totals.logs + this.#totals.metrics,
        shards: this.#traceIndex.dirtyShards().length,
      });
      this.#pending = [];
      this.#traceIndex.clearDirty();
      this.#dirty = false;
      this.#everCommitted = true;
      this.#lastFlushMs = clock.monotonicMs();
    } catch (e) {
      span.recordError(e);
      throw e;
    } finally {
      span.end();
    }
  }

  #nextSlot(): StateSlot {
    return this.#slot === 0 ? 1 : 0;
  }

  #state(rollups: ReturnType<typeof serializeRollups>): SessionState {
    return {
      formatVersion: 1,
      otelHtmlVersion: this.#deps.version,
      epochUnixNano: this.#epoch === null ? null : this.#epoch.toString(),
      nextChunk: {
        spans: this.#spans.pendingNumber,
        logs: this.#logs.pendingNumber,
        metrics: this.#metrics.pendingNumber,
      },
      rollups,
      dedupe: this.#dedupe.toJSON(),
      traceIndex: this.#traceIndex.toJSON(),
    };
  }

  #manifest(complete: boolean): Manifest {
    const now = iso(this.#deps.clock);
    const shards = this.#traceIndex.shards();
    return {
      formatVersion: 1,
      otelHtmlVersion: this.#deps.version,
      title: this.#title,
      epochUnixNano: this.#epoch === null ? '0' : this.#epoch.toString(),
      createdAt: this.#createdAt,
      updatedAt: now,
      complete,
      range: this.#range === null ? null : { ...this.#range },
      totals: { ...this.#totals },
      decodedBytes: this.#decodedBytes,
      chunks: [...this.#committed, ...this.#pending],
      rollups: ROLLUP_NAMES.map((n) => rollupPath(n)),
      traceShards: shards.map((s) => traceShardPath(s)),
      config: { viewer: this.#config.viewer },
    };
  }
}

function badRef(path: string, ref: number, len: number): OtelHtmlError {
  return new OtelHtmlError('invalid-report', {
    path,
    expected: `a ref in [0, ${len})`,
    actual: String(ref),
  });
}
