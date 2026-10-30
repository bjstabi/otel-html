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
import type { TraceShard } from '../format/trace-shard.js';
import { FORMAT_VERSION } from '../format/version.js';
import { OtelHtmlError } from '../model/errors.js';
import { parseUnixNanos, type UnixNanos } from '../model/ids.js';
import {
  createNormalizeContext,
  earliestTimestamp,
  type NormalizeContext,
  normalizeLogs,
  normalizeTraces,
  type PointExemplar,
  pointExemplars,
} from '../model/normalize.js';
import type { OtlpRequest } from '../model/otlp-json.js';
import { metricPointsOf } from '../model/otlp-json-metrics.js';
import {
  type LogRecordRecord,
  logTime,
  type MetricPointRecord,
  type ResourceRecord,
  type ResourceRef,
  type ScopeRecord,
  type ScopeRef,
  type SpanRecord,
} from '../model/records.js';
import type { CompiledCondition } from '../ottl/compile.js';
import { compileAny } from '../ottl/compile.js';
import type { LogTarget, SpanTarget } from '../ottl/contexts.js';
import type { Normalized, StreamTarget } from '../rollups/metric-streams.js';
import { foldedSeriesKey, StreamNormalizer } from '../rollups/metric-streams.js';
import {
  createRollups,
  deserializeRollups,
  type ReportRollups,
  serializeRollups,
} from '../rollups/report-rollups.js';
import { severityKey } from '../semconv/severity.js';
import {
  at,
  isReportFolder,
  jsObjectKeyOrder,
  loadCheckpoint,
  type StateHead,
  type StringifiedHead,
  stringifyHead,
  wipeReportData,
  writeManifest,
  writeStateSlot,
} from './checkpoint.js';
import { type BuiltChunk, ChunkBuffer, LOG_SIGNAL, METRIC_SIGNAL, SPAN_SIGNAL } from './chunker.js';
import { DedupeSet } from './dedupe.js';
import { renderIndexHtml } from './html.js';
import { inheritDashboards } from './inherit-config.js';
import { acquireLock, type LockHandle } from './lock.js';
import { MetricSeriesWriter, restoreCatalogSeries } from './metric-series-writer.js';
import type { Clock, FileSystem, Logger, ProcessInfo, SpanHandle, Timers, Tracer } from './ports.js';
import { type Refs, rebaseLog, rebasePoint, rebaseSpan } from './rebase.js';
import { TraceIndex, type TraceIndexSnapshot } from './trace-index.js';
import { type ViewerAssets, writeViewerAssets } from './viewer-assets.js';

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
export type SessionMode = 'open' | 'append' | 'replace';

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
   * committed report as it was. In append and fresh-create mode, chunks written before a failing entry stay on disk
   * outside the manifest: harmless, never read, and overwritten by the next append.
   */
  readonly partial?: boolean;
}

export interface ReportSummary {
  out: string;
  totals: Record<Signal, number>;
  chunks: number;
  bytes: number;
}

export interface WriterSession {
  add(input: OtlpRequest, source: string, options?: AddOptions): Promise<AddResult>;
  /** The input fed through `partial` adds is complete: write held chunks and checkpoint if one is due. */
  endInput(): Promise<void>;
  addRecords(batch: RecordBatch): Promise<AddResult>;
  flush(): Promise<void>;
  close(): Promise<ReportSummary>;
  /**
   * Give up: release the lock without a final checkpoint. Used when a multi-step job (merge) fails midway;
   * whatever was committed by earlier checkpoints stays, marked incomplete.
   */
  abort(): Promise<void>;
}

/** Encoded chunks allowed to queue behind failing writes before `add` itself fails. */
const MAX_UNWRITTEN = 8;
/**
 * The folded series per metric whose cumulative streams are kept, as a multiple of `writer.metricSeriesCap`: enough
 * that series churning past the cap rarely evict each other, while the state stays bounded.
 */
const FOLDED_STREAMS_PER_SERIES_CAP = 10;
/** Points applied at a time: a slice's records and parse results die young instead of a whole request's. */
const POINT_SLICE = 128;

interface StagedPoint {
  point: MetricPointRecord;
  normalize: (target: StreamTarget) => Normalized;
  exemplars: readonly PointExemplar[];
}
const ROLLUP_NAMES = ['spans', 'logs', 'metrics'] as const;
const DEFAULT_TITLE = 'otel-html report';

interface Restored {
  lock: LockHandle;
  epoch: UnixNanos | null;
  rollups: ReportRollups;
  normalizer: StreamNormalizer;
  dedupe: DedupeSet;
  traceIndex: TraceIndex;
  nextChunk: Record<Signal, number>;
  nextSegment: Map<number, number>;
  metricFiles: string[];
  committed: ManifestChunk[];
  totals: Record<Signal, number>;
  range: { start: number; end: number } | null;
  decodedBytes: number;
  createdAt: string;
  title: string;
  slot: StateSlot;
  /** Output files on disk may be ahead of the committed manifest (resumed after a crash). */
  resumed: boolean;
  /**
   * An existing report is being replaced. Its data is removed just before this session first writes, not at open,
   * so a job that fails while reading its inputs leaves the old report intact.
   */
  replacing: boolean;
}

function iso(clock: Clock): string {
  return new Date(Number(clock.nowUnixNano() / 1_000_000n)).toISOString();
}

export async function openSession(deps: WriterDeps, options: SessionOptions): Promise<WriterSession> {
  let { config } = options;
  const out = options.out.replace(/\/+$/, '') || options.out;
  // Bad OTTL must fail before anything is written (or locked).
  const drop = {
    span: compileAny(config.writer.drop.traces.span, 'span'),
    log: compileAny(config.writer.drop.logs.log_record, 'log_record'),
    point: compileAny(config.writer.drop.metrics.datapoint, 'datapoint'),
  };
  const rollupOpts = {
    facetValueCap: config.writer.facetValueCap,
    facetKeyCap: config.writer.facetKeyCap,
    metricSeriesCap: config.writer.metricSeriesCap,
  };
  // Folded series are not capped by the catalog; their cumulative streams are, per metric.
  const normalizerOpts = { foldedPerMetric: FOLDED_STREAMS_PER_SERIES_CAP * config.writer.metricSeriesCap };
  const { fs } = deps;

  const appending =
    options.mode === 'append' || (options.mode === 'open' && (await fs.exists(at(out, MANIFEST_PATH))));
  let preexisting = false;
  if (!appending) {
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
      hint: 'the folder holds no report; drop --append to create one',
    });
  }
  await fs.mkdirp(at(out, STATE_DIR));
  const lock = await acquireLock(deps, at(out, LOCK_PATH));
  try {
    let restored: Restored;
    if (!appending) {
      restored = {
        lock,
        epoch: null,
        rollups: createRollups(rollupOpts),
        normalizer: new StreamNormalizer(normalizerOpts),
        dedupe: new DedupeSet(config.writer.dedupeCapacity),
        traceIndex: new TraceIndex(),
        nextChunk: { spans: 0, logs: 0, metrics: 0 },
        nextSegment: new Map(),
        metricFiles: [],
        committed: [],
        totals: { spans: 0, logs: 0, metrics: 0 },
        range: null,
        decodedBytes: 0,
        createdAt: iso(deps.clock),
        title: config.title ?? DEFAULT_TITLE,
        slot: 1, // the first checkpoint goes to slot 0
        resumed: false,
        replacing: preexisting,
      };
    } else {
      const cp = await loadCheckpoint(fs, out, deps.version);
      config = inheritDashboards(config, cp.manifest.config);
      restored = {
        lock,
        epoch:
          cp.state.epochUnixNano === null
            ? null
            : parseUnixNanos(cp.state.epochUnixNano, 'state.epochUnixNano'),
        rollups: deserializeRollups(cp.state.rollups, rollupOpts),
        normalizer: StreamNormalizer.from(cp.state.metricStreams, 'state.metricStreams', normalizerOpts),
        dedupe: DedupeSet.from(cp.state.dedupe, config.writer.dedupeCapacity),
        traceIndex: TraceIndex.load(cp.state.traceIndex),
        nextChunk: { ...cp.state.nextChunk },
        nextSegment: new Map(Object.entries(cp.state.nextSegment).map(([id, n]) => [Number(id), n])),
        metricFiles: [...cp.manifest.metricFiles],
        committed: [...cp.manifest.chunks],
        totals: { ...cp.manifest.totals },
        range: cp.manifest.range,
        decodedBytes: cp.manifest.decodedBytes,
        createdAt: cp.manifest.createdAt,
        title: config.title ?? cp.manifest.title,
        slot: cp.slot,
        resumed: true,
        replacing: false,
      };
    }
    if (appending) {
      await restoreCatalogSeries(fs, out, restored.rollups.metrics.catalog, restored.metricFiles);
    }
    for (const d of ['chunks/spans', 'chunks/logs', 'chunks/metrics', 'traces', 'rollups', 'metrics']) {
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
  readonly #normalizer: StreamNormalizer;
  readonly #series: MetricSeriesWriter;
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
  /** Whether `deps.beforeMetrics` has run. */
  #metricsSeen = false;
  #everCommitted: boolean;
  #shellWritten = false;
  #lastFlushMs: number;
  #closed: ReportSummary | null = null;
  #aborted = false;
  #replacing: boolean;
  /** Resumed: metric files on disk that the committed manifest does not list are removed before the first write. */
  #pruneMetrics: boolean;
  /** Inside a `partial` input: see AddOptions. */
  #partial = false;
  #tail: Promise<unknown> = Promise.resolve();
  /** The background checkpoint write, until it ends (it never rejects: a failure is logged and undone). */
  #inflight: Promise<void> | null = null;
  /** Records were accepted since the last checkpoint was prepared. */
  #sinceCheckpoint = false;
  /** Cancels the armed idle timer, if any. */
  #cancelIdle: (() => void) | null = null;

  constructor(deps: WriterDeps, out: string, config: ResolvedConfig, drop: Drops, r: Restored) {
    this.#deps = deps;
    this.#out = out;
    this.#config = config;
    this.#drop = drop;
    this.#lock = r.lock;
    this.#rollups = r.rollups;
    this.#normalizer = r.normalizer;
    this.#series = new MetricSeriesWriter(
      deps.fs,
      out,
      { exemplars: config.writer.metricExemplars },
      r.nextSegment,
      r.metricFiles,
    );
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
    this.#replacing = r.replacing;
    this.#pruneMetrics = r.resumed;
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
      switch (input.signal) {
        case 'traces': {
          const rows = normalizeTraces(input.request, ctx, source, first);
          this.#settleEpoch(rows.length);
          result = await this.#acceptSpans(rows);
          break;
        }
        case 'logs': {
          const rows = normalizeLogs(input.request, ctx, source, first);
          this.#settleEpoch(rows.length);
          result = await this.#acceptLogs(rows, source);
          break;
        }
        case 'metrics': {
          // Generated twice (checked, then applied) rather than held: a request can carry many points.
          const rows = (): Iterable<MetricPointRecord> => metricPointsOf(input, ctx, source);
          result = await this.#acceptPoints(rows, { checked: (n) => this.#settleEpoch(n) });
          break;
        }
      }
      if (result.accepted > 0) this.#sinceCheckpoint = true;
      if (!this.#partial) await this.#maybeCheckpoint();
      this.#armIdle();
      return result;
    });
  }

  endInput(): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      this.#partial = false;
      await this.#drainUnwritten(false);
      await this.#maybeCheckpoint();
      this.#armIdle();
    });
  }

  addRecords(batch: RecordBatch): Promise<AddResult> {
    return this.#serial(async () => {
      this.#assertOpen();
      this.#partial = false;
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
            function* () {
              for (const [i, p] of batch.rows.entries()) {
                yield rebasePoint(p, shift, refsOf(p.resource, p.scope, `rows[${i}]`), `rows[${i}]`);
              }
            },
            { origin: batch.origin },
          );
          break;
      }
      if (result.accepted > 0) this.#sinceCheckpoint = true;
      await this.#maybeCheckpoint();
      this.#armIdle();
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
      this.#assertOpen();
      this.#disarmIdle();
      await this.#checkpoint(false);
      // Level files are written under paths the committed manifest does not list (segments, or demoted levels).
      await this.#series.compact(this.#rollups.metrics.catalog);
      await this.#writeShell();
      await this.#checkpoint(true);
      // The report is committed; a failed prune (stale segments left behind) must not keep the lock.
      try {
        await this.#series.prune();
      } finally {
        await this.#lock.release();
      }
      this.#closed = this.#summary();
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

  /**
   * The epoch is the earliest timestamp of the first data that has one, and never changes afterwards. A request
   * without any timestamp gets a provisional context anchored at the wall clock, and the epoch stays unset unless
   * it holds records (`#settleEpoch`): an empty resource entry first in a file must not pin the epoch to now. The
   * provisional resource and scope tables carry over once the epoch is fixed.
   */
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

  /** Records normalized against a provisional context fix its wall-clock epoch for good. */
  #settleEpoch(records: number): void {
    if (records === 0 || this.#epoch !== null || this.#ctx === null) return;
    this.#epoch = this.#ctx.epoch;
    this.#dirty = true;
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
    await this.#drainAccepted();
    return { accepted: staged.length, dropped, duplicates };
  }

  async #acceptLogs(rows: readonly LogRecordRecord[], source: string): Promise<AddResult> {
    const ctx = this.#context();
    // Validate every severity first so a bad record rejects the whole request before anything is stored.
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
    const staged: { log: LogRecordRecord; target: LogTarget }[] = [];
    for (const log of rows) {
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
      staged.push({ log, target });
    }
    for (const { log, target } of staged) {
      const t = logTime(log);
      this.#rollups.logs.add(target);
      this.#logs.push(log);
      if (log.traceId !== null) this.#traceIndex.addLog(log, this.#logs.pendingKey);
      this.#totals.logs++;
      this.#extend(t, t);
      if (this.#logs.isFull(this.#config.writer.chunkTargetBytes)) this.#cutSync(this.#logs);
    }
    if (staged.length > 0) this.#dirty = true;
    await this.#drainAccepted();
    return { accepted: staged.length, dropped, duplicates: 0 };
  }

  /**
   * Accepts a request's points all or nothing, without holding them all: a first pass checks every point
   * (parse errors reject the request before any state changes) and keeps nothing; the second applies the points
   * POINT_SLICE at a time. `rows` yields the same points each time it is called.
   */
  async #acceptPoints(
    rows: () => Iterable<MetricPointRecord>,
    opts: { checked?: (records: number) => void; origin?: number | undefined } = {},
  ): Promise<AddResult> {
    const { checked, origin } = opts;
    if (!this.#metricsSeen) {
      this.#metricsSeen = true;
      this.#deps.beforeMetrics?.();
    }
    let dropped = 0;
    let accepted = 0;
    for (const point of rows()) {
      if (this.#dropped(point)) dropped++;
      else {
        this.#stage(point);
        accepted++;
      }
    }
    checked?.(accepted + dropped);
    let slice: StagedPoint[] = [];
    for (const point of rows()) {
      if (this.#dropped(point)) continue;
      slice.push(this.#stage(point));
      if (slice.length === POINT_SLICE) {
        this.#applyPoints(slice, origin);
        slice = [];
      }
    }
    this.#applyPoints(slice, origin);
    if (accepted > 0) this.#dirty = true;
    await this.#drainAccepted();
    await this.#spillSeries();
    return { accepted, dropped, duplicates: 0 };
  }

  #dropped(point: MetricPointRecord): boolean {
    const ctx = this.#context();
    const resource = ctx.resources.get(point.resource);
    const scope = ctx.scopes.get(point.scope);
    return this.#drop.point.test({ point, resource, scope, epoch: ctx.epoch });
  }

  /** Parses a point (throwing when it is malformed) without changing any state. */
  #stage(point: MetricPointRecord): StagedPoint {
    const ctx = this.#context();
    return {
      point,
      normalize: this.#normalizer.prepare(point),
      exemplars: pointExemplars(
        point,
        ctx.epoch,
        () => `metric ${JSON.stringify(point.name)}.point.exemplars`,
      ),
    };
  }

  /** `origin`: the input report of a merge, for the stream rule (see `StreamTarget.origin`). */
  #applyPoints(staged: readonly StagedPoint[], origin: number | undefined): void {
    const ctx = this.#context();
    const catalog = this.#rollups.metrics.catalog;
    for (const { point, normalize, exemplars } of staged) {
      const def = catalog.defOf(point);
      const series = catalog.seriesOf(
        def,
        point,
        ctx.resources.get(point.resource),
        ctx.scopes.get(point.scope),
      );
      // A folded series keeps its own cumulative stream (while it is among the metric's most recently used folded
      // series); its deltas go into `other`.
      const n = normalize(
        series.foldKey === null
          ? { series: `${def.id}/${series.id}`, origin }
          : { series: foldedSeriesKey(def.id, series.foldKey), foldedIn: def.id, origin },
      );
      catalog.note(def.id, n, point.time);
      if (n.kind === 'ok') {
        const stored = exemplars.length === 0 ? [] : exemplars.map((e) => ({ ...e, series: series.id }));
        this.#series.add(def, series, point.time, n.agg, stored);
      }
      this.#rollups.metrics.buckets.add(point.time, 'points');
      this.#metrics.push(point);
      this.#totals.metrics++;
      this.#extend(Math.min(point.start ?? point.time, point.time), point.time);
      if (this.#metrics.isFull(this.#config.writer.chunkTargetBytes)) this.#cutSync(this.#metrics);
    }
  }

  /**
   * Write buffered metric buckets out as segments ahead of the flush once the buffer is full, so memory stays
   * bounded. Like chunk writes during `add`, a failure is logged and the buckets stay buffered for the flush.
   */
  async #spillSeries(): Promise<void> {
    if (!this.#series.full() || (this.#partial && this.#replacing)) return;
    try {
      await this.#wipeReplaced();
      await this.#series.spill(this.#rollups.metrics.catalog);
    } catch (e) {
      this.#deps.logger.error('metric segment write failed; will retry at the next flush', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
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
      if (this.#unwritten.length > 0) await this.#wipeReplaced();
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

  /** Write chunks cut while accepting rows, except into a report still to be wiped during a partial input. */
  async #drainAccepted(): Promise<void> {
    if (this.#partial && this.#replacing) return;
    await this.#drainUnwritten(false);
  }

  /**
   * Interval checkpoints are evaluated inside `add` and, after `writer.flushIntervalMs` of silence with new
   * records, by the idle timer; `flush()` is still the only point at which the report on disk is known to be
   * current. The checkpoint is prepared here, under the serial queue, and written in the background so the adds
   * queued behind it are not held up by a slow write; one write runs at a time.
   */
  async #maybeCheckpoint(): Promise<void> {
    const { clock } = this.#deps;
    if (this.#inflight !== null) return;
    if (clock.monotonicMs() - this.#lastFlushMs < this.#config.writer.flushIntervalMs) return;
    await this.#startBackgroundCheckpoint();
  }

  /** Prepare a checkpoint under the serial queue and write it in the background (see `#inflight`). */
  async #startBackgroundCheckpoint(): Promise<void> {
    const prepared = await this.#prepareCheckpoint(false);
    this.#inflight = this.#writeCheckpoint(prepared).then(
      () => {
        this.#inflight = null;
      },
      (e: unknown) => {
        this.#inflight = null;
        // Same as a failed foreground flush as far as the report goes; the next flush retries (and fails on its own
        // if the problem stays). The interval restarts so a persistent fault is not retried by every request.
        this.#lastFlushMs = this.#deps.clock.monotonicMs();
        this.#deps.logger.error('checkpoint failed; will retry at the next flush', {
          error: e instanceof Error ? e.message : String(e),
        });
      },
    );
  }

  /** (Re)start the idle timer when records are waiting for a checkpoint. */
  #armIdle(): void {
    this.#disarmIdle();
    if (!this.#sinceCheckpoint || this.#closed !== null || this.#aborted) return;
    this.#cancelIdle = this.#deps.timers.after(this.#config.writer.flushIntervalMs, () => {
      this.#cancelIdle = null;
      // Nobody awaits this: a failure is logged, and the next flush retries.
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

  /** The idle timer fired: checkpoint now, whatever the interval says, unless a write or a partial input is under way. */
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
    if (this.#replacing) {
      await wipeReportData(this.#deps.fs, this.#out);
      this.#replacing = false;
    }
    if (this.#pruneMetrics) {
      // An interrupted flush may have left metric files the committed manifest does not list.
      await this.#series.prune();
      this.#pruneMetrics = false;
    }
  }

  async #writeShell(): Promise<void> {
    const { fs, viewerAssets } = this.#deps;
    await writeViewerAssets(fs, this.#out, viewerAssets);
    await fs.writeTextAtomic(at(this.#out, 'index.html'), renderIndexHtml(viewerAssets.entry(), this.#title));
    await fs.writeTextAtomic(at(this.#out, '.nojekyll'), '');
    this.#shellWritten = true;
  }

  /** A foreground flush: waits for a background write, then prepares and writes. */
  async #checkpoint(complete: boolean): Promise<void> {
    await this.#inflight;
    await this.#writeCheckpoint(await this.#prepareCheckpoint(complete));
  }

  /**
   * The synchronous-ish first half of a flush, under the serial queue: chunks written, then an immutable picture
   * of everything the second half writes, so the adds that follow cannot change it. Metric segments are flushed
   * here too (they are not what makes a checkpoint slow).
   */
  async #prepareCheckpoint(complete: boolean): Promise<PreparedCheckpoint> {
    const span = this.#deps.tracer.startSpan('otel-html.flush', { complete });
    try {
      await this.#wipeReplaced();
      this.#cutSync(this.#spans);
      this.#cutSync(this.#logs);
      this.#cutSync(this.#metrics);
      await this.#drainUnwritten(true);
      const metricFiles = await this.#series.flush(this.#rollups.metrics.catalog);
      // New segment numbers must reach the state, or a resumed session would overwrite listed segments.
      if (metricFiles.length > 0) this.#dirty = true;
      const manifest = this.#manifest(complete);
      const chunks = this.#pending;
      const writeState = this.#dirty || !this.#everCommitted;
      const prepared: PreparedCheckpoint = {
        complete,
        span,
        manifest,
        chunks,
        metricFiles: metricFiles.length,
        records: this.#totals.spans + this.#totals.logs + this.#totals.metrics,
        slot: this.#nextSlot(),
        state: null,
      };
      if (writeState) {
        const rollups = serializeRollups(this.#rollups);
        const rollupFiles = ROLLUP_NAMES.map((n): [string, string] => [
          rollupPath(n),
          wrapDataFile(rollupKey(n), rollups[n]),
        ]);
        const head = stringifyHead(this.#stateHead(rollups));
        const dedupe = this.#dedupe.toJSON();
        // Last: nothing after it can throw, so a failed prepare never leaves a snapshot held or shards un-dirtied.
        const snapshot = this.#traceIndex.snapshot();
        prepared.state = { snapshot, rollupFiles, head, dedupe };
        this.#dirty = false;
      }
      this.#pending = []; // last, after everything that can throw
      this.#sinceCheckpoint = false;
      this.#disarmIdle(); // nothing is waiting for it any more
      return prepared;
    } catch (e) {
      span.recordError(e);
      span.end();
      throw e;
    }
  }

  /**
   * The second half of a flush, from the prepared picture alone: trace shards, rollups, the state checkpoint and,
   * last and atomically, the manifest. Anything written before the manifest is invisible to readers and is
   * overwritten or replaced by the next successful flush, so an interrupted flush leaves the previous manifest
   * valid. On failure what the prepare took out of the live bookkeeping is put back.
   */
  async #writeCheckpoint(p: PreparedCheckpoint): Promise<void> {
    const { fs, clock } = this.#deps;
    const { state } = p;
    try {
      if (state !== null) {
        for (const shard of state.snapshot.dirty) {
          await fs.writeTextAtomic(
            at(this.#out, traceShardPath(shard)),
            wrapDataFile(traceShardKey(shard), Object.fromEntries(state.snapshot.entries(shard))),
          );
        }
        for (const [path, text] of state.rollupFiles) await fs.writeTextAtomic(at(this.#out, path), text);
        await writeStateSlot(fs, this.#out, p.slot, state.head, state.dedupe, snapshotViews(state.snapshot));
      }
      if (!this.#shellWritten && !p.complete) await this.#writeShell();
      await writeManifest(fs, this.#out, p.manifest);
      // Committed: only now does in-memory bookkeeping move forward.
      if (state !== null) this.#slot = p.slot;
      this.#committed.push(...p.chunks);
      p.span.setAttributes({
        chunks: p.chunks.length,
        records: p.records,
        shards: state?.snapshot.dirty.length ?? 0,
        metricFiles: p.metricFiles,
      });
      this.#everCommitted = true;
      this.#lastFlushMs = clock.monotonicMs();
    } catch (e) {
      // Chunks added since the prepare come after the ones it listed.
      this.#pending = [...p.chunks, ...this.#pending];
      if (state !== null) {
        this.#traceIndex.restoreDirty(state.snapshot.dirty);
        this.#dirty = true;
      }
      p.span.recordError(e);
      throw e;
    } finally {
      this.#traceIndex.release();
      p.span.end();
    }
  }

  #nextSlot(): StateSlot {
    return this.#slot === 0 ? 1 : 0;
  }

  #stateHead(rollups: ReturnType<typeof serializeRollups>): StateHead {
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
      metricStreams: this.#normalizer.toJSON(),
      nextSegment: Object.fromEntries([...this.#series.nextSegments()].map(([id, n]) => [String(id), n])),
    };
  }

  #manifest(complete: boolean): Manifest {
    const now = iso(this.#deps.clock);
    const shards = this.#traceIndex.shards();
    return {
      formatVersion: FORMAT_VERSION,
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
      metricFiles: this.#series.listed(),
      config: {
        viewer: { ...this.#config.viewer },
        dashboards: this.#config.dashboards,
        views: this.#config.views,
      },
    };
  }
}

/** What a flush writes, taken at prepare time (see `#prepareCheckpoint`). */
interface PreparedCheckpoint {
  complete: boolean;
  span: SpanHandle;
  manifest: Manifest;
  /** The pending chunk entries this checkpoint lists, moved out of `#pending`. */
  chunks: ManifestChunk[];
  metricFiles: number;
  records: number;
  slot: StateSlot;
  /** `null` when nothing changed since the last checkpoint: only the manifest is written. */
  state: {
    snapshot: TraceIndexSnapshot;
    rollupFiles: [path: string, text: string][];
    head: StringifiedHead;
    dedupe: string[];
  } | null;
}

/** The snapshot's shards in the state's object-key order, one view at a time. */
function* snapshotViews(snapshot: TraceIndexSnapshot): Generator<[string, Readonly<TraceShard>]> {
  for (const s of jsObjectKeyOrder(snapshot.shardNames)) yield [s, Object.fromEntries(snapshot.entries(s))];
}

function badRef(path: string, ref: number, len: number): OtelHtmlError {
  return new OtelHtmlError('invalid-report', {
    path,
    expected: `a ref in [0, ${len})`,
    actual: String(ref),
  });
}
