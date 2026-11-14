import { attributesFromJson } from '../format/columns.js';
import type { ColumnBatch } from '../format/parquet/batch.js';
import type { Row } from '../format/parquet/rows.js';
import { encodeServiceShare, type ShareSpan, serviceShareOf } from '../format/service-share.js';
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
  /** Indices of the trace's spans in the spans batch. */
  spans: number[];
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

const PROVISIONAL_ATTR = 'otel_html.ci.provisional';

/** Whether a span's attributes JSON says `otel_html.ci.provisional` is boolean true (the viewer's rule). */
function provisionalOf(json: unknown): boolean {
  if (typeof json !== 'string' || !json.includes(PROVISIONAL_ATTR)) return false;
  const v = attributesFromJson(json).get(PROVISIONAL_ATTR);
  return v?.kind === 'bool' && v.value;
}

/** The share input of a trace's spans: times relative to the trace's earliest start (bigint arithmetic, exact), duration as stored. */
function shareSpansOf(spans: ColumnBatch, indices: readonly number[], origin: bigint | null): ShareSpan[] {
  const out: ShareSpan[] = [];
  for (const i of indices) {
    const start = big(cell(spans, 'start_time_unix_nano', i));
    const end = big(cell(spans, 'end_time_unix_nano', i));
    if (start === null || end === null || origin === null) continue;
    const parent = text(cell(spans, 'parent_span_id', i));
    out.push({
      spanId: text(cell(spans, 'span_id', i)) ?? '',
      parentId: parent,
      service: text(cell(spans, 'service_name', i)) ?? '',
      start: Number(start - origin),
      end: Number(end - origin),
      durationNs: Number(big(cell(spans, 'duration_ns', i)) ?? 0n),
      provisional: provisionalOf(cell(spans, 'attributes', i)),
    });
  }
  return out;
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
 * - service_share: the trace's exclusive time per service (`serviceShareOf`) over the spans of this batch.
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
        spans: [],
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
    a.spans.push(s);
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
      service_share: encodeServiceShare(serviceShareOf(shareSpansOf(spans, a.spans, a.start))),
    });
  }
  return rows.sort((x, y) => {
    const dx = big(rowCell(x, 'start_time_unix_nano'));
    const dy = big(rowCell(y, 'start_time_unix_nano'));
    if (dx !== dy) return dx === null ? 1 : dy === null ? -1 : dx < dy ? -1 : 1;
    return (rowCell(x, 'trace_id') as string) < (rowCell(y, 'trace_id') as string) ? -1 : 1;
  });
}
