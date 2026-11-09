import {
  and,
  asc,
  column,
  desc,
  type ExprNode,
  eq,
  gt,
  isIn,
  literal,
  lt,
  Query,
  sql,
  verbatim,
} from '@uwdata/mosaic-sql';
import type { ManifestV4 } from '../../format/manifest.js';
import { TABLE_COLUMNS } from '../../format/parquet/columns.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId } from '../../model/ids.js';
import { LOG_SEVERITY_KEYS, SEVERITY_BANDS } from '../../semconv/severity.js';
import type { LogRef, LogRow } from '../../viewer/data/log-query.js';
import { refParts } from '../../viewer/data/log-query.js';
import { relTime } from './columns.js';
import { type SqlFilter, whereOf } from './filter.js';
import type { AbsWindow } from './prune.js';
import { type BucketSpec, bucketExpr } from './time.js';

export interface LogSort {
  column: 'time' | 'severity' | 'service';
  dir: 'asc' | 'desc';
}
export interface LogTraceSort {
  column: 'first' | 'logs' | 'severity';
  dir: 'asc' | 'desc';
}
export interface PatternSort {
  column: 'count' | 'first' | 'last';
  dir: 'asc' | 'desc';
}

const dirOf = (e: ExprNode | string, dir: 'asc' | 'desc'): ExprNode => (dir === 'asc' ? asc(e) : desc(e));
const big = (n: bigint | number): ExprNode => verbatim(`${n}::BIGINT`);

/** The effective log time relative to the epoch: `coalesce(time, observed, epoch) - epoch`; a log with neither time is 0. */
function effectiveRel(epoch: bigint): ExprNode {
  return sql`(coalesce(time_unix_nano, observed_time_unix_nano, ${big(epoch)}) - ${big(epoch)})`;
}

/** The severity band of a `severity_number` (the bands of `SEVERITY_BANDS`; null or out of range is `unspecified`). */
function bandExpr(): ExprNode {
  const whens = LOG_SEVERITY_KEYS.filter((k) => k !== 'unspecified').map(
    (k) => `WHEN severity_number BETWEEN ${SEVERITY_BANDS[k].min} AND ${SEVERITY_BANDS[k].max} THEN '${k}'`,
  );
  return sql`CASE ${verbatim(whens.join(' '))} ELSE 'unspecified' END`;
}

/**
 * Every logs column with the two times relative (`time_ns`, `observed_ns`, null when absent; the absolute columns are
 * not selected), `time_rel` the effective time, plus `filename` and `file_row_number`.
 */
function logColumns(epoch: bigint): Record<string, ExprNode> {
  const cols = TABLE_COLUMNS.logs.map((c): [string, ExprNode] =>
    c.name === 'time_unix_nano'
      ? ['time_ns', relTime(c.name, epoch)]
      : c.name === 'observed_time_unix_nano'
        ? ['observed_ns', relTime(c.name, epoch)]
        : [c.name, column(c.name)],
  );
  return Object.fromEntries([
    ...cols,
    ['time_rel', effectiveRel(epoch)],
    ['filename', column('filename')],
    ['file_row_number', column('file_row_number')],
  ]);
}

const LOG_SORT: Record<LogSort['column'], string> = {
  time: 'time_rel',
  severity: 'severity_number',
  service: 'service_name',
};

/** Logs of the filtered set (`logColumns` plus `total`, the matches before LIMIT), sorted, then by time, file, row. */
export function logRowsQuery(f: SqlFilter, sort: LogSort, limit: number): Query {
  const terms = whereOf(f, 'logs');
  // a scalar subquery, not `count(*) OVER ()`: the window function would materialise every matching row before the top-N
  const total = Query.from('logs')
    .select({ n: sql`count(*)` })
    .where(...terms);
  return Query.from('logs')
    .select(logColumns(f.epoch), { total: sql`(${total})` })
    .where(...terms)
    .orderby(
      dirOf(LOG_SORT[sort.column], sort.dir),
      asc(sql`time_rel`),
      asc('filename'),
      asc('file_row_number'),
    )
    .limit(limit);
}

/** (`bucket`, `band`, `n`) per bucket of the effective time and severity band (`SEVERITY_BANDS`), by bucket then band. */
export function logTimelineQuery(f: SqlFilter, spec: BucketSpec): Query {
  const inner = Query.from('logs')
    .select({
      eff_time: sql`coalesce(time_unix_nano, observed_time_unix_nano, ${big(f.epoch)})`,
      band: bandExpr(),
    })
    .where(...whereOf(f, 'logs'));
  return Query.from({ l: inner })
    .select({ bucket: bucketExpr('eff_time', spec, f.epoch), band: column('band'), n: sql`count(*)` })
    .groupby(sql`bucket`, 'band')
    .orderby(sql`bucket`, 'band');
}

const TRACE_SORT: Record<LogTraceSort['column'], string> = {
  first: 'first_ns',
  logs: 'log_count',
  severity: 'max_severity',
};

/**
 * Per trace of the matching logs: `log_count`, `first_ns` / `last_ns` (effective time), `max_severity`, `services`
 * (sorted distinct) and `total`, the number of traces.
 */
export function logTracesQuery(f: SqlFilter, sort: LogTraceSort, limit: number): Query {
  const agg = Query.from('logs')
    .select({
      trace_id: column('trace_id'),
      log_count: sql`count(*)`,
      first_ns: sql`min(${effectiveRel(f.epoch)})`,
      last_ns: sql`max(${effectiveRel(f.epoch)})`,
      max_severity: sql`max(severity_number)`,
      services: sql`list_sort(list_distinct(list(service_name)))`,
    })
    .where(...whereOf(f, 'logs'), sql`trace_id IS NOT NULL`)
    .groupby('trace_id');
  return Query.from({ t: agg })
    .select('*', { total: sql`count(*) OVER ()` })
    .orderby(dirOf(TRACE_SORT[sort.column], sort.dir), asc('trace_id'))
    .limit(limit);
}

function logsFileOf(n: number, manifest: ManifestV4): string {
  const path = manifest.partitions.find((p) => p.n === n)?.files.logs?.path;
  if (path === undefined) {
    throw new OtelHtmlError('invalid-report', {
      path: 'log',
      expected: `a partition with a logs file (${n})`,
      actual: 'none',
    });
  }
  return path;
}

/** The one log of the ref (`logColumns`): `filename` of partition n, `file_row_number` i. */
export function logByRefQuery(ref: LogRef, manifest: ManifestV4): Query {
  const { n, i } = refParts(ref);
  return Query.from('logs')
    .select(logColumns(BigInt(manifest.epochUnixNano)))
    .where(
      eq(column('filename'), literal(logsFileOf(n, manifest))),
      eq(column('file_row_number'), literal(i)),
    );
}

/** What the surrounding queries read of the clicked log. */
export type SurroundingTarget = Pick<LogRow, 'n' | 'i' | 'time' | 'service' | 'host'>;

/**
 * The `n` logs of the same service and host (`IS NOT DISTINCT FROM`) strictly before the target in (time, file, row)
 * order, nearest first, and the `n` strictly after, nearest first.
 */
export function surroundingQueries(
  target: SurroundingTarget,
  manifest: ManifestV4,
  n: number,
  epoch: bigint,
): { before: Query; after: Query } {
  const key = sql`(${effectiveRel(epoch)}, filename, file_row_number)`;
  const at = sql`(${big(Number(target.time))}, ${literal(logsFileOf(target.n, manifest))}, ${literal(target.i)}::BIGINT)`;
  const same = [
    sql`service_name IS NOT DISTINCT FROM ${literal(target.service)}`,
    sql`host_name IS NOT DISTINCT FROM ${target.host === null ? sql`NULL` : literal(target.host)}`,
  ];
  const side = (cmp: ExprNode, dir: 'asc' | 'desc'): Query =>
    Query.from('logs')
      .select(logColumns(epoch))
      .where(...same, cmp)
      .orderby(dirOf(sql`time_rel`, dir), dirOf('filename', dir), dirOf('file_row_number', dir))
      .limit(n);
  return { before: side(lt(key, at), 'desc'), after: side(gt(key, at), 'asc') };
}

/** Every log of the trace in the given logs files (all files for null; none for an empty list), by time, file, row. */
export function traceLogsQuery(traceId: TraceId, files: readonly string[] | null, epoch: bigint): Query {
  const terms: ExprNode[] = [eq(column('trace_id'), literal(traceId))];
  if (files !== null) {
    terms.push(
      files.length === 0
        ? literal(false)
        : isIn(
            column('filename'),
            files.map((p) => literal(p)),
          ),
    );
  }
  return Query.from('logs')
    .select(logColumns(epoch))
    .where(and(...terms))
    .orderby(asc(sql`time_rel`), asc('filename'), asc('file_row_number'));
}

const PATTERN_SORT: Record<PatternSort['column'], string> = {
  count: 'count',
  first: 'first_ns',
  last: 'last_ns',
};

/**
 * Patterns combined by template across partitions: `count`, `first_ns` / `last_ns`, `sev_<band>` sums, `sample` of the
 * earliest cluster and `total` (the templates). A window keeps the templates whose combined [first, last] overlaps it.
 */
export function patternsQuery(opts: {
  window: AbsWindow | null;
  sort: PatternSort;
  limit: number;
  epoch: bigint;
}): Query {
  // severity_counts is keyed by severity number ({"9": 2}); a band sums the numbers of its range
  const counted = (n: number): string =>
    `coalesce(TRY_CAST(json_extract_string(CAST(severity_counts AS JSON), '$."${n}"') AS BIGINT), 0)`;
  const bands = Object.fromEntries(
    LOG_SEVERITY_KEYS.map((k): [string, ExprNode] => {
      const { min, max } = SEVERITY_BANDS[k];
      const numbers = Array.from({ length: max - min + 1 }, (_, i) => min + i);
      return [`sev_${k}`, sql`CAST(sum(${verbatim(numbers.map(counted).join(' + '))}) AS BIGINT)`];
    }),
  );
  const grouped = Query.from('patterns')
    .select({
      template: column('template'),
      count: sql`CAST(sum(count) AS BIGINT)`,
      first_abs: sql`min(first_time_unix_nano)`,
      last_abs: sql`max(last_time_unix_nano)`,
      ...bands,
      sample: sql`coalesce(arg_min(sample, first_time_unix_nano), any_value(sample))`,
    })
    .groupby('template');
  if (opts.window !== null) {
    grouped.having(
      sql`max(last_time_unix_nano) >= ${big(opts.window.start)} AND min(first_time_unix_nano) <= ${big(opts.window.end)}`,
    );
  }
  return Query.from({ p: grouped })
    .select(
      '*',
      { first_ns: sql`first_abs - ${big(opts.epoch)}`, last_ns: sql`last_abs - ${big(opts.epoch)}` },
      { total: sql`count(*) OVER ()` },
    )
    .orderby(dirOf(PATTERN_SORT[opts.sort.column], opts.sort.dir), asc('template'))
    .limit(opts.limit);
}

/** (`bucket`, `n`) of the points by `time_unix_nano` (D11), by bucket. */
export function pointsTimelineQuery(spec: BucketSpec, epoch: bigint): Query {
  return Query.from('points')
    .select({ bucket: bucketExpr('time_unix_nano', spec, epoch), n: sql`count(*)` })
    .groupby(sql`bucket`)
    .orderby(sql`bucket`);
}
