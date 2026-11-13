import { and, column, type ExprNode, eq, literal, type Query, sql } from '@uwdata/mosaic-sql';
import type { ManifestV4 } from '../../format/manifest.js';
import type { Table as TableName } from '../../format/parquet/columns.js';
import { durationBucket } from '../../format/parquet/duration-bucket.js';
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
  logCountQuery,
  logRowsQuery,
  logTimelineQuery,
  logTracesQuery,
  type PatternSort,
  patternsQuery,
  pointsTimelineQuery,
  surroundingQueries,
  traceLogsQuery,
} from '../../query/sql/logs.js';
import type { PruneHints } from '../../query/sql/ottl.js';
import { absWindow, type Pruned, prunePartitions } from '../../query/sql/prune.js';
import { idTableRowsQuery } from '../../query/sql/residual.js';
import {
  BAND_KEY,
  facetKeyOf,
  groupKeyOf,
  measuresRelation,
  readsOf,
  resourceAttributesKey,
  rollupDurationBinsQuery,
  rollupDurationsQuery,
  rollupFacetQuery,
  rollupGroupsQuery,
  rollupPercentileQuery,
  rollupResourceValuesQuery,
  rollupTimelineQuery,
  rollupTotalQuery,
  SERVICE_KEY,
  type Split,
  STATUS_KEY,
  splitFiles,
  timeKey,
} from '../../query/sql/rollup.js';
import {
  allTraceCountQuery,
  allTraceRowsQuery,
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
  windowTracePartitionsQuery,
  windowTraceRowsQuery,
} from '../../query/sql/spans.js';
import { bucketSpec } from '../../query/sql/time.js';
import { partitionOfFilename, rollupViewStatements } from '../../query/sql/views.js';
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
import { type RequestShape, type RouteNeed, rawOnly, routeOf } from './route.js';
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
import { alignLongWindow, isLongWindow, type TimeWindow } from './time-window.js';
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
const LOG_AGGREGATE_NEEDS: readonly LogNeed[] = ['facets', 'timeline', 'total'];

/** A filter with no predicate, text, residual or window: the trace list needs no span to say which traces match. */
const unconditioned = (f: SqlFilter): boolean => f.predicate === null && f.text === null && f.window === null;
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

/** The newest data source made over each engine: the one whose manifest the rollup views follow. */
const generations = new WeakMap<QueryEngine, number>();

/** The format-4 data source over a query engine (D19): no Mosaic type appears here. `close()` is `engine.close()`. */
export function createDuckDbDataSource(opts: {
  engine: QueryEngine;
  manifest: ManifestV4;
  /** Where a failed cleanup of the D5 temp table is reported; silent without one. */
  logger?: Pick<Console, 'warn'>;
  /** The facet and resource-value caps; the manifest's (the writer's), or the defaults for a report without them. */
  caps?: FacetCaps;
  /** The source of a Refresh: its first rollup statement binds the rollup views to its manifest even if some exist. */
  replaceRollupViews?: boolean;
}): DataSource {
  const { engine, manifest } = opts;
  // A newer source over the same engine owns the rollup views: this one may not bind them any more (a Refresh happened).
  const generation = (generations.get(engine) ?? 0) + 1;
  generations.set(engine, generation);
  const epoch = BigInt(manifest.epochUnixNano);
  const { facetValueCap, facetKeyCap } = manifest.config.viewer;
  const caps: FacetCaps = opts.caps ?? {
    facetValueCap: facetValueCap ?? DEFAULT_FACET_CAPS.facetValueCap,
    facetKeyCap: facetKeyCap ?? DEFAULT_FACET_CAPS.facetKeyCap,
  };
  const range = manifestRange(manifest);

  /** The long-window rules (spec §6.3) for `window`: the window aligned outward to grains, and the options that carry the rule. */
  const rules = (
    window: TimeWindow | null,
  ): { window: TimeWindow | null; long: boolean; bucketLong: { epoch: bigint } | undefined } => {
    const long = isLongWindow(window, range);
    return {
      window: long && window !== null ? alignLongWindow(window, epoch) : window,
      long,
      bucketLong: long ? { epoch } : undefined,
    };
  };

  /** Runs `q` after the engine prepared the files it reads: `tables` whole, the first one narrowed to `pruned`. */
  const read = (
    tables: readonly TableName[],
    pruned: Pruned | undefined,
    q: Query,
    signal?: AbortSignal,
  ): ReturnType<QueryEngine['query']> => runPrepared(engine, q, filesFor(manifest, tables, pruned), signal);

  /**
   * The views of the rollup tables are bound by the first statement that reads a rollup file: binding reads every
   * file's footer, which a page that never asks for a rollup should not pay, and a Refresh forgets them (`createViews`)
   * so the next one binds the new list. A host has made every view already and runs no DDL.
   */
  let rollupViews: Promise<void> | null = null;
  const ensureRollupViews = (): Promise<void> => {
    if (!engine.tempTables) return Promise.resolve();
    rollupViews ??= (async () => {
      for (const statement of rollupViewStatements(manifest, (p) => p, opts.replaceRollupViews === true)) {
        if (generations.get(engine) !== generation)
          throw new DOMException('A newer data source owns the rollup views', 'AbortError');
        await engine.exec(statement);
      }
    })().catch((error: unknown) => {
      rollupViews = null;
      throw error;
    });
    return rollupViews;
  };

  /** Runs a statement over a measures relation: the rollup files are loaded, the views bound, then the statement runs. */
  const readMeasures = async (
    split: Split,
    q: Query,
    signal?: AbortSignal,
  ): ReturnType<QueryEngine['query']> => {
    if (split.rollup.length > 0) {
      await engine.prepare(split.rollup, signal);
      await ensureRollupViews();
    }
    return runPrepared(engine, q, [...split.rollup, ...split.raw], signal);
  };

  /**
   * The files of a need the router sends to `measures` (rollup files, and the base files of the partitions without a
   * usable rollup), or null when it runs today's statement. `extra` is what the need itself reads beside the condition.
   */
  const planOf = (
    p: {
      table: 'spans' | 'logs';
      mode: RequestShape['mode'];
      long: boolean;
      conditionReads: ReadonlySet<string>;
      hints: PruneHints;
      residual: boolean;
      text: boolean;
    },
    f: SqlFilter,
    need: RouteNeed,
    extra: readonly string[],
    durations: boolean,
  ): Split | null => {
    const shape: RequestShape = {
      table: p.table,
      need,
      mode: p.mode,
      long: p.long,
      reads: new Set([...p.conditionReads, ...extra]),
      residual: p.residual,
      text: p.text,
    };
    if (routeOf(shape) === 'direct') return null;
    return splitFiles(manifest, p.table, f.files, shape.reads, {
      durations,
      rawOnly: rawOnly(shape),
      prune: { hints: p.hints, window: f.window, long: p.long },
    });
  };

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
    candidates: () => Promise<SqlFilter> = () => Promise.resolve(filter),
  ): Promise<T> =>
    withIds(
      filter,
      residual,
      async (limit) => {
        const from = await candidates();
        return spanEntries(
          await read(
            ['spans'],
            from.files,
            spanRowsQuery(from, { column: 'start', dir: 'asc' }, limit),
            signal,
          ),
          epoch,
        ).entries;
      },
      test,
      run,
    );

  async function querySpans(q: SpanQuery, signal?: AbortSignal): Promise<SpanQueryResult> {
    throwIfAborted(signal);
    checkLimit(q.limit);
    const rule = rules(q.window);
    const { filter, residual, reads, hints } = buildFilter({
      manifest,
      table: 'spans',
      condition: q.condition,
      text: q.text,
      window: rule.window,
      long: rule.long,
    });
    const browser = residual !== null;
    // a trace list under a long window reads spans files the window itself prunes (a trace belongs to the window by its first span)
    const windowedTraces =
      rule.long &&
      filter.window !== null &&
      q.mode === 'traces' &&
      (q.needs.includes('rows') || q.needs.includes('total'));
    if (filter.files.files.length === 0 && !windowedTraces) return emptyResult(caps, residual);
    const plan = (f: SqlFilter, need: RouteNeed, extra: readonly string[], durations: boolean) =>
      planOf(
        {
          table: 'spans',
          mode: q.mode,
          long: rule.long,
          conditionReads: reads,
          hints,
          residual: browser,
          text: q.text !== '',
        },
        f,
        need,
        extra,
        durations,
      );
    const needs = new Set(q.needs);
    const aggregates = AGGREGATE_NEEDS.some((n) => needs.has(n));
    const spanSort = q.mode === 'spans' ? sortOf(SPAN_SORTS, q.sort, 'spans') : null;
    const traceSort = q.mode === 'traces' ? sortOf(TRACE_SORTS, q.sort, 'traces') : null;
    const useIds = browser && (aggregates || (q.mode === 'traces' && needs.has('rows')));
    const test = residual === null ? null : residualTest(compileCondition(residual, 'span'), epoch);

    /**
     * The trace list. Under a long window a trace belongs to the window its earliest span start (over all its
     * partitions) falls in: `traces` alone answers a list with no condition or text, and with one the partitions of the
     * traces that start in the window are named first, then the condition is read from their spans files only. Every
     * `traces` file is read either way (a row before the window decides that a trace started before it).
     */
    const namedSpans = async (
      f: SqlFilter,
      window: NonNullable<SqlFilter['window']>,
      traces: Pruned,
    ): Promise<Pruned> => {
      const named = new Set(
        rowsOf(await read(['traces'], undefined, windowTracePartitionsQuery(traces, window), signal)).map(
          (r) => partitionOfFilename(String(cell(r, 'filename'))),
        ),
      );
      // the spans files of those partitions, whatever the window says of each (the hints only prune the others)
      const spans = prunePartitions(manifest, 'spans', hints, null).files.filter((p) =>
        named.has(partitionOfFilename(p)),
      );
      return { files: spans, all: false, total: f.files.total };
    };
    const traceList = async (
      f: SqlFilter,
      sort: TraceSort,
      limit = q.limit,
    ): ReturnType<QueryEngine['query']> => {
      const { window } = f;
      if (!rule.long || window === null) {
        return unconditioned(f)
          ? read(['traces'], undefined, allTraceRowsQuery(f, sort, limit), signal)
          : read(['spans', 'traces'], f.files, traceRowsQuery(f, sort, limit), signal);
      }
      if (f.predicate === null && f.text === null) {
        return read(['traces'], undefined, allTraceRowsQuery(f, sort, limit, window), signal);
      }
      const traces = prunePartitions(manifest, 'traces', new Map(), null);
      const own: SqlFilter = { ...f, files: await namedSpans(f, window, traces) };
      return read(['spans', 'traces'], own.files, windowTraceRowsQuery(own, traces, sort, limit), signal);
    };

    const run = async (f: SqlFilter): Promise<SpanQueryResult> => {
      const result = emptyResult(caps, residual);
      const spec = bucketSpec(rule.window, range, undefined, rule.bucketLong);
      const parts: Promise<void>[] = [];

      if (needs.has('rows')) {
        parts.push(
          (async () => {
            if (traceSort !== null) {
              const r = traceRows(await traceList(f, traceSort));
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
            // the router decides by the need alone: every key is measured, or none is
            const measured = keys.flatMap((k) => {
              const split = plan(f, 'facets', [k.reads], false);
              return split === null ? [] : [{ k, split }];
            });
            const [core, attrs] = await Promise.all([
              keys.length === 0
                ? null
                : measured.length === 0
                  ? read(['spans'], f.files, coreFacetsQuery(f, 'spans', keys, caps), signal)
                  : Promise.all(
                      measured.map(({ k, split }) => {
                        const key = facetKeyOf(k);
                        const rel = measuresRelation(f, 'spans', split, [key], false);
                        return readMeasures(split, rollupFacetQuery(rel, key, caps.facetValueCap), signal);
                      }),
                    ),
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
            const split = plan(f, 'timeline', readsOf([STATUS_KEY]), true);
            const table =
              split === null
                ? await read(['spans'], f.files, timelineQuery(f, spec), signal)
                : await readMeasures(
                    split,
                    rollupTimelineQuery(
                      measuresRelation(f, 'spans', split, [timeKey('spans', epoch), STATUS_KEY], true),
                      spec,
                      epoch,
                      null,
                    ),
                    signal,
                  );
            const t = timeline(table, spec);
            result.buckets = t.buckets;
            result.red = t.red;
          })(),
        );
      } else if (needs.has('buckets')) {
        // The counts alone: the statement leaves out the latency columns, and `red` keeps its empty value.
        parts.push(
          (async () => {
            const split = plan(f, 'buckets', readsOf([STATUS_KEY]), false);
            result.buckets = timelineBuckets(
              split === null
                ? await read(['spans'], f.files, timelineQuery(f, spec, false), signal)
                : await readMeasures(
                    split,
                    rollupTimelineQuery(
                      measuresRelation(f, 'spans', split, [timeKey('spans', epoch), STATUS_KEY], false),
                      spec,
                      epoch,
                      null,
                      { latency: false },
                    ),
                    signal,
                  ),
              spec,
            );
          })(),
        );
      }

      if (needs.has('total') && !needs.has('rows')) {
        // The match count alone, as `rows` would report it; with `rows` asked its statement sets the total.
        parts.push(
          (async () => {
            const split = plan(f, 'total', [], false);
            const t =
              split === null
                ? q.mode === 'traces' && rule.long && f.window !== null
                  ? f.predicate === null && f.text === null
                    ? await read(['traces'], undefined, allTraceCountQuery(f.window), signal)
                    : // by the trace's start, as the list's total is
                      await traceList(f, traceSort ?? { column: 'start', dir: 'asc' }, 1)
                  : await read(['spans'], f.files, spanCountQuery(f, q.mode), signal)
                : await readMeasures(
                    split,
                    rollupTotalQuery(measuresRelation(f, 'spans', split, [], false)),
                    signal,
                  );
            result.total = toNumber(cell(rowsOf(t)[0] ?? {}, 'total') ?? 0n, 'total');
          })(),
        );
      }

      if (needs.has('durations')) {
        parts.push(
          (async () => {
            const split = plan(f, 'durations', [], true);
            const measured =
              split === null ? null : { split, rel: () => measuresRelation(f, 'spans', split, [], true) };
            const summary = durationSummary(
              measured === null
                ? await read(['spans'], f.files, durationSummaryQuery(f), signal)
                : await readMeasures(measured.split, rollupDurationsQuery(measured.rel()), signal),
            );
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
              measured === null
                ? await read(['spans'], f.files, durationBinsQuery(f, axis), signal)
                : await readMeasures(measured.split, rollupDurationBinsQuery(measured.rel(), axis), signal),
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
            const by = groupKeyOf(key);
            const split = plan(f, 'groups', readsOf([by, STATUS_KEY]), true);
            result.groups = groupStats(
              split === null
                ? await read(['spans'], f.files, groupStatsQuery(f, 'spans', key, caps.facetValueCap), signal)
                : await readMeasures(
                    split,
                    rollupGroupsQuery(measuresRelation(f, 'spans', split, [by, STATUS_KEY], true), [by], {
                      limit: caps.facetValueCap + 1,
                      nonNull: true,
                    }),
                    signal,
                  ),
              caps.facetValueCap,
            );
          })(),
        );
      }

      await Promise.all(parts);
      return result;
    };

    // under a long window a trace is listed or counted by its own start: the candidates are the spans of those traces
    const traceScope = async (): Promise<SqlFilter> => {
      const { window } = filter;
      if (!windowedTraces || window === null) return filter;
      const files = await namedSpans(filter, window, prunePartitions(manifest, 'traces', new Map(), null));
      return { ...filter, window: null, files };
    };
    return test !== null && residual !== null && useIds
      ? withResidualIds(filter, residual, test, signal, run, traceScope)
      : run(filter);
  }

  async function services(
    o: { window: TimeWindow | null; condition: string | null; limit: number },
    signal?: AbortSignal,
  ): Promise<ServicesResult> {
    throwIfAborted(signal);
    const rule = rules(o.window);
    const { filter, residual, reads, hints } = buildFilter({
      manifest,
      table: 'spans',
      condition: o.condition,
      text: '',
      window: rule.window,
      long: rule.long,
    });
    if (filter.files.files.length === 0) return { services: [], total: 0 };
    const spec = bucketSpec(rule.window, range, undefined, rule.bucketLong);
    const plan = (f: SqlFilter, durations: boolean) =>
      planOf(
        {
          table: 'spans',
          mode: 'spans',
          long: rule.long,
          conditionReads: reads,
          hints,
          residual: residual !== null,
          text: false,
        },
        f,
        'services',
        readsOf(durations ? [SERVICE_KEY, STATUS_KEY] : [SERVICE_KEY]),
        durations,
      );
    const run = async (f: SqlFilter): Promise<ServicesResult> => {
      const split = plan(f, true);
      const found =
        split === null
          ? await read(['spans'], f.files, servicesQuery(f, o.limit + 1), signal)
          : await readMeasures(
              split,
              rollupGroupsQuery(
                measuresRelation(f, 'spans', split, [SERVICE_KEY, STATUS_KEY], true),
                [SERVICE_KEY],
                {
                  limit: o.limit + 1,
                },
              ),
              signal,
            );
      const names = rowsOf(found)
        .slice(0, o.limit)
        .map((r) => String(cell(r, 'service_name')));
      const bucketSplit = plan(f, false);
      const buckets =
        names.length === 0
          ? null
          : bucketSplit === null
            ? await read(['spans'], f.files, serviceBucketsQuery(f, names, spec), signal)
            : await readMeasures(
                bucketSplit,
                rollupTimelineQuery(
                  measuresRelation(f, 'spans', bucketSplit, [SERVICE_KEY, timeKey('spans', epoch)], false),
                  spec,
                  epoch,
                  SERVICE_KEY,
                  { only: names },
                ),
                signal,
              );
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
    const rule = rules(q.window);
    const { filter, residual, reads, hints } = buildFilter({
      manifest,
      table: 'logs',
      condition: q.condition,
      text: q.text,
      window: rule.window,
      long: rule.long,
      ...(q.traceId == null
        ? {}
        : { traceId: q.traceId, traceFiles: (await logTraceFiles(q.traceId, signal)) ?? allLogsFiles }),
    });
    const browser = residual !== null;
    if (filter.files.files.length === 0) return emptyLogResult(caps, residual, q.mode);
    const plan = (f: SqlFilter, need: RouteNeed, extra: readonly string[]) =>
      planOf(
        {
          table: 'logs',
          mode: q.mode === 'traces' ? 'traces' : 'logs',
          long: rule.long,
          conditionReads: reads,
          hints,
          residual: browser,
          text: q.text !== '',
        },
        f,
        need,
        extra,
        false,
      );
    const needs = new Set(q.needs);
    const aggregates = LOG_AGGREGATE_NEEDS.some((n) => needs.has(n));
    const logSort = q.mode === 'logs' ? sortOf(LOG_SORTS, q.sort, 'logs') : null;
    const traceSort = q.mode === 'traces' ? sortOf(LOG_TRACE_SORTS, q.sort, 'traces') : null;
    const useIds = browser && (aggregates || (q.mode === 'traces' && needs.has('rows')));
    const test = residual === null ? null : logResidualTest(compileCondition(residual, 'log_record'), epoch);

    const run = async (f: SqlFilter): Promise<LogQueryResult> => {
      const result = emptyLogResult(caps, residual, q.mode);
      const spec = bucketSpec(rule.window, range, undefined, rule.bucketLong);
      const parts: Promise<void>[] = [];

      if (needs.has('rows')) {
        parts.push(
          (async () => {
            if (traceSort !== null) {
              const r = logTraceRows(
                await read(['logs'], f.files, logTracesQuery(f, traceSort, q.limit), signal),
              );
              Object.assign(result, { rows: r.rows, total: r.total });
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

      // The counts alone; logs mode with `rows` asked has them from the rows statement, traces mode never does.
      if (needs.has('total') && (!needs.has('rows') || q.mode === 'traces')) {
        parts.push(
          (async () => {
            const split = plan(f, 'total', []);
            if (split !== null) {
              // logs mode only (the router keeps the distinct traces direct): n and matched are the one count
              const t = await readMeasures(
                split,
                rollupTotalQuery(measuresRelation(f, 'logs', split, [], false)),
                signal,
              );
              const count = toNumber(cell(rowsOf(t)[0] ?? {}, 'total') ?? 0n, 'total');
              result.matched = count;
              result.total = count;
              return;
            }
            const row =
              rowsOf(
                await read(
                  ['logs'],
                  f.files,
                  logCountQuery(f, q.mode === 'traces' ? 'traces' : 'logs'),
                  signal,
                ),
              )[0] ?? {};
            result.matched = toNumber(cell(row, 'matched') ?? 0n, 'matched');
            // with `rows` asked (traces mode) its statement set the total already
            if (!needs.has('rows')) result.total = toNumber(cell(row, 'n') ?? 0n, 'n');
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
            const measured = keys.flatMap((k) => {
              const split = plan(f, 'facets', [k.reads]);
              return split === null ? [] : [{ k, split }];
            });
            const [core, attrs] = await Promise.all([
              keys.length === 0
                ? null
                : measured.length === 0
                  ? read(['logs'], f.files, coreFacetsQuery(f, 'logs', keys, caps), signal)
                  : Promise.all(
                      measured.map(({ k, split }) => {
                        const key = facetKeyOf(k);
                        const rel = measuresRelation(f, 'logs', split, [key], false);
                        return readMeasures(split, rollupFacetQuery(rel, key, caps.facetValueCap), signal);
                      }),
                    ),
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
            const split = plan(f, 'timeline', readsOf([BAND_KEY]));
            result.buckets = logTimeline(
              split === null
                ? await read(['logs'], f.files, logTimelineQuery(f, spec), signal)
                : await readMeasures(
                    split,
                    rollupTimelineQuery(
                      measuresRelation(f, 'logs', split, [timeKey('logs', epoch), BAND_KEY], false),
                      spec,
                      epoch,
                      BAND_KEY,
                    ),
                    signal,
                  ),
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
    let { rows, tables } = spanRows(spans, epoch);
    if (bound !== null) {
      // A span whose end is before its start can lie outside the bound (the bound is [min start, max end]): when the
      // traces rows count more spans than came back, read again without the bound. Only malformed traces pay this.
      const expected = traceRows.reduce((n, r) => n + Number(cell(r, 'span_count') ?? 0n), 0);
      if (rows.length < expected)
        ({ rows, tables } = spanRows(
          await read(['spans'], filter.files, traceSpansQuery(traceId, files, epoch), signal),
          epoch,
        ));
    }
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
      const long = isLongWindow(null, range);
      let result: Awaited<ReturnType<QueryEngine['query']>>;
      if (long) {
        // the report's range is long: the share is counted over the rollups (a duration bucket is counted whole)
        const { filter } = buildFilter({
          manifest,
          table: 'spans',
          condition: null,
          text: '',
          window: null,
          long,
        });
        const f: SqlFilter = {
          ...filter,
          predicate: and(
            eq(column('service_name'), literal(service)),
            eq(column('resource_name'), literal(resource)),
          ),
        };
        const split = splitFiles(manifest, 'spans', f.files, new Set(['service_name', 'resource_name']), {
          durations: true,
          rawOnly: false,
        });
        const bucket = durationBucket(BigInt(Math.max(0, Math.floor(durationNs))));
        result = await readMeasures(
          split,
          rollupPercentileQuery(measuresRelation(f, 'spans', split, [], true), bucket),
        );
      } else {
        result = await read(['spans'], undefined, percentileQuery(service, resource, durationNs));
      }
      const r = rowsOf(result)[0];
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
      const rule = rules(opts.window);
      const built = (table: 'spans' | 'logs' | 'points') =>
        buildFilter({
          manifest,
          table,
          condition: null,
          text: '',
          window: rule.window,
          long: rule.long,
        });
      const filterOf = (table: 'spans' | 'logs' | 'points') => built(table).filter;
      const windowed =
        rule.window === null
          ? undefined
          : { spans: filterOf('spans'), logs: filterOf('logs'), points: filterOf('points') };
      if (rule.long || opts.window === null) {
        // a long window, or none (the whole report, long or not): the spans and logs parts come from the rollups that keep the key
        const reads = new Set([`resource:${key}`]);
        const attributes = [resourceAttributesKey(key)];
        const part = (table: 'spans' | 'logs'): { split: Split; rel: Query } => {
          const { filter, hints } = built(table);
          const split = splitFiles(manifest, table, filter.files, reads, {
            durations: false,
            rawOnly: false,
            prune: { hints, window: filter.window, long: true },
          });
          return { split, rel: measuresRelation(filter, table, split, attributes, false) };
        };
        const spans = part('spans');
        const logs = part('logs');
        const points = built('points').filter;
        const rollups = [...spans.split.rollup, ...logs.split.rollup];
        if (rollups.length > 0) {
          await engine.prepare(rollups, signal);
          await ensureRollupViews();
        }
        return resourceValueResult(
          await runPrepared(
            engine,
            rollupResourceValuesQuery([spans.rel, logs.rel], key, caps.facetValueCap, points),
            [
              ...rollups,
              ...spans.split.raw,
              ...logs.split.raw,
              ...filesFor(manifest, ['points'], points.files),
            ],
            signal,
          ),
          caps.facetValueCap,
        );
      }
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
