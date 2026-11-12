import { and, type ExprNode, type Query, sql } from '@uwdata/mosaic-sql';
import type { ManifestV4 } from '../../format/manifest.js';
import type { Table as TableName } from '../../format/parquet/columns.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId, UnixNanos } from '../../model/ids.js';
import type { ResourceRecord, ResourceRef, ScopeRecord, ScopeRef } from '../../model/records.js';
import { type CompiledCondition, compileCondition } from '../../ottl/compile.js';
import {
  attributeFacetsQuery,
  CORE_LOG_FACETS,
  CORE_SPAN_FACETS,
  type CoreFacet,
  coreFacetsQuery,
} from '../../query/sql/facets.js';
import { buildFilter, type SqlFilter } from '../../query/sql/filter.js';
import {
  type LogSort,
  type LogTraceSort,
  logByRefQuery,
  logRowsQuery,
  logsWithTraceCountQuery,
  logTimelineQuery,
  logTracesQuery,
  type PatternSort,
  patternsQuery,
  pointsTimelineQuery,
  surroundingQueries,
  traceLogsQuery,
} from '../../query/sql/logs.js';
import { absWindow, type Pruned } from '../../query/sql/prune.js';
import { idTableRowsQuery } from '../../query/sql/residual.js';
import {
  durationBinsQuery,
  durationSummaryQuery,
  groupStatsQuery,
  percentileQuery,
  resourceValuesQuery,
  type SpanSort,
  serviceBucketsQuery,
  servicesQuery,
  spanCountQuery,
  spanRowsQuery,
  type TraceSort,
  timelineQuery,
  traceBoundOf,
  tracePartitionsQuery,
  traceRowsQuery,
  traceSpansQuery,
  traceSummaryQuery,
} from '../../query/sql/spans.js';
import { bucketSpec } from '../../query/sql/time.js';
import { partitionOfFilename } from '../../query/sql/views.js';
import { FacetCounts } from '../../rollups/facets.js';
import { TimeBuckets } from '../../rollups/time-buckets.js';
import { LOG_SEVERITY_KEYS } from '../../semconv/severity.js';
import { durationAxis } from '../traces/views.js';
import type { DataSource, TraceDetail } from './data-source.js';
import { metricMethods } from './duckdb-metrics.js';
import { checkSurroundingCount, type LogRef, type LogRow, refParts } from './log-query.js';
import {
  type LogRowEntry,
  logEntries,
  logRows,
  logTimeline,
  logTraceRows,
  patternRows,
  pointBuckets,
  resourceValueResult,
} from './log-results.js';
import { manifestRange } from './manifest-range.js';
import { DEFAULT_FACET_CAPS, type FacetCaps, filesFor, runPrepared, throwIfAborted } from './query-common.js';
import type { QueryEngine } from './query-engine.js';
import { dropResidualTable, idTable, residualRows, servedResidual } from './residual.js';
import type {
  LogNeed,
  LogQuery,
  LogQueryResult,
  PatternQuery,
  PatternsResult,
  RowTables,
  ServicesResult,
  SpanNeed,
  SpanQuery,
  SpanQueryResult,
  SpanRow,
  SurroundingLogs,
} from './results.js';
import {
  cell,
  durationBins,
  durationSummary,
  facetCounts,
  groupStats,
  internRows,
  rowsOf,
  type SpanEntry,
  serviceStats,
  spanEntries,
  spanRows,
  timeline,
  timelineBuckets,
  toNumber,
  traceRows,
} from './span-results.js';
import type { TimeWindow } from './time-window.js';
import { traceNotFound } from './trace-detail.js';
import { buildTraceTree, dedupeSpanIds, exclusiveTimeByService } from './trace-tree.js';

/** The explorer's duration facet has this many bins. */
const DURATION_BIN_COUNT = 24;
/** D5: candidate rows an aggregate with a residual condition reads. */
const RESIDUAL_CANDIDATE_CAP = 200_000;

const SPAN_SORTS: readonly SpanSort['column'][] = [
  'start',
  'duration',
  'name',
  'service',
  'resource',
  'status',
];
const TRACE_SORTS: readonly TraceSort['column'][] = [
  'start',
  'duration',
  'spans',
  'errors',
  'service',
  'resource',
];
/** The needs that read the whole filtered set (a residual condition narrows them through its id table). */
const AGGREGATE_NEEDS: readonly SpanNeed[] = [
  'facets',
  'timeline',
  'buckets',
  'total',
  'durations',
  'groups',
];
const CORE_KEYS: ReadonlySet<string> = new Set(CORE_SPAN_FACETS.map((c) => c.key));
const LOG_SORTS: readonly LogSort['column'][] = ['time', 'severity', 'service'];
const LOG_TRACE_SORTS: readonly LogTraceSort['column'][] = ['first', 'logs', 'severity'];
const PATTERN_SORTS: readonly PatternSort['column'][] = ['count', 'first', 'last'];
const LOG_AGGREGATE_NEEDS: readonly LogNeed[] = ['facets', 'timeline'];
const CORE_LOG_KEYS: ReadonlySet<string> = new Set(CORE_LOG_FACETS.map((c) => c.key));

function sortOf<C extends string>(
  allowed: readonly C[],
  sort: { column: string; dir: 'asc' | 'desc' },
  mode: string,
): { column: C; dir: 'asc' | 'desc' } {
  const column = allowed.find((c) => c === sort.column);
  if (column === undefined) {
    throw new OtelHtmlError('usage', {
      path: 'query.sort.column',
      expected: `one of ${allowed.join(', ')} (mode ${mode})`,
      actual: JSON.stringify(sort.column),
    });
  }
  return { column, dir: sort.dir };
}

function emptyResult(caps: typeof DEFAULT_FACET_CAPS, residual: string | null): SpanQueryResult {
  return {
    rows: [],
    total: 0,
    facets: new FacetCounts(caps.facetValueCap, caps.facetKeyCap, [...CORE_KEYS]),
    buckets: new TimeBuckets(['ok', 'error', 'unset']),
    red: null,
    durations: { summary: null, bins: [] },
    groups: null,
    residual,
    tables: { resources: [], scopes: [] },
  };
}

/** The residual terms (D5) as a test on a decoded row; the row's own resource and scope records are the target's. */
function residualTest(compiled: CompiledCondition<'span'>, epoch: bigint): (e: SpanEntry) => boolean {
  return (e) =>
    compiled.test({
      span: e.span,
      resource: e.shared.resource,
      scope: e.shared.scope,
      epoch: epoch as UnixNanos,
    });
}

function emptyLogResult(caps: FacetCaps, residual: string | null, mode: LogQuery['mode']): LogQueryResult {
  const base = {
    total: 0,
    matched: 0,
    facets: new FacetCounts(caps.facetValueCap, caps.facetKeyCap, [...CORE_LOG_KEYS]),
    buckets: new TimeBuckets(LOG_SEVERITY_KEYS),
    residual,
  };
  return mode === 'traces' ? { ...base, mode, rows: [] } : { ...base, mode: 'logs', rows: [] };
}

/** The residual terms (D5) as a test on a decoded log row. */
function logResidualTest(
  compiled: CompiledCondition<'log_record'>,
  epoch: bigint,
): (e: LogRowEntry) => boolean {
  return (e) =>
    compiled.test({
      log: e.row.log,
      resource: e.row.resource,
      scope: e.row.scope,
      epoch: epoch as UnixNanos,
    });
}

const noSuchLog = (ref: LogRef): OtelHtmlError =>
  new OtelHtmlError('usage', { path: `log ${ref}`, expected: 'a log of this report', actual: 'no such log' });

/** A row limit is a non-negative integer. */
function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new OtelHtmlError('usage', {
      path: 'query.limit',
      expected: 'a non-negative integer',
      actual: String(limit),
    });
  }
}

/** The format-4 data source over a query engine (D19): no Mosaic type appears here. `close()` is `engine.close()`. */
export function createDuckDbDataSource(opts: {
  engine: QueryEngine;
  manifest: ManifestV4;
  /** Where a failed cleanup of the D5 temp table is reported; silent without one. */
  logger?: Pick<Console, 'warn'>;
  /** The facet and resource-value caps; the manifest's (the writer's), or the defaults for a report without them. */
  caps?: FacetCaps;
}): DataSource {
  const { engine, manifest } = opts;
  const epoch = BigInt(manifest.epochUnixNano);
  const { facetValueCap, facetKeyCap } = manifest.config.viewer;
  const caps: FacetCaps = opts.caps ?? {
    facetValueCap: facetValueCap ?? DEFAULT_FACET_CAPS.facetValueCap,
    facetKeyCap: facetKeyCap ?? DEFAULT_FACET_CAPS.facetKeyCap,
  };
  const range = manifestRange(manifest);

  /** Runs `q` after the engine prepared the files it reads: `tables` whole, the first one narrowed to `pruned`. */
  const read = (
    tables: readonly TableName[],
    pruned: Pruned | undefined,
    q: Query,
    signal?: AbortSignal,
  ): ReturnType<QueryEngine['query']> => runPrepared(engine, q, filesFor(manifest, tables, pruned), signal);

  /**
   * Narrows `filter` to the rows the residual terms accept, through a temp table of their ids (D5). `candidates` reads
   * up to the given number of rows of the filtered set.
   */
  async function withIds<E extends { filename: string; fileRow: number }, T>(
    filter: SqlFilter,
    residual: string,
    candidates: (limit: number) => Promise<E[]>,
    test: (e: E) => boolean,
    run: (f: SqlFilter) => Promise<T>,
  ): Promise<T> {
    if (!engine.tempTables) throw servedResidual(residual); // D43: before any candidate is fetched
    const entries = await candidates(RESIDUAL_CANDIDATE_CAP + 1);
    if (entries.length > RESIDUAL_CANDIDATE_CAP) {
      throw new OtelHtmlError('usage', {
        message: `the condition needs the browser to evaluate part of it on more than ${RESIDUAL_CANDIDATE_CAP} rows; narrow the window or the rest of the condition`,
      });
    }
    const survivors = entries.filter(test);
    const table = await idTable(
      engine,
      ['filename', 'file_row_number'],
      survivors.map((e) => [e.filename, e.fileRow]),
    );
    try {
      const ids: ExprNode = sql`(filename, file_row_number) IN (${idTableRowsQuery(table, ['filename', 'file_row_number'])})`;
      return await run({
        ...filter,
        predicate: filter.predicate === null ? ids : and(filter.predicate, ids),
      });
    } finally {
      await dropResidualTable(engine, table).catch((error: unknown) => {
        opts.logger?.warn(`could not clean up the temp table ${table}`, error);
      });
    }
  }

  const withResidualIds = <T>(
    filter: SqlFilter,
    residual: string,
    test: (e: SpanEntry) => boolean,
    signal: AbortSignal | undefined,
    run: (f: SqlFilter) => Promise<T>,
  ): Promise<T> =>
    withIds(
      filter,
      residual,
      async (limit) =>
        spanEntries(
          await read(
            ['spans'],
            filter.files,
            spanRowsQuery(filter, { column: 'start', dir: 'asc' }, limit),
            signal,
          ),
          epoch,
        ).entries,
      test,
      run,
    );

  async function querySpans(q: SpanQuery, signal?: AbortSignal): Promise<SpanQueryResult> {
    throwIfAborted(signal);
    checkLimit(q.limit);
    const { filter, residual } = buildFilter({
      manifest,
      table: 'spans',
      condition: q.condition,
      text: q.text,
      window: q.window,
    });
    const browser = residual !== null;
    if (filter.files.files.length === 0) return emptyResult(caps, residual);
    const needs = new Set(q.needs);
    const aggregates = AGGREGATE_NEEDS.some((n) => needs.has(n));
    const spanSort = q.mode === 'spans' ? sortOf(SPAN_SORTS, q.sort, 'spans') : null;
    const traceSort = q.mode === 'traces' ? sortOf(TRACE_SORTS, q.sort, 'traces') : null;
    const useIds = browser && (aggregates || (q.mode === 'traces' && needs.has('rows')));
    const test = residual === null ? null : residualTest(compileCondition(residual, 'span'), epoch);

    const run = async (f: SqlFilter): Promise<SpanQueryResult> => {
      const result = emptyResult(caps, residual);
      const spec = bucketSpec(q.window, range);
      const parts: Promise<void>[] = [];

      if (needs.has('rows')) {
        parts.push(
          (async () => {
            if (traceSort !== null) {
              const r = traceRows(
                await read(['spans', 'traces'], f.files, traceRowsQuery(f, traceSort, q.limit), signal),
              );
              Object.assign(result, r);
            } else if (spanSort !== null && !useIds && test !== null) {
              let candidates = 0;
              const { rows, exhausted } = await residualRows({
                limit: q.limit,
                fetch: async (limit, offset) => {
                  const page = spanEntries(
                    await read(['spans'], f.files, spanRowsQuery(f, spanSort, limit).offset(offset), signal),
                    epoch,
                  );
                  if (offset === 0) candidates = page.total;
                  return page.entries;
                },
                test,
              });
              const interned = internRows(rows);
              Object.assign(result, {
                rows: interned.rows,
                tables: interned.tables,
                total: exhausted ? rows.length : Math.max(candidates, rows.length),
              });
            } else if (spanSort !== null) {
              Object.assign(
                result,
                spanRows(await read(['spans'], f.files, spanRowsQuery(f, spanSort, q.limit), signal), epoch),
              );
            }
          })(),
        );
      }

      if (needs.has('facets')) {
        parts.push(
          (async () => {
            const keys =
              q.facetKeys === null
                ? CORE_SPAN_FACETS
                : CORE_SPAN_FACETS.filter((c) => q.facetKeys?.includes(c.key));
            const wantAttrs = q.facetKeys === null || q.facetKeys.some((k) => !CORE_KEYS.has(k));
            const [core, attrs] = await Promise.all([
              keys.length === 0
                ? null
                : read(['spans'], f.files, coreFacetsQuery(f, 'spans', keys, caps), signal),
              wantAttrs
                ? read(['spans'], f.files, attributeFacetsQuery(f, 'spans', caps, [...CORE_KEYS]), signal)
                : null,
            ]);
            result.facets = facetCounts(
              core,
              attrs,
              caps,
              [...CORE_KEYS],
              q.facetKeys === null ? null : new Set(q.facetKeys),
            );
          })(),
        );
      }

      if (needs.has('timeline')) {
        parts.push(
          (async () => {
            const t = timeline(await read(['spans'], f.files, timelineQuery(f, spec), signal), spec);
            result.buckets = t.buckets;
            result.red = t.red;
          })(),
        );
      } else if (needs.has('buckets')) {
        // The counts alone: the statement leaves out the latency columns, and `red` keeps its empty value.
        parts.push(
          (async () => {
            result.buckets = timelineBuckets(
              await read(['spans'], f.files, timelineQuery(f, spec, false), signal),
              spec,
            );
          })(),
        );
      }

      if (needs.has('total') && !needs.has('rows')) {
        // The match count alone, as `rows` would report it; with `rows` asked its statement sets the total.
        parts.push(
          (async () => {
            const t = await read(['spans'], f.files, spanCountQuery(f, q.mode), signal);
            result.total = toNumber(cell(rowsOf(t)[0] ?? {}, 'total') ?? 0n, 'total');
          })(),
        );
      }

      if (needs.has('durations')) {
        parts.push(
          (async () => {
            const summary = durationSummary(await read(['spans'], f.files, durationSummaryQuery(f), signal));
            if (summary === null) return;
            // A caller's axis (the explorer keeps one while a duration filter is set) wins over the derived one.
            const edges = durationAxis(
              [{ durationNs: summary.min }, { durationNs: summary.max }],
              DURATION_BIN_COUNT,
            );
            const axis =
              q.durationAxis ??
              edges.slice(0, -1).map((from, i) => ({ fromNs: from, toNs: edges[i + 1] ?? from }));
            const bins = durationBins(
              await read(['spans'], f.files, durationBinsQuery(f, axis), signal),
              axis,
            );
            result.durations = { summary, bins };
          })(),
        );
      }

      if (needs.has('groups') && q.measureBy !== null) {
        const key = q.measureBy;
        parts.push(
          (async () => {
            result.groups = groupStats(
              await read(['spans'], f.files, groupStatsQuery(f, 'spans', key, caps.facetValueCap), signal),
              caps.facetValueCap,
            );
          })(),
        );
      }

      await Promise.all(parts);
      return result;
    };

    return test !== null && residual !== null && useIds
      ? withResidualIds(filter, residual, test, signal, run)
      : run(filter);
  }

  async function services(
    o: { window: TimeWindow | null; condition: string | null; limit: number },
    signal?: AbortSignal,
  ): Promise<ServicesResult> {
    throwIfAborted(signal);
    const { filter, residual } = buildFilter({
      manifest,
      table: 'spans',
      condition: o.condition,
      text: '',
      window: o.window,
    });
    if (filter.files.files.length === 0) return { services: [], total: 0 };
    const spec = bucketSpec(o.window, range);
    const run = async (f: SqlFilter): Promise<ServicesResult> => {
      const found = await read(['spans'], f.files, servicesQuery(f, o.limit + 1), signal);
      const names = rowsOf(found)
        .slice(0, o.limit)
        .map((r) => String(cell(r, 'service_name')));
      const buckets =
        names.length === 0
          ? null
          : await read(['spans'], f.files, serviceBucketsQuery(f, names, spec), signal);
      return serviceStats(found, buckets, spec, o.limit);
    };
    return residual === null
      ? run(filter)
      : withResidualIds(
          filter,
          residual,
          residualTest(compileCondition(residual, 'span'), epoch),
          signal,
          run,
        );
  }

  /** A trace without a `traces` row may have logs in any partition. */
  const allLogsFiles = manifest.partitions.flatMap((p) =>
    p.files.logs === undefined ? [] : [p.files.logs.path],
  );

  async function queryLogs(q: LogQuery, signal?: AbortSignal): Promise<LogQueryResult> {
    throwIfAborted(signal);
    checkLimit(q.limit);
    if ((q.mode as string) === 'patterns') {
      throw new OtelHtmlError('usage', {
        path: 'query.mode',
        expected: "'logs' or 'traces' (patterns have their own method)",
        actual: JSON.stringify(q.mode),
      });
    }
    const { filter, residual } = buildFilter({
      manifest,
      table: 'logs',
      condition: q.condition,
      text: q.text,
      window: q.window,
      ...(q.traceId == null
        ? {}
        : { traceId: q.traceId, traceFiles: (await logTraceFiles(q.traceId, signal)) ?? allLogsFiles }),
    });
    const browser = residual !== null;
    if (filter.files.files.length === 0) return emptyLogResult(caps, residual, q.mode);
    const needs = new Set(q.needs);
    const aggregates = LOG_AGGREGATE_NEEDS.some((n) => needs.has(n));
    const logSort = q.mode === 'logs' ? sortOf(LOG_SORTS, q.sort, 'logs') : null;
    const traceSort = q.mode === 'traces' ? sortOf(LOG_TRACE_SORTS, q.sort, 'traces') : null;
    const useIds = browser && (aggregates || (q.mode === 'traces' && needs.has('rows')));
    const test = residual === null ? null : logResidualTest(compileCondition(residual, 'log_record'), epoch);

    const run = async (f: SqlFilter): Promise<LogQueryResult> => {
      const result = emptyLogResult(caps, residual, q.mode);
      const spec = bucketSpec(q.window, range);
      const parts: Promise<void>[] = [];

      if (needs.has('rows')) {
        parts.push(
          (async () => {
            if (traceSort !== null) {
              const r = logTraceRows(
                await read(['logs'], f.files, logTracesQuery(f, traceSort, q.limit), signal),
              );
              const matching = await read(['logs'], f.files, logsWithTraceCountQuery(f), signal);
              Object.assign(result, {
                rows: r.rows,
                total: r.total,
                matched: toNumber(cell(rowsOf(matching)[0] ?? {}, 'n') ?? 0n, 'n'),
              });
            } else if (logSort !== null && !useIds && test !== null) {
              let candidates = 0;
              const { rows, exhausted } = await residualRows({
                limit: q.limit,
                fetch: async (limit, offset) => {
                  const page = logEntries(
                    await read(['logs'], f.files, logRowsQuery(f, logSort, limit).offset(offset), signal),
                  );
                  if (offset === 0) candidates = page.total;
                  return page.entries;
                },
                test,
              });
              const total = exhausted ? rows.length : Math.max(candidates, rows.length);
              Object.assign(result, { rows: rows.map((e) => e.row), total, matched: total });
            } else if (logSort !== null) {
              const { rows, total } = logRows(
                await read(['logs'], f.files, logRowsQuery(f, logSort, q.limit), signal),
              );
              Object.assign(result, { rows, total, matched: total });
            }
          })(),
        );
      }

      if (needs.has('facets')) {
        parts.push(
          (async () => {
            const keys: readonly CoreFacet[] =
              q.facetKeys === null
                ? CORE_LOG_FACETS
                : CORE_LOG_FACETS.filter((c) => q.facetKeys?.includes(c.key));
            const wantAttrs = q.facetKeys === null || q.facetKeys.some((k) => !CORE_LOG_KEYS.has(k));
            const [core, attrs] = await Promise.all([
              keys.length === 0
                ? null
                : read(['logs'], f.files, coreFacetsQuery(f, 'logs', keys, caps), signal),
              wantAttrs
                ? read(['logs'], f.files, attributeFacetsQuery(f, 'logs', caps, [...CORE_LOG_KEYS]), signal)
                : null,
            ]);
            result.facets = facetCounts(
              core,
              attrs,
              caps,
              [...CORE_LOG_KEYS],
              q.facetKeys === null ? null : new Set(q.facetKeys),
            );
          })(),
        );
      }

      if (needs.has('timeline')) {
        parts.push(
          (async () => {
            result.buckets = logTimeline(
              await read(['logs'], f.files, logTimelineQuery(f, spec), signal),
              spec,
            );
          })(),
        );
      }

      await Promise.all(parts);
      return result;
    };

    return test !== null && residual !== null && useIds
      ? withIds(
          filter,
          residual,
          async (limit) =>
            logEntries(
              await read(
                ['logs'],
                filter.files,
                logRowsQuery(filter, { column: 'time', dir: 'asc' }, limit),
                signal,
              ),
            ).entries,
          test,
          run,
        )
      : run(filter);
  }

  /** The partitions the trace's `traces` rows name; none means the trace is not indexed and every logs file is read. */
  async function logTraceFiles(traceId: TraceId, signal?: AbortSignal): Promise<string[] | null> {
    const partitions = rowsOf(await read(['traces'], undefined, tracePartitionsQuery(traceId), signal)).map(
      (r) => String(cell(r, 'filename')),
    );
    return partitions.length === 0 ? null : partitions;
  }

  async function getLog(ref: LogRef): Promise<LogRow> {
    let query: Query;
    try {
      query = logByRefQuery(ref, manifest);
    } catch (e) {
      // a ref naming a partition without logs is a ref to no log
      if (e instanceof OtelHtmlError && e.code === 'invalid-report') throw noSuchLog(ref);
      throw e;
    }
    // the query filters on the ref's own logs file: only that one is read
    const own = manifest.partitions.find((p) => p.n === refParts(ref).n)?.files.logs?.path;
    // `total` is the partitions the ref's file stands for: none when the ref names a partition without logs
    const pruned = { files: own === undefined ? [] : [own], all: false, total: own === undefined ? 0 : 1 };
    const found = logEntries(await read(['logs'], pruned, query)).entries[0];
    if (found === undefined) throw noSuchLog(ref);
    return found.row;
  }

  async function traceLogs(traceId: TraceId, signal?: AbortSignal): Promise<readonly LogRow[]> {
    throwIfAborted(signal);
    const partitions = await logTraceFiles(traceId, signal);
    const files =
      partitions === null
        ? null
        : partitions.flatMap((p) => {
            const path = manifest.partitions.find((x) => x.n === partitionOfFilename(p))?.files.logs?.path;
            return path === undefined ? [] : [path];
          });
    if (files?.length === 0) return [];
    return logRows(
      await runPrepared(
        engine,
        traceLogsQuery(traceId, files, epoch),
        files ?? filesFor(manifest, ['logs']),
        signal,
      ),
    ).rows;
  }

  async function surroundingLogs(ref: LogRef, n: number): Promise<SurroundingLogs> {
    checkSurroundingCount(n);
    const log = await getLog(ref);
    if (n === 0) return { before: [], log, after: [] };
    const { before, after } = surroundingQueries(log, manifest, n, epoch);
    const [b, a] = await Promise.all([read(['logs'], undefined, before), read(['logs'], undefined, after)]);
    return {
      before: logEntries(b)
        .entries.map((e) => e.row)
        .reverse(), // the query lists nearest first
      log,
      after: logEntries(a).entries.map((e) => e.row),
    };
  }

  async function patterns(q: PatternQuery, signal?: AbortSignal): Promise<PatternsResult> {
    throwIfAborted(signal);
    const column = PATTERN_SORTS.find((c) => c === q.sort.column);
    if (column === undefined) {
      throw new OtelHtmlError('usage', {
        path: 'query.sort.column',
        expected: `one of ${PATTERN_SORTS.join(', ')}`,
        actual: JSON.stringify(q.sort.column),
      });
    }
    return patternRows(
      await read(
        ['patterns'],
        undefined,
        patternsQuery({
          window: absWindow(q.window, epoch),
          sort: { column, dir: q.sort.dir },
          limit: q.limit,
          epoch,
        }),
        signal,
      ),
    );
  }

  /** The trace's spans (and, with `withLogs`, its summed log count): the partitions first, then the spans in them. */
  async function readTrace(
    traceId: TraceId,
    withLogs: boolean,
    signal?: AbortSignal,
  ): Promise<{ rows: SpanRow[]; tables: RowTables; logCount: number }> {
    const traceRows = rowsOf(await read(['traces'], undefined, tracePartitionsQuery(traceId, true), signal));
    const partitions = traceRows.map((r) => String(cell(r, 'filename')));
    if (partitions.length === 0) throw traceNotFound(traceId);
    const bound = traceBoundOf(
      traceRows.map((r) => ({ min_start: cell(r, 'min_start'), max_end: cell(r, 'max_end') })),
    );
    const { filter } = buildFilter({
      manifest,
      table: 'spans',
      condition: null,
      text: '',
      window: null,
      traceId,
      traceFiles: partitions,
    });
    const files = filter.files.files;
    if (files.length === 0) throw traceNotFound(traceId);
    const [spans, summary] = await Promise.all([
      read(['spans'], filter.files, traceSpansQuery(traceId, files, epoch, bound), signal),
      withLogs ? read(['traces'], undefined, traceSummaryQuery(traceId), signal) : null,
    ]);
    const { rows, tables } = spanRows(spans, epoch);
    if (rows.length === 0) throw traceNotFound(traceId);
    const logCount =
      summary === null ? 0 : toNumber(cell(rowsOf(summary)[0] ?? {}, 'log_count') ?? 0n, 'log_count');
    return { rows, tables, logCount };
  }

  async function loadTrace(traceId: TraceId): Promise<TraceDetail> {
    const { rows, tables, logCount } = await readTrace(traceId, true);
    const lookup =
      <T>(list: readonly T[], what: string) =>
      (ref: number): T => {
        const v = list[ref];
        if (v === undefined)
          throw new OtelHtmlError('invalid-report', {
            path: what,
            expected: 'a known ref',
            actual: String(ref),
          });
        return v;
      };
    const resources = lookup<ResourceRecord>(tables.resources, 'trace.resources');
    const scopes = lookup<ScopeRecord>(tables.scopes, 'trace.scopes');
    // §5.5: one row per span id for the table, the counts, the export and the tree alike.
    const spans = dedupeSpanIds(rows);
    return {
      traceId,
      spans,
      tree: buildTraceTree(spans),
      resources: (r: ResourceRef) => resources(r),
      scopes: (s: ScopeRef) => scopes(s),
      logCount,
    };
  }

  let lastTrace: { id: TraceId; detail: Promise<TraceDetail> } | null = null;
  const getTrace = (traceId: TraceId): Promise<TraceDetail> => {
    if (lastTrace?.id === traceId) return lastTrace.detail;
    const detail = loadTrace(traceId).catch((e: unknown) => {
      if (lastTrace?.detail === detail) lastTrace = null; // a failed load is retried on the next use
      throw e;
    });
    lastTrace = { id: traceId, detail };
    return detail;
  };

  return {
    manifest,
    epoch,
    querySpans,
    getTrace,
    hasTrace: async (traceId) =>
      (await read(['traces'], undefined, tracePartitionsQuery(traceId))).numRows > 0,
    async percentileOf(service, resource, durationNs) {
      const r = rowsOf(await read(['spans'], undefined, percentileQuery(service, resource, durationNs)))[0];
      if (r === undefined || toNumber(cell(r, 'n'), 'n') === 0) return null;
      return Number(cell(r, 'percentile'));
    },
    async serviceShare(traceId, signal) {
      // its own load: the open trace's memo stays, and the log summary is not read
      return exclusiveTimeByService(buildTraceTree((await readTrace(traceId, false, signal)).rows));
    },
    services,
    queryLogs,
    getLog,
    traceLogs,
    surroundingLogs,
    patterns,
    async metricPoints(signal) {
      const spec = bucketSpec(null, range);
      return pointBuckets(await read(['points'], undefined, pointsTimelineQuery(spec, epoch), signal), spec);
    },
    async resourceValues(key, opts, signal) {
      throwIfAborted(signal);
      const filterOf = (table: 'spans' | 'logs' | 'points') =>
        buildFilter({ manifest, table, condition: null, text: '', window: opts.window }).filter;
      const windowed =
        opts.window === null
          ? undefined
          : { spans: filterOf('spans'), logs: filterOf('logs'), points: filterOf('points') };
      // each table's kept files are prepared; the rest of the table's files stay unopened
      const files =
        windowed === undefined
          ? filesFor(manifest, ['spans', 'logs', 'points'])
          : (['spans', 'logs', 'points'] as const).flatMap((t) => filesFor(manifest, [t], windowed[t].files));
      return resourceValueResult(
        await runPrepared(engine, resourceValuesQuery(key, caps.facetValueCap, windowed), files, signal),
        caps.facetValueCap,
      );
    },
    ...metricMethods({ engine, manifest, epoch, range }),
    close: () => engine.close(),
  };
}
