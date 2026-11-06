import type { ColumnBatch } from '../format/parquet/batch.js';
import type { Row } from '../format/parquet/rows.js';
import { StatusCode } from '../model/records.js';

interface Acc {
  start: bigint | null;
  end: bigint | null;
  spanCount: number;
  errorCount: number;
  logCount: number;
  logStart: bigint | null;
  logEnd: bigint | null;
  /** Index of the root candidate in the spans batch. */
  root: number | null;
}

const cell = (b: ColumnBatch, k: string, i: number): unknown => b.cells[k]?.[i];
const rowCell = (r: Row, k: string): unknown => Reflect.get(r, k);
const big = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Whether root candidate `x` beats `y`: earlier start (a missing start loses), then the smaller span_id. */
function rootBefore(spans: ColumnBatch, x: number, y: number): boolean {
  const sx = big(cell(spans, 'start_time_unix_nano', x));
  const sy = big(cell(spans, 'start_time_unix_nano', y));
  if (sx !== sy) return sx !== null && (sy === null || sx < sy);
  return String(cell(spans, 'span_id', x) ?? '') < String(cell(spans, 'span_id', y) ?? '');
}

/**
 * The `traces` rows of one partition: one per trace id found in its spans or logs (a log without a trace id adds
 * nothing). Pure, so a cut that is retried derives the same rows again.
 *
 * - start/end: the min span start and max span end. A trace with only logs has no spans, so its range is the min
 *   and max log time (`time_unix_nano`, else `observed_time_unix_nano`); a log with neither adds no time, and a
 *   trace with no time at all gets null start and end (the columns are nullable).
 * - root_*: from the span with a null `parent_span_id`; with several such spans in one partition the earliest
 *   start wins (ties break on the smaller span_id), so the choice does not depend on row order. Null when there is none.
 * - Rows come out ordered by start time, then trace id.
 */
export function traceRows(spans: ColumnBatch, logs: ColumnBatch): Row[] {
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
  for (let s = 0; s < spans.length; s++) {
    const id = text(cell(spans, 'trace_id', s));
    if (id === null) continue;
    const a = of(id);
    const start = big(cell(spans, 'start_time_unix_nano', s));
    const end = big(cell(spans, 'end_time_unix_nano', s));
    a.spanCount++;
    if (cell(spans, 'status_code', s) === StatusCode.ERROR) a.errorCount++;
    if (start !== null && (a.start === null || start < a.start)) a.start = start;
    if (end !== null && (a.end === null || end > a.end)) a.end = end;
    if (cell(spans, 'parent_span_id', s) === null || cell(spans, 'parent_span_id', s) === undefined) {
      if (a.root === null || rootBefore(spans, s, a.root)) a.root = s;
    }
  }
  for (let l = 0; l < logs.length; l++) {
    const id = text(cell(logs, 'trace_id', l));
    if (id === null) continue;
    const a = of(id);
    a.logCount++;
    const t = big(cell(logs, 'time_unix_nano', l)) ?? big(cell(logs, 'observed_time_unix_nano', l));
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
      start_time_unix_nano: (fromSpans ? a.start : a.logStart) ?? null,
      end_time_unix_nano: (fromSpans ? a.end : a.logEnd) ?? null,
      span_count: a.spanCount,
      error_count: a.errorCount,
      root_service: a.root === null ? null : text(cell(spans, 'service_name', a.root)),
      root_name: a.root === null ? null : text(cell(spans, 'name', a.root)),
      root_resource: a.root === null ? null : text(cell(spans, 'resource_name', a.root)),
      log_count: a.logCount,
    });
  }
  return rows.sort((x, y) => {
    const dx = big(rowCell(x, 'start_time_unix_nano'));
    const dy = big(rowCell(y, 'start_time_unix_nano'));
    if (dx !== dy) return dx === null ? 1 : dy === null ? -1 : dx < dy ? -1 : 1;
    return (rowCell(x, 'trace_id') as string) < (rowCell(y, 'trace_id') as string) ? -1 : 1;
  });
}
