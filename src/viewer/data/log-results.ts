import type { Table } from '@uwdata/flechette';
import { logFromRow, type ResultRow } from '../../format/parquet/decode.js';
import type { TraceId } from '../../model/ids.js';
import { logTime, logTimeSource } from '../../model/records.js';
import type { BucketSpec } from '../../query/sql/time.js';
import { partitionOfFilename } from '../../query/sql/views.js';
import { templateStringToRegex } from '../../rollups/drain.js';
import { TimeBuckets } from '../../rollups/time-buckets.js';
import { LOG_SEVERITY_KEYS, type LogSeverityKey } from '../../semconv/severity.js';
import type { FacetValueKind } from '../components/filter-tokens.js';
import type { ResourceValues } from './data-source.js';
import { gridOf, MAX_BUCKETS, slot, zeros } from './grid.js';
import { type LogRow, type LogTraceRow, logRef, type PatternRow } from './log-query.js';
import { cell, rowsOf, toNumber } from './span-results.js';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A log row of a query result with the file position the residual re-check keys on. */
export interface LogRowEntry {
  row: LogRow;
  filename: string;
  fileRow: number;
}

function entryOf(r: ResultRow): LogRowEntry {
  const { log, shared } = logFromRow({
    ...r,
    time_unix_nano: cell(r, 'time_ns'),
    observed_time_unix_nano: cell(r, 'observed_ns'),
  });
  const filename = text(cell(r, 'filename'));
  const fileRow = toNumber(cell(r, 'file_row_number'), 'file_row_number');
  const n = partitionOfFilename(filename);
  const host = cell(r, 'host_name');
  return {
    row: {
      ref: logRef(n, fileRow),
      n,
      i: fileRow,
      log,
      resource: shared.resource,
      scope: shared.scope,
      time: logTime(log),
      timeSource: logTimeSource(log),
      service: text(cell(r, 'service_name')),
      host: typeof host === 'string' ? host : null,
    },
    filename,
    fileRow,
  };
}

/** Decodes the rows of the log queries (`logColumns`: times relative as `time_ns` / `observed_ns`); `total` is the first row's `total`, else the row count. */
export function logEntries(t: Table): { entries: LogRowEntry[]; total: number } {
  const rows = rowsOf(t);
  const entries = rows.map(entryOf);
  const first = rows[0];
  return {
    entries,
    total:
      first === undefined || cell(first, 'total') === undefined
        ? entries.length
        : toNumber(cell(first, 'total'), 'total'),
  };
}

/** `logEntries` as the rows the viewer shows (the SQL already made times relative). */
export function logRows(t: Table): { rows: LogRow[]; total: number } {
  const { entries, total } = logEntries(t);
  return { rows: entries.map((e) => e.row), total };
}

/** The rows of `logTracesQuery`. */
export function logTraceRows(t: Table): { rows: LogTraceRow[]; total: number } {
  const rows = rowsOf(t);
  const out = rows.map(
    (r): LogTraceRow => ({
      traceId: text(cell(r, 'trace_id')) as TraceId,
      logs: toNumber(cell(r, 'log_count'), 'log_count'),
      first: toNumber(cell(r, 'first_ns'), 'first_ns'),
      last: toNumber(cell(r, 'last_ns'), 'last_ns'),
      maxSeverity: toNumber(cell(r, 'max_severity') ?? 0n, 'max_severity'),
      services: Array.from((cell(r, 'services') ?? []) as ArrayLike<unknown>, text),
    }),
  );
  const first = rows[0];
  return { rows: out, total: first === undefined ? 0 : toNumber(cell(first, 'total'), 'total') };
}

/** The rows of `logTimelineQuery` (bucket, band, n) as severity-band buckets on a dense grid. */
export function logTimeline(t: Table, spec: BucketSpec): TimeBuckets<LogSeverityKey> {
  const rows = rowsOf(t);
  const width = spec.widthNs;
  const at = rows.map((r) => toNumber(cell(r, 'bucket'), 'bucket'));
  const grid = gridOf(at, width);
  if (grid === null) return new TimeBuckets(LOG_SEVERITY_KEYS, MAX_BUCKETS);
  const counts = LOG_SEVERITY_KEYS.map(() => zeros(grid.length));
  rows.forEach((r, k) => {
    const band = LOG_SEVERITY_KEYS.indexOf(text(cell(r, 'band')) as LogSeverityKey);
    const series = counts[band];
    if (series === undefined) return;
    series[slot(at[k] as number, grid, width)] = toNumber(cell(r, 'n'), 'n');
  });
  return TimeBuckets.from(
    { maxBuckets: MAX_BUCKETS, widthNs: width, startNs: grid.start, keys: [...LOG_SEVERITY_KEYS], counts },
    LOG_SEVERITY_KEYS,
    'logTimeline',
  );
}

/** The rows of `patternsQuery`: the regex comes from the template, `id` is the position in the sorted list. */
export function patternRows(t: Table): { rows: PatternRow[]; total: number } {
  const rows = rowsOf(t);
  const out = rows.map((r, id): PatternRow => {
    const template = text(cell(r, 'template'));
    const severities = Object.fromEntries(
      LOG_SEVERITY_KEYS.map((k) => [k, toNumber(cell(r, `sev_${k}`) ?? 0n, `sev_${k}`)]),
    ) as Record<LogSeverityKey, number>;
    return {
      id,
      template,
      regex: templateStringToRegex(template),
      count: toNumber(cell(r, 'count'), 'count'),
      severities,
      first: cell(r, 'first_ns') == null ? null : toNumber(cell(r, 'first_ns'), 'first_ns'),
      last: cell(r, 'last_ns') == null ? null : toNumber(cell(r, 'last_ns'), 'last_ns'),
      sample: text(cell(r, 'sample')),
    };
  });
  const first = rows[0];
  return { rows: out, total: first === undefined ? 0 : toNumber(cell(first, 'total'), 'total') };
}

/** The rows of `pointsTimelineQuery` as one-key buckets on a dense grid. */
export function pointBuckets(t: Table, spec: BucketSpec): TimeBuckets<'points'> {
  const rows = rowsOf(t);
  const width = spec.widthNs;
  const at = rows.map((r) => toNumber(cell(r, 'bucket'), 'bucket'));
  const grid = gridOf(at, width);
  if (grid === null) return new TimeBuckets(['points'], MAX_BUCKETS);
  const counts = zeros(grid.length);
  rows.forEach((r, k) => {
    counts[slot(at[k] as number, grid, width)] = toNumber(cell(r, 'n'), 'n');
  });
  return TimeBuckets.from(
    { maxBuckets: MAX_BUCKETS, widthNs: width, startNs: grid.start, keys: ['points'], counts: [counts] },
    ['points'],
    'points',
  );
}

const SCALAR_KINDS: readonly FacetValueKind[] = ['string', 'int', 'double', 'bool', 'mixed'];

/**
 * `ResourceValues` from `resourceValuesQuery(key, cap)`: one row per value, sorted; the first `cap` are kept, `capped`
 * when the extra row came back, `kind` the shared kind of the values kept and `mixed` when they disagree.
 */
export function resourceValueResult(t: Table, cap: number): ResourceValues {
  const rows = rowsOf(t);
  const kept = rows.slice(0, cap);
  const kinds = new Set(kept.map((r) => SCALAR_KINDS.find((x) => x === cell(r, 'kind')) ?? 'string'));
  const [only] = [...kinds];
  return {
    values: kept.map((r) => text(cell(r, 'value'))),
    kind: kinds.size === 0 ? 'string' : kinds.size === 1 && only !== undefined ? only : 'mixed',
    capped: rows.length > cap,
  };
}
