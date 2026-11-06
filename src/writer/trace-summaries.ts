import type { Row } from '../format/parquet/rows.js';

/** OTLP `Status.StatusCode.STATUS_CODE_ERROR`. */
const STATUS_ERROR = 2;

interface Acc {
  start: bigint | null;
  end: bigint | null;
  spanCount: number;
  errorCount: number;
  logCount: number;
  logStart: bigint | null;
  logEnd: bigint | null;
  root: Row | null;
}

const cell = (r: Row, k: string): unknown => Reflect.get(r, k);
const big = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * The `traces` rows of one partition: one per trace id found in its spans or logs (a log without a trace id adds
 * nothing). Pure, so a cut that is retried derives the same rows again.
 *
 * - start/end: the min span start and max span end. A trace with only logs has no spans, so its range is the min
 *   and max log time (`time_unix_nano`, else `observed_time_unix_nano`); a log with neither adds no time, and a
 *   trace with no time at all gets 0 (the columns are required).
 * - root_*: from the span with a null `parent_span_id`; with several such spans in one partition the earliest
 *   start wins (the first seen on a tie), so the choice does not depend on row order. Null when there is none.
 * - Rows come out ordered by start time, then trace id.
 */
export function traceRows(spans: readonly Row[], logs: readonly Row[]): Row[] {
  const acc = new Map<string, Acc>();
  const of = (id: string): Acc => {
    let a = acc.get(id);
    if (a === undefined) {
      a = {
        start: null,
        end: null,
        spanCount: 0,
        errorCount: 0,
        logCount: 0,
        logStart: null,
        logEnd: null,
        root: null,
      };
      acc.set(id, a);
    }
    return a;
  };
  for (const s of spans) {
    const id = text(cell(s, 'trace_id'));
    if (id === null) continue;
    const a = of(id);
    const start = big(cell(s, 'start_time_unix_nano'));
    const end = big(cell(s, 'end_time_unix_nano'));
    a.spanCount++;
    if (cell(s, 'status_code') === STATUS_ERROR) a.errorCount++;
    if (start !== null && (a.start === null || start < a.start)) a.start = start;
    if (end !== null && (a.end === null || end > a.end)) a.end = end;
    if (cell(s, 'parent_span_id') === null || cell(s, 'parent_span_id') === undefined) {
      const rootStart = a.root === null ? null : big(cell(a.root, 'start_time_unix_nano'));
      if (a.root === null || (start !== null && (rootStart === null || start < rootStart))) a.root = s;
    }
  }
  for (const l of logs) {
    const id = text(cell(l, 'trace_id'));
    if (id === null) continue;
    const a = of(id);
    a.logCount++;
    const t = big(cell(l, 'time_unix_nano')) ?? big(cell(l, 'observed_time_unix_nano'));
    if (t !== null) {
      if (a.logStart === null || t < a.logStart) a.logStart = t;
      if (a.logEnd === null || t > a.logEnd) a.logEnd = t;
    }
  }
  const rows: Row[] = [];
  for (const [id, a] of acc) {
    const fromSpans = a.spanCount > 0;
    rows.push({
      trace_id: id,
      start_time_unix_nano: (fromSpans ? a.start : a.logStart) ?? 0n,
      end_time_unix_nano: (fromSpans ? a.end : a.logEnd) ?? 0n,
      span_count: a.spanCount,
      error_count: a.errorCount,
      root_service: a.root === null ? null : text(cell(a.root, 'service_name')),
      root_name: a.root === null ? null : text(cell(a.root, 'name')),
      root_resource: a.root === null ? null : text(cell(a.root, 'resource_name')),
      log_count: a.logCount,
    });
  }
  return rows.sort((x, y) => {
    const dx = cell(x, 'start_time_unix_nano') as bigint;
    const dy = cell(y, 'start_time_unix_nano') as bigint;
    if (dx !== dy) return dx < dy ? -1 : 1;
    return (cell(x, 'trace_id') as string) < (cell(y, 'trace_id') as string) ? -1 : 1;
  });
}
