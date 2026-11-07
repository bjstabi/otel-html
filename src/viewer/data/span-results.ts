import type { Table } from '@uwdata/flechette';
import {
  type DecodedShared,
  type ResultRow,
  SharedInterner,
  spanFromRow,
} from '../../format/parquet/decode.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId } from '../../model/ids.js';
import type { SpanRecord } from '../../model/records.js';
import type { BucketSpec } from '../../query/sql/time.js';
import { FacetCounts } from '../../rollups/facets.js';
import type { SpanStatusKey } from '../../rollups/span-rollups.js';
import { TimeBuckets } from '../../rollups/time-buckets.js';
import type { FacetCaps } from './query-common.js';
import type {
  DurationBin,
  DurationSummary,
  GroupStats,
  GroupStatsResult,
  RedBuckets,
  RowTables,
  ServiceStats,
  ServicesResult,
  SpanRow,
  TraceRow,
} from './results.js';

const MAX_BUCKETS = 4096;
const STATUS_KEYS: readonly SpanStatusKey[] = ['ok', 'error', 'unset'];

const bad = (path: string, expected: string, actual: unknown): OtelHtmlError =>
  new OtelHtmlError('invalid-report', {
    path,
    expected,
    actual: typeof actual === 'bigint' ? actual.toString() : (JSON.stringify(actual) ?? String(actual)),
  });

/** bigint to number; throws `invalid-report` when the value is not a safe integer (D2: never a silent rounding). */
export function toNumber(v: unknown, path: string): number {
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw bad(path, 'an integer within 2^53', v);
    }
    return Number(v);
  }
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  throw bad(path, 'an integer within 2^53', v);
}

/** A DOUBLE (quantile, sum) or an integer column as a number; null stays null. */
function real(v: unknown, path: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return toNumber(v, path);
}

/** One cell of a result row. */
export const c = (row: ResultRow, name: string): unknown => row[name];

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The rows of a result as plain objects (column name to value). */
export function rowsOf(t: Table): ResultRow[] {
  return t.toArray() as ResultRow[];
}

function quantiles(v: unknown, path: string): [number | null, number | null, number | null] {
  if (v === null || v === undefined) return [null, null, null];
  const list = Array.from(v as ArrayLike<unknown>);
  return [real(list[0], `${path}[0]`), real(list[1], `${path}[1]`), real(list[2], `${path}[2]`)];
}

/** A span row of a query result, before its resource and scope are interned. */
export interface SpanEntry {
  /** `resource` and `scope` are 0 placeholders; use `internRows`. */
  span: SpanRecord;
  service: string;
  resource: string;
  durationNs: number;
  shared: DecodedShared;
  filename: string;
  fileRow: number;
}

/** Decodes the rows of `spanRowsQuery` / `traceSpansQuery` (times already relative; `start_ns`, `end_ns`). */
export function spanEntries(t: Table, epoch: bigint): { entries: SpanEntry[]; total: number } {
  const rows = rowsOf(t);
  const entries = rows.map((row): SpanEntry => {
    const { span, shared } = spanFromRow(
      { ...row, start_time_unix_nano: c(row, 'start_ns'), end_time_unix_nano: c(row, 'end_ns') },
      epoch,
    );
    return {
      span,
      service: text(c(row, 'service_name')),
      resource: text(c(row, 'resource_name')),
      durationNs: toNumber(c(row, 'duration_ns'), 'duration_ns'),
      shared,
      filename: text(c(row, 'filename')),
      fileRow: toNumber(c(row, 'file_row_number'), 'file_row_number'),
    };
  });
  const first = rows[0];
  return {
    entries,
    total:
      first === undefined || c(first, 'total') === undefined
        ? entries.length
        : toNumber(c(first, 'total'), 'total'),
  };
}

/** Rows with report-wide resource and scope refs into the returned tables. */
export function internRows(entries: readonly SpanEntry[]): { rows: SpanRow[]; tables: RowTables } {
  const interner = new SharedInterner();
  const rows = entries.map(
    (e): SpanRow => ({
      span: {
        ...e.span,
        resource: interner.resource(e.shared.resource),
        scope: interner.scope(e.shared.scope),
      },
      service: e.service,
      resource: e.resource,
      durationNs: e.durationNs,
    }),
  );
  return { rows, tables: { resources: interner.resources, scopes: interner.scopes } };
}

export function spanRows(t: Table, epoch: bigint): { rows: SpanRow[]; total: number; tables: RowTables } {
  const { entries, total } = spanEntries(t, epoch);
  return { ...internRows(entries), total };
}

/** The rows of `traceRowsQuery`; a trace without a timed span row has start and duration 0, one without a root has no `rootSummary`. */
export function traceRows(t: Table): { rows: TraceRow[]; total: number } {
  const rows = rowsOf(t);
  const out = rows.map(
    (r): TraceRow => ({
      traceId: text(c(r, 'trace_id')) as TraceId,
      rootSummary:
        typeof c(r, 'root_name') === 'string'
          ? {
              service: text(c(r, 'root_service')),
              name: text(c(r, 'root_name')),
              resource: text(c(r, 'root_resource')),
            }
          : null,
      start: real(c(r, 'start_ns'), 'start_ns') ?? 0,
      durationNs: real(c(r, 'duration_ns'), 'duration_ns') ?? 0,
      spans: toNumber(c(r, 'span_count'), 'span_count'),
      errors: toNumber(c(r, 'error_count'), 'error_count'),
    }),
  );
  const first = rows[0];
  return { rows: out, total: first === undefined ? 0 : toNumber(c(first, 'total'), 'total') };
}

/**
 * `FacetCounts` from the core facet rows (key, value, n) and the attribute rows (key, kind, value, n, total). Core
 * values past `valueCap` count under `other`; attribute rows are already capped by the query (`other` is `total` minus
 * what is listed). `only` keeps just those keys.
 */
export function facetCounts(
  core: Table | null,
  attrs: Table | null,
  caps: FacetCaps,
  pinned: readonly string[],
  only: ReadonlySet<string> | null = null,
): FacetCounts {
  interface Key {
    key: string;
    kind: 'string' | 'int' | 'double' | 'bool' | 'mixed';
    total: number;
    other: number;
    values: [string, number][];
  }
  const keys = new Map<string, Key>();
  const coreKeys = new Set<string>();
  for (const r of core === null ? [] : rowsOf(core)) {
    const key = text(c(r, 'key'));
    if (only !== null && !only.has(key)) continue;
    coreKeys.add(key);
    const n = toNumber(c(r, 'n'), 'n');
    let k = keys.get(key);
    if (k === undefined) {
      k = { key, kind: 'string', total: 0, other: 0, values: [] };
      keys.set(key, k);
    }
    k.total += n;
    if (k.values.length < caps.facetValueCap) k.values.push([text(c(r, 'value')), n]);
    else k.other += n;
  }
  for (const r of attrs === null ? [] : rowsOf(attrs)) {
    const key = text(c(r, 'key'));
    if ((only !== null && !only.has(key)) || coreKeys.has(key)) continue;
    let k = keys.get(key);
    if (k === undefined) {
      k = { key, kind: kindOf(c(r, 'kind')), total: toNumber(c(r, 'total'), 'total'), other: 0, values: [] };
      keys.set(key, k);
    }
    k.values.push([text(c(r, 'value')), toNumber(c(r, 'n'), 'n')]);
  }
  for (const k of keys.values()) {
    const listed = k.values.reduce((s, [, n]) => s + n, 0);
    // attribute keys carry the query's total; core keys were summed above
    if (k.total > listed + k.other) k.other = k.total - listed;
  }
  return FacetCounts.from(
    {
      valueCap: caps.facetValueCap,
      keyCap: caps.facetKeyCap,
      pinned: [...pinned],
      skippedKeyAdds: 0,
      keys: [...keys.values()],
    },
    'facets',
  );
}

function kindOf(v: unknown): 'string' | 'int' | 'double' | 'bool' | 'mixed' {
  return v === 'int' || v === 'double' || v === 'bool' || v === 'mixed' ? v : 'string';
}

interface Grid {
  start: number;
  length: number;
}

/** The dense grid from the first to the last occupied bucket of `buckets` (relative ns, aligned to `width`). */
function gridOf(buckets: readonly number[], width: number): Grid | null {
  if (buckets.length === 0) return null;
  const lo = Math.min(...buckets);
  const hi = Math.max(...buckets);
  return { start: lo, length: (hi - lo) / width + 1 };
}

function slot(bucket: number, grid: Grid, width: number): number {
  const i = (bucket - grid.start) / width;
  if (!Number.isInteger(i) || i < 0 || i >= grid.length) throw bad('bucket', 'a bucket on the grid', bucket);
  return i;
}

const zeros = (n: number): number[] => new Array<number>(n).fill(0);
const nulls = (n: number): (number | null)[] => new Array<number | null>(n).fill(null);

/** The rows of `timelineQuery` as status buckets (ok, error, unset) and the RED series on the same grid. */
export function timeline(
  t: Table,
  spec: BucketSpec,
): { buckets: TimeBuckets<SpanStatusKey>; red: RedBuckets } {
  const rows = rowsOf(t);
  const width = spec.widthNs;
  const at = rows.map((r) => toNumber(c(r, 'bucket'), 'bucket'));
  const grid = gridOf(at, width);
  if (grid === null) {
    return {
      buckets: new TimeBuckets(STATUS_KEYS, MAX_BUCKETS),
      red: {
        startNs: spec.startNs,
        widthNs: width,
        counts: [],
        errors: [],
        p50: [],
        p95: [],
        p99: [],
        max: [],
      },
    };
  }
  const status = STATUS_KEYS.map(() => zeros(grid.length));
  const red: RedBuckets = {
    startNs: grid.start,
    widthNs: width,
    counts: zeros(grid.length),
    errors: zeros(grid.length),
    p50: nulls(grid.length),
    p95: nulls(grid.length),
    p99: nulls(grid.length),
    max: nulls(grid.length),
  };
  const counts = red.counts as number[];
  const errors = red.errors as number[];
  const p50 = red.p50 as (number | null)[];
  const p95 = red.p95 as (number | null)[];
  const p99 = red.p99 as (number | null)[];
  const max = red.max as (number | null)[];
  rows.forEach((r, k) => {
    const i = slot(at[k] as number, grid, width);
    counts[i] = toNumber(c(r, 'n'), 'n');
    errors[i] = toNumber(c(r, 'errors'), 'errors');
    [p50[i], p95[i], p99[i]] = quantiles(c(r, 'quantiles'), 'quantiles');
    max[i] = real(c(r, 'max_duration_ns'), 'max_duration_ns');
    (status[0] as number[])[i] = toNumber(c(r, 'ok'), 'ok');
    (status[1] as number[])[i] = toNumber(c(r, 'error'), 'error');
    (status[2] as number[])[i] = toNumber(c(r, 'unset'), 'unset');
  });
  const buckets = TimeBuckets.from(
    { maxBuckets: MAX_BUCKETS, widthNs: width, startNs: grid.start, keys: [...STATUS_KEYS], counts: status },
    STATUS_KEYS,
    'timeline',
  );
  return { buckets, red };
}

/** The one row of `durationSummaryQuery`; null when no span matched. */
export function durationSummary(t: Table): DurationSummary | null {
  const r = rowsOf(t)[0];
  if (r === undefined) return null;
  const count = toNumber(c(r, 'n'), 'n');
  if (count === 0) return null;
  const [p50, p95, p99] = quantiles(c(r, 'quantiles'), 'quantiles');
  return {
    count,
    min: real(c(r, 'min_duration_ns'), 'min_duration_ns') ?? 0,
    max: real(c(r, 'max_duration_ns'), 'max_duration_ns') ?? 0,
    sum: real(c(r, 'sum_duration_ns'), 'sum_duration_ns') ?? 0,
    p50: p50 ?? 0,
    p95: p95 ?? 0,
    p99: p99 ?? 0,
  };
}

/** Every bin of `axis` with its count from the occupied (bin, n) rows of `durationBinsQuery`. */
export function durationBins(t: Table, axis: readonly { fromNs: number; toNs: number }[]): DurationBin[] {
  const bins: DurationBin[] = axis.map((b) => ({ ...b, count: 0 }));
  for (const r of rowsOf(t)) {
    const bin = bins[toNumber(c(r, 'bin'), 'bin')];
    if (bin === undefined) throw bad('bin', 'an index into the axis', c(r, 'bin'));
    bin.count = toNumber(c(r, 'n'), 'n');
  }
  return bins;
}

/** The rows of `groupStatsQuery` (`cap + 1` at most); `dropped` is 1 when the extra row says there were more groups. */
export function groupStats(t: Table, cap: number): GroupStatsResult {
  const rows = rowsOf(t);
  const groups = rows.slice(0, cap).map((r): GroupStats => {
    const count = toNumber(c(r, 'n'), 'n');
    const sum = real(c(r, 'sum_duration_ns'), 'sum_duration_ns') ?? 0;
    const [, p95, p99] = quantiles(c(r, 'quantiles'), 'quantiles');
    return {
      group: text(c(r, 'value')),
      count,
      sum,
      avg: count === 0 ? 0 : sum / count,
      max: real(c(r, 'max_duration_ns'), 'max_duration_ns') ?? 0,
      p95: p95 ?? 0,
      p99: p99 ?? 0,
    };
  });
  return { groups, cap, dropped: rows.length > cap ? 1 : 0 };
}

/**
 * `ServicesResult` from `servicesQuery(f, limit + 1)` and the per-service buckets: the first `limit` services, `total`
 * is `limit + 1` when the query found more.
 */
export function serviceStats(
  services: Table,
  buckets: Table | null,
  spec: BucketSpec,
  limit: number,
): ServicesResult {
  const rows = rowsOf(services);
  const kept = rows.slice(0, limit);
  const bucketRows = buckets === null ? [] : rowsOf(buckets);
  const width = spec.widthNs;
  const at = bucketRows.map((r) => toNumber(c(r, 'bucket'), 'bucket'));
  const grid = gridOf(at, width);
  const series = new Map<string, number[]>();
  bucketRows.forEach((r, k) => {
    if (grid === null) return;
    const name = text(c(r, 'service_name'));
    let counts = series.get(name);
    if (counts === undefined) {
      counts = zeros(grid.length);
      series.set(name, counts);
    }
    counts[slot(at[k] as number, grid, width)] = toNumber(c(r, 'n'), 'n');
  });
  const out = kept.map((r): ServiceStats => {
    const name = text(c(r, 'service_name'));
    const [p50, p95, p99] = quantiles(c(r, 'quantiles'), 'quantiles');
    const counts = series.get(name);
    return {
      service: name,
      requests: toNumber(c(r, 'n'), 'n'),
      errors: toNumber(c(r, 'errors'), 'errors'),
      p50: p50 ?? 0,
      p95: p95 ?? 0,
      p99: p99 ?? 0,
      max: real(c(r, 'max_duration_ns'), 'max_duration_ns') ?? 0,
      buckets:
        grid === null || counts === undefined
          ? new TimeBuckets(['count'], MAX_BUCKETS)
          : TimeBuckets.from(
              {
                maxBuckets: MAX_BUCKETS,
                widthNs: width,
                startNs: grid.start,
                keys: ['count'],
                counts: [counts],
              },
              ['count'],
              'services',
            ),
    };
  });
  return { services: out, total: rows.length };
}
