import {
  and,
  asc,
  column,
  desc,
  type ExprNode,
  eq,
  isIn,
  literal,
  Query,
  sql,
  verbatim,
} from '@uwdata/mosaic-sql';
import { TABLE_COLUMNS } from '../../format/parquet/columns.js';
import type { TraceId } from '../../model/ids.js';
import { jsonAt, jsonKind, jsonStringAt, relTime } from './columns.js';
import { CORE_SPAN_FACETS, truncated } from './facets.js';
import { type SqlFilter, whereOf } from './filter.js';
import { type BucketSpec, bucketExpr } from './time.js';

export interface SpanSort {
  column: 'start' | 'duration' | 'name' | 'service' | 'resource' | 'status';
  dir: 'asc' | 'desc';
}
export interface TraceSort {
  column: 'start' | 'duration' | 'spans' | 'errors' | 'service' | 'resource';
  dir: 'asc' | 'desc';
}

const QUANTILES = sql`quantile_cont(duration_ns, [0.5, 0.95, 0.99])`;
const IS_ERROR = sql`status_code = 2`;
const dirOf = (e: ExprNode | string, dir: 'asc' | 'desc'): ExprNode => (dir === 'asc' ? asc(e) : desc(e));

const SPAN_SORT: Record<SpanSort['column'], string> = {
  start: 'start_time_unix_nano',
  duration: 'duration_ns',
  name: 'name',
  service: 'service_name',
  resource: 'resource_name',
  status: 'status_code',
};
const TRACE_SORT: Record<TraceSort['column'], string> = {
  start: 'start_ns',
  duration: 'duration_ns',
  spans: 'span_count',
  errors: 'error_count',
  service: 'root_service',
  resource: 'root_resource',
};

/**
 * Every spans column with the two times relative to the epoch (`start_ns`, `end_ns`; the absolute columns are not
 * selected), plus `filename` and `file_row_number`.
 */
function spanColumns(epoch: bigint): Record<string, ExprNode> {
  const cols = TABLE_COLUMNS.spans.map((c): [string, ExprNode] =>
    c.name === 'start_time_unix_nano'
      ? ['start_ns', relTime(c.name, epoch)]
      : c.name === 'end_time_unix_nano'
        ? ['end_ns', relTime(c.name, epoch)]
        : [c.name, column(c.name)],
  );
  return Object.fromEntries([
    ...cols,
    ['filename', column('filename')],
    ['file_row_number', column('file_row_number')],
  ]);
}

/** Spans of the filtered set (columns of `spanColumns` plus `total`, the matches before LIMIT), sorted, with a start/span_id tiebreak. */
export function spanRowsQuery(f: SqlFilter, sort: SpanSort, limit: number): Query {
  const terms = whereOf(f, 'spans');
  // a scalar subquery, not `count(*) OVER ()`: the window function would materialise every matching row before the top-N
  const total = Query.from('spans')
    .select({ n: sql`count(*)` })
    .where(...terms);
  return Query.from('spans')
    .select(spanColumns(f.epoch), { total: sql`(${total})` })
    .where(...terms)
    .orderby(
      dirOf(SPAN_SORT[sort.column], sort.dir),
      asc('start_time_unix_nano'),
      asc('span_id'),
      asc('filename'),
      asc('file_row_number'),
    )
    .limit(limit);
}

/**
 * The traces of the matching spans: `traces` aggregated per trace_id over every `traces` file, for the traces with a matching span
 * (a trace split across partitions is one row, whatever the window): `span_count`, `error_count`, `log_count` summed, `start_ns` / `end_ns` the min and
 * max over rows with spans and a time (R33), the root from the row with the smallest start whose `root_name` is set,
 * the lower partition on a tie (R35). Also `duration_ns` and `total`.
 */
export function traceRowsQuery(f: SqlFilter, sort: TraceSort, limit: number): Query {
  const matching = Query.from('spans')
    .select('trace_id')
    .distinct()
    .where(...whereOf(f, 'spans'));
  const timed = sql`span_count > 0 AND start_time_unix_nano IS NOT NULL AND end_time_unix_nano IS NOT NULL`;
  const rooted = sql`root_name IS NOT NULL AND start_time_unix_nano IS NOT NULL`;
  const agg = Query.from('traces')
    .select({
      trace_id: column('trace_id'),
      span_count: sql`CAST(sum(span_count) AS BIGINT)`,
      error_count: sql`CAST(sum(error_count) AS BIGINT)`,
      log_count: sql`CAST(sum(log_count) AS BIGINT)`,
      start_ns: sql`min(${relTime('start_time_unix_nano', f.epoch)}) FILTER (WHERE ${timed})`,
      end_ns: sql`max(${relTime('end_time_unix_nano', f.epoch)}) FILTER (WHERE ${timed})`,
      root: sql`arg_min({'service': root_service, 'name': root_name, 'resource': root_resource}, (start_time_unix_nano, filename)) FILTER (WHERE ${rooted})`,
    })
    .where(sql`trace_id IN (${matching})`)
    .groupby('trace_id');
  const withDuration = Query.from({ agg }).select({
    trace_id: column('trace_id'),
    span_count: column('span_count'),
    error_count: column('error_count'),
    log_count: column('log_count'),
    start_ns: column('start_ns'),
    end_ns: column('end_ns'),
    duration_ns: sql`end_ns - start_ns`,
    root_service: sql`root.service`,
    root_name: sql`root.name`,
    root_resource: sql`root.resource`,
  });
  return Query.from({ t: withDuration })
    .select('*', { total: sql`count(*) OVER ()` })
    .orderby(dirOf(TRACE_SORT[sort.column], sort.dir), asc('trace_id'))
    .limit(limit);
}

/**
 * One row, one column `total`: the number of filtered spans, or in `traces` mode of distinct traces among them. It is
 * what `spanRowsQuery` / `traceRowsQuery` report as `total`, from a statement that reads no span row.
 */
export function spanCountQuery(f: SqlFilter, mode: 'spans' | 'traces'): Query {
  return Query.from('spans')
    .select({ total: mode === 'traces' ? sql`count(DISTINCT trace_id)` : sql`count(*)` })
    .where(...whereOf(f, 'spans'));
}

/**
 * Per bucket of `spec`: `n`, `errors`, `ok` / `error` / `unset` (status 1 / 2 / other), `quantiles` (p50, p95, p99 of
 * `duration_ns`) and `max_duration_ns`, ordered by `bucket` (relative ns). With `latency` false the last two are left
 * out, so the statement never reads the `duration_ns` column.
 */
export function timelineQuery(f: SqlFilter, spec: BucketSpec, latency = true): Query {
  return Query.from('spans')
    .select({
      bucket: bucketExpr('start_time_unix_nano', spec, f.epoch),
      n: sql`count(*)`,
      errors: sql`count(*) FILTER (WHERE ${IS_ERROR})`,
      ok: sql`count(*) FILTER (WHERE status_code = 1)`,
      error: sql`count(*) FILTER (WHERE ${IS_ERROR})`,
      unset: sql`count(*) FILTER (WHERE status_code IS NULL OR status_code NOT IN (1, 2))`,
      ...(latency ? { quantiles: QUANTILES, max_duration_ns: sql`max(duration_ns)` } : {}),
    })
    .where(...whereOf(f, 'spans'))
    .groupby(sql`bucket`)
    .orderby(sql`bucket`);
}

/** `n`, `min_duration_ns`, `max_duration_ns`, `sum_duration_ns` (DOUBLE) and `quantiles` over the filtered spans. */
export function durationSummaryQuery(f: SqlFilter): Query {
  return Query.from('spans')
    .select({
      n: sql`count(*)`,
      min_duration_ns: sql`min(duration_ns)`,
      max_duration_ns: sql`max(duration_ns)`,
      sum_duration_ns: sql`CAST(sum(duration_ns) AS DOUBLE)`,
      quantiles: QUANTILES,
    })
    .where(...whereOf(f, 'spans'));
}

/**
 * Exact counts per `[from, to)` bin of `axis` (contiguous bins, as `durationAxis` builds them): a duration below the
 * first edge counts in the first bin, one at or above the last in the last. Rows (bin, n) for the occupied bins; `bin`
 * indexes `axis`. An empty axis gives no rows.
 */
export function durationBinsQuery(f: SqlFilter, axis: readonly { fromNs: number; toNs: number }[]): Query {
  const inner = axis.slice(0, -1).map((b) => b.toNs);
  const bin =
    inner.length === 0
      ? sql`0`
      : sql`CAST(len(list_filter(${verbatim(`[${inner.join(', ')}]`)}, (e) -> e <= duration_ns)) AS INTEGER)`;
  const q = Query.from('spans')
    .select({ bin, n: sql`count(*)` })
    .where(...whereOf(f, 'spans'))
    .groupby(sql`bin`)
    .orderby(sql`bin`);
  return axis.length === 0 ? q.where(literal(false)) : q;
}

/**
 * Per value of facet `key` (a core facet, else the span attribute of that name): `n`, `errors`, `sum_duration_ns`, `quantiles`,
 * `max_duration_ns`; most frequent first, `cap + 1` rows (the extra one tells the mapper values were dropped).
 */
export function groupStatsQuery(f: SqlFilter, _table: 'spans', key: string, cap: number): Query {
  const core = CORE_SPAN_FACETS.find((c) => c.key === key);
  const expr = truncated(core === undefined ? jsonStringAt('attributes', [key]) : core.expr);
  const grouped = Query.from('spans')
    .select({ value: expr, duration_ns: column('duration_ns'), status_code: column('status_code') })
    .where(...whereOf(f, 'spans'));
  return Query.from({ g: grouped })
    .select({
      value: column('value'),
      n: sql`count(*)`,
      errors: sql`count(*) FILTER (WHERE ${IS_ERROR})`,
      sum_duration_ns: sql`CAST(sum(duration_ns) AS DOUBLE)`,
      quantiles: QUANTILES,
      max_duration_ns: sql`max(duration_ns)`,
    })
    .where(sql`value IS NOT NULL`)
    .groupby('value')
    .orderby(sql`n DESC`, sql`value`)
    .limit(cap + 1);
}

/** The `traces` files that name the trace (one per partition holding a part of it). */
export function tracePartitionsQuery(traceId: TraceId, withBounds = false): Query {
  const byTrace = eq(column('trace_id'), literal(traceId));
  if (!withBounds)
    return Query.from('traces').select('filename').distinct().where(byTrace).orderby('filename');
  const timed = sql`start_time_unix_nano IS NOT NULL AND end_time_unix_nano IS NOT NULL`;
  return Query.from('traces')
    .select({
      filename: column('filename'),
      min_start: sql`min(start_time_unix_nano) FILTER (WHERE ${timed})`,
      max_end: sql`max(end_time_unix_nano) FILTER (WHERE ${timed})`,
    })
    .where(byTrace)
    .groupby('filename')
    .orderby('filename');
}

/** The time range of a trace, absolute nanoseconds: the earliest start and the latest end over the rows of `tracePartitionsQuery(…, true)`. */
export interface TraceBound {
  startNs: bigint;
  endNs: bigint;
}

/** The bound of those rows; null when no row has both times (a trace of logs only), so the span read goes unbounded. */
export function traceBoundOf(rows: readonly Readonly<Record<string, unknown>>[]): TraceBound | null {
  let startNs: bigint | null = null;
  let endNs: bigint | null = null;
  for (const row of rows) {
    const { min_start: lo0, max_end: hi0 } = row as { min_start?: unknown; max_end?: unknown };
    if (lo0 === null || lo0 === undefined || hi0 === null || hi0 === undefined) continue;
    const lo = BigInt(lo0 as bigint | number);
    const hi = BigInt(hi0 as bigint | number);
    if (startNs === null || lo < startNs) startNs = lo;
    if (endNs === null || hi > endNs) endNs = hi;
  }
  return startNs === null || endNs === null ? null : { startNs, endNs };
}

/**
 * Every span of the trace in the given `spans` files (`spanColumns`), by start then span_id. Callers send nothing for no files.
 * With a `bound` (the trace's range from its `traces` rows) the statement also constrains the start time, so row groups
 * outside the range are skipped by their statistics; the bound is inclusive at both ends.
 */
export function traceSpansQuery(
  traceId: TraceId,
  files: readonly string[],
  epoch: bigint,
  bound?: TraceBound | null,
): Query {
  return Query.from('spans')
    .select(spanColumns(epoch))
    .where(
      eq(column('trace_id'), literal(traceId)),
      isIn(
        column('filename'),
        files.map((p) => literal(p)),
      ),
      ...(bound === null || bound === undefined
        ? []
        : [
            sql`start_time_unix_nano BETWEEN ${verbatim(String(bound.startNs))} AND ${verbatim(String(bound.endNs))}`,
          ]),
    )
    .orderby('start_time_unix_nano', 'span_id');
}

/** `span_count` and `log_count` summed over the trace's rows, and `partitions`, the number of those rows. */
export function traceSummaryQuery(traceId: TraceId): Query {
  return Query.from('traces')
    .select({
      span_count: sql`CAST(sum(span_count) AS BIGINT)`,
      log_count: sql`CAST(sum(log_count) AS BIGINT)`,
      partitions: sql`count(*)`,
    })
    .where(eq(column('trace_id'), literal(traceId)));
}

/** The share of the unfiltered spans of this service and resource with a duration at most `durationNs` (`percentile`, 0 to 100) and their number `n`. */
export function percentileQuery(service: string, resource: string, durationNs: number): Query {
  return Query.from('spans')
    .select({
      percentile: sql`count(*) FILTER (WHERE duration_ns <= ${literal(durationNs)}) * 100.0 / count(*)`,
      n: sql`count(*)`,
    })
    .where(and(eq(column('service_name'), literal(service)), eq(column('resource_name'), literal(resource))));
}

/** One row per service: `n`, `errors`, `quantiles`, `max_duration_ns`; busiest first. */
export function servicesQuery(f: SqlFilter, limit: number): Query {
  return Query.from('spans')
    .select({
      service_name: column('service_name'),
      n: sql`count(*)`,
      errors: sql`count(*) FILTER (WHERE ${IS_ERROR})`,
      quantiles: QUANTILES,
      max_duration_ns: sql`max(duration_ns)`,
    })
    .where(...whereOf(f, 'spans'))
    .groupby('service_name')
    .orderby(sql`n DESC`, sql`service_name`)
    .limit(limit);
}

/** (service_name, bucket, n) for the named services over the buckets of `spec`. */
export function serviceBucketsQuery(f: SqlFilter, services: readonly string[], spec: BucketSpec): Query {
  return Query.from('spans')
    .select({
      service_name: column('service_name'),
      bucket: bucketExpr('start_time_unix_nano', spec, f.epoch),
      n: sql`count(*)`,
    })
    .where(
      ...whereOf(f, 'spans'),
      services.length === 0
        ? literal(false)
        : isIn(
            column('service_name'),
            services.map((s) => literal(s)),
          ),
    )
    .groupby('service_name', sql`bucket`)
    .orderby('service_name', sql`bucket`);
}

const SCALAR_KINDS = verbatim(`('string', 'int', 'double', 'bool')`);

/**
 * The distinct scalar values of a resource attribute over spans, logs and points: (`value`, `kind`), `kind` `mixed`
 * when the value's text appears under several kinds; `cap + 1` rows by value. The distinct `resource_attributes` texts
 * are taken first (there are few) and the value is extracted from those, not from every row. The statement has no
 * `WHERE` on purpose: the optimizer pushes an outer `WHERE` below a `DISTINCT` or `UNION`, back onto every row, so the
 * conditions are aggregate `FILTER`s and a `HAVING` (issue #270). `filters`, one per table (the window's files and rows),
 * narrow each branch of the union itself, below the distinct, which is where they cost least.
 */
export function resourceValuesQuery(
  key: string,
  cap: number,
  filters?: Readonly<Record<'spans' | 'logs' | 'points', SqlFilter>>,
): Query {
  // with a window each branch keeps its own rows and files; the outer statement still has no WHERE
  const branch = (table: 'spans' | 'logs' | 'points'): Query => {
    const q = Query.from(table).select('resource_attributes');
    return filters === undefined ? q : q.where(...whereOf(filters[table], table));
  };
  const texts = Query.union(branch('spans'), branch('logs'), branch('points'));
  const extracted = Query.from({ r: texts }).select({
    value: jsonStringAt('resource_attributes', [key]),
    kind: jsonKind(jsonAt('resource_attributes', [key])),
  });
  const scalar = sql`kind IN ${SCALAR_KINDS}`;
  const scalarKind = sql`min(kind) FILTER (WHERE ${scalar})`;
  return Query.from({ u: extracted })
    .select({
      value: column('value'),
      kind: sql`CASE WHEN ${scalarKind} = max(kind) FILTER (WHERE ${scalar}) THEN ${scalarKind} ELSE 'mixed' END`,
    })
    .groupby('value')
    .having(sql`count(*) FILTER (WHERE value IS NOT NULL AND ${scalar}) > 0`)
    .orderby('value')
    .limit(cap + 1);
}
