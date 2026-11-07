import { and, column, type ExprNode, sql } from '@uwdata/mosaic-sql';
import type { ManifestV4 } from '../../format/manifest.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId, UnixNanos } from '../../model/ids.js';
import type { ResourceRecord, ResourceRef, ScopeRecord, ScopeRef } from '../../model/records.js';
import { type CompiledCondition, compileCondition } from '../../ottl/compile.js';
import { attributeFacetsQuery, CORE_SPAN_FACETS, coreFacetsQuery } from '../../query/sql/facets.js';
import { buildFilter, type SqlFilter } from '../../query/sql/filter.js';
import {
  durationBinsQuery,
  durationSummaryQuery,
  groupStatsQuery,
  percentileQuery,
  type SpanSort,
  serviceBucketsQuery,
  servicesQuery,
  spanRowsQuery,
  type TraceSort,
  timelineQuery,
  tracePartitionsQuery,
  traceRowsQuery,
  traceSpansQuery,
  traceSummaryQuery,
} from '../../query/sql/spans.js';
import { bucketSpec } from '../../query/sql/time.js';
import { FacetCounts } from '../../rollups/facets.js';
import { TimeBuckets } from '../../rollups/time-buckets.js';
import { durationAxis } from '../traces/views.js';
import type { TraceDetail } from './data-source.js';
import { DEFAULT_FACET_CAPS, throwIfAborted } from './query-common.js';
import type { QueryEngine } from './query-engine.js';
import { dropResidualTable, residualIdTable, residualRows } from './residual.js';
import type { DataSource, ServicesResult, SpanNeed, SpanQuery, SpanQueryResult } from './results.js';
import type { TimeWindow } from './span-query.js';
import {
  c,
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
  toNumber,
  traceRows,
} from './span-results.js';
import { traceNotFound } from './trace-detail.js';
import { buildTraceTree, exclusiveTimeByService } from './trace-tree.js';

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
const AGGREGATE_NEEDS: readonly SpanNeed[] = ['facets', 'timeline', 'durations', 'groups'];
const CORE_KEYS: ReadonlySet<string> = new Set(CORE_SPAN_FACETS.map((c) => c.key));

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

function planThree(what: string): OtelHtmlError {
  return new OtelHtmlError('usage', {
    message: `${what} are not available in this viewer yet: metrics over format 4 arrive with plan 3 (D11)`,
  });
}

function emptyResult(caps: typeof DEFAULT_FACET_CAPS, residual: boolean): SpanQueryResult {
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

/** The format-4 data source over a query engine (D19): no Mosaic type appears here. `close()` is `engine.close()`. */
export function createDuckDbDataSource(opts: { engine: QueryEngine; manifest: ManifestV4 }): DataSource {
  const { engine, manifest } = opts;
  const epoch = BigInt(manifest.epochUnixNano);
  const caps = DEFAULT_FACET_CAPS;
  const range =
    manifest.range === null
      ? null
      : {
          start: toNumber(BigInt(manifest.range.start) - epoch, 'range.start'),
          end: toNumber(BigInt(manifest.range.end) - epoch, 'range.end'),
        };

  /** Narrows `filter` to the rows the residual terms accept, through a temp table of their ids (D5). */
  async function withResidualIds<T>(
    filter: SqlFilter,
    residual: string,
    signal: AbortSignal | undefined,
    run: (f: SqlFilter) => Promise<T>,
  ): Promise<T> {
    const test = residualTest(compileCondition(residual, 'span'), epoch);
    const candidates = await engine.query(
      spanRowsQuery(filter, { column: 'start', dir: 'asc' }, RESIDUAL_CANDIDATE_CAP + 1),
      signal,
    );
    const { entries } = spanEntries(candidates, epoch);
    if (entries.length > RESIDUAL_CANDIDATE_CAP) {
      throw new OtelHtmlError('usage', {
        message: `the condition needs the browser to evaluate part of it on more than ${RESIDUAL_CANDIDATE_CAP} spans; narrow the window or the rest of the condition`,
      });
    }
    const survivors = entries.filter(test);
    const table = await residualIdTable(
      engine,
      survivors.map((e) => ({ filename: e.filename, row: e.fileRow })),
    );
    try {
      const ids: ExprNode = sql`(filename, file_row_number) IN (SELECT filename, file_row_number FROM ${column(table)})`;
      return await run({
        ...filter,
        predicate: filter.predicate === null ? ids : and(filter.predicate, ids),
      });
    } finally {
      await dropResidualTable(engine, table).catch(() => undefined);
    }
  }

  async function querySpans(q: SpanQuery, signal?: AbortSignal): Promise<SpanQueryResult> {
    throwIfAborted(signal);
    const { filter, residual } = buildFilter({
      manifest,
      table: 'spans',
      condition: q.condition,
      text: q.text,
      window: q.window,
    });
    const browser = residual !== null;
    if (filter.files.files.length === 0) return emptyResult(caps, browser);
    const needs = new Set(q.needs);
    const aggregates = AGGREGATE_NEEDS.some((n) => needs.has(n));
    const spanSort = q.mode === 'spans' ? sortOf(SPAN_SORTS, q.sort, 'spans') : null;
    const traceSort = q.mode === 'traces' ? sortOf(TRACE_SORTS, q.sort, 'traces') : null;
    const useIds = browser && (aggregates || (q.mode === 'traces' && needs.has('rows')));
    const test = residual === null ? null : residualTest(compileCondition(residual, 'span'), epoch);

    const run = async (f: SqlFilter): Promise<SpanQueryResult> => {
      const result = emptyResult(caps, browser);
      const spec = bucketSpec(q.window, range);
      const parts: Promise<void>[] = [];

      if (needs.has('rows')) {
        parts.push(
          (async () => {
            if (traceSort !== null) {
              const r = traceRows(await engine.query(traceRowsQuery(f, traceSort, q.limit), signal));
              Object.assign(result, r);
            } else if (spanSort !== null && !useIds && test !== null) {
              let candidates = 0;
              const { rows, exhausted } = await residualRows({
                limit: q.limit,
                fetch: async (limit, offset) => {
                  const page = spanEntries(
                    await engine.query(spanRowsQuery(f, spanSort, limit).offset(offset), signal),
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
                spanRows(await engine.query(spanRowsQuery(f, spanSort, q.limit), signal), epoch),
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
              keys.length === 0 ? null : engine.query(coreFacetsQuery(f, 'spans', keys), signal),
              wantAttrs ? engine.query(attributeFacetsQuery(f, 'spans', caps, [...CORE_KEYS]), signal) : null,
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
            const t = timeline(await engine.query(timelineQuery(f, spec), signal), spec);
            result.buckets = t.buckets;
            result.red = t.red;
          })(),
        );
      }

      if (needs.has('durations')) {
        parts.push(
          (async () => {
            const summary = durationSummary(await engine.query(durationSummaryQuery(f), signal));
            if (summary === null) return;
            const edges = durationAxis(
              [{ durationNs: summary.min }, { durationNs: summary.max }],
              DURATION_BIN_COUNT,
            );
            const axis = edges.slice(0, -1).map((from, i) => ({ fromNs: from, toNs: edges[i + 1] ?? from }));
            const bins = durationBins(await engine.query(durationBinsQuery(f, axis), signal), axis);
            result.durations = { summary, bins };
          })(),
        );
      }

      if (needs.has('groups') && q.measureBy !== null) {
        const key = q.measureBy;
        parts.push(
          (async () => {
            result.groups = groupStats(
              await engine.query(groupStatsQuery(f, 'spans', key, caps.facetValueCap), signal),
              caps.facetValueCap,
            );
          })(),
        );
      }

      await Promise.all(parts);
      return result;
    };

    return residual !== null && useIds ? withResidualIds(filter, residual, signal, run) : run(filter);
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
      const found = await engine.query(servicesQuery(f, o.limit + 1), signal);
      const names = rowsOf(found)
        .slice(0, o.limit)
        .map((r) => String(c(r, 'service_name')));
      const buckets =
        names.length === 0 ? null : await engine.query(serviceBucketsQuery(f, names, spec), signal);
      return serviceStats(found, buckets, spec, o.limit);
    };
    return residual === null ? run(filter) : withResidualIds(filter, residual, signal, run);
  }

  async function loadTrace(traceId: TraceId): Promise<TraceDetail> {
    const partitions = rowsOf(await engine.query(tracePartitionsQuery(traceId))).map((r) =>
      String(c(r, 'filename')),
    );
    if (partitions.length === 0) throw traceNotFound(traceId);
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
      engine.query(traceSpansQuery(traceId, files, epoch)),
      engine.query(traceSummaryQuery(traceId)),
    ]);
    const { rows, tables } = spanRows(spans, epoch);
    if (rows.length === 0) throw traceNotFound(traceId);
    const logCount = toNumber(c(rowsOf(summary)[0] ?? {}, 'log_count') ?? 0n, 'log_count');
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
    return {
      traceId,
      spans: rows,
      tree: buildTraceTree(rows),
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
    hasTrace: async (traceId) => (await engine.query(tracePartitionsQuery(traceId))).numRows > 0,
    async percentileOf(service, resource, durationNs) {
      const r = rowsOf(await engine.query(percentileQuery(service, resource, durationNs)))[0];
      if (r === undefined || toNumber(c(r, 'n'), 'n') === 0) return null;
      return Number(c(r, 'percentile'));
    },
    async serviceShare(traceId) {
      return exclusiveTimeByService((await getTrace(traceId)).tree);
    },
    services,
    metricCatalog: () => Promise.reject(planThree('The metric catalog')),
    metric: () => Promise.reject(planThree('Metrics')),
    metricsForResources: () => Promise.reject(planThree('Metrics')),
    close: () => engine.close(),
  };
}
