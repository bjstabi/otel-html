import { spansToOtlpJson } from '../../format/otlp-export.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { UnixNanos } from '../../model/ids.js';
import type { ResourceRecord, ResourceRef, ScopeRecord, ScopeRef, SpanRecord } from '../../model/records.js';
import { StatusCode } from '../../model/records.js';
import type { SpanRow, TraceRow } from '../data/span-query.js';

export type ExportFormat = 'csv' | 'json' | 'otlp-json';

/** Spans with a ref-stable resource and scope table (one `TraceDetail`, for example). */
export interface OtlpSpanGroup {
  spans: readonly SpanRecord[];
  resources: (r: ResourceRef) => ResourceRecord;
  scopes: (s: ScopeRef) => ScopeRecord;
}

export interface ExportContext {
  epoch: UnixNanos;
  groups: readonly OtlpSpanGroup[];
}

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV field: RFC 4180 quoting (quote when it holds a quote, comma or line break; quotes are doubled) after
 * neutralising spreadsheet formula injection by prefixing a single quote to values that start with `= + - @`, tab or CR.
 */
export function csvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function csv(header: readonly string[], lines: readonly (readonly (string | number)[])[]): string {
  return [header, ...lines].map((cells) => cells.map(csvCell).join(',')).join('\r\n');
}

function statusName(code: StatusCode): string {
  switch (code) {
    case StatusCode.ERROR:
      return 'error';
    case StatusCode.OK:
      return 'ok';
    default:
      return 'unset';
  }
}

const SPAN_HEADER = [
  'time_ns',
  'trace_id',
  'span_id',
  'service',
  'name',
  'resource',
  'duration_ns',
  'status',
] as const;
const TRACE_HEADER = ['start_ns', 'trace_id', 'root_service', 'root_name', 'duration_ns', 'spans', 'errors'];

export function isSpanRow(r: SpanRow | TraceRow): r is SpanRow {
  return 'span' in r;
}

function toCsv(rows: readonly (SpanRow | TraceRow)[]): string {
  const spans = rows.filter(isSpanRow);
  // An empty export keeps the span header; a mixed list cannot occur (one query mode per result).
  if (spans.length === rows.length) {
    return csv(
      SPAN_HEADER,
      spans.map((r) => [
        r.span.start,
        r.span.traceId,
        r.span.spanId,
        r.service,
        r.span.name,
        r.resource,
        r.durationNs,
        statusName(r.span.status.code),
      ]),
    );
  }
  const traces = rows.filter((r): r is TraceRow => !isSpanRow(r));
  return csv(
    TRACE_HEADER,
    traces.map((t) => [
      t.start,
      t.traceId,
      t.rootSummary?.service ?? '',
      t.rootSummary?.name ?? '',
      t.durationNs,
      t.spans,
      t.errors,
    ]),
  );
}

/** Plain JSON for a row: no maps or bigint attribute values, so it always serialises. */
function jsonRow(r: SpanRow | TraceRow): Record<string, unknown> {
  if (isSpanRow(r)) {
    return {
      traceId: r.span.traceId,
      spanId: r.span.spanId,
      parentSpanId: r.span.parentSpanId,
      name: r.span.name,
      kind: r.span.kind,
      start: r.span.start,
      end: r.span.end,
      durationNs: r.durationNs,
      service: r.service,
      resource: r.resource,
      status: statusName(r.span.status.code),
      statusMessage: r.span.status.message,
    };
  }
  return {
    traceId: r.traceId,
    start: r.start,
    durationNs: r.durationNs,
    spans: r.spans,
    errors: r.errors,
    root: r.rootSummary,
  };
}

function toOtlp(ctx: ExportContext | undefined): string {
  if (ctx === undefined) {
    throw new OtelHtmlError('usage', {
      path: 'exportRows(otlp-json)',
      expected: 'an export context with the spans and their resource tables',
      actual: 'none',
    });
  }
  const resourceSpans = ctx.groups.flatMap((g) => {
    const out = spansToOtlpJson(g.spans, g.resources, g.scopes, ctx.epoch);
    return (out as { resourceSpans: unknown[] }).resourceSpans;
  });
  return JSON.stringify({ resourceSpans });
}

/** The rows as a download. `otlp-json` goes through the report's own exporter and needs `ctx`. */
export function exportRows(
  rows: readonly (SpanRow | TraceRow)[],
  format: ExportFormat,
  ctx?: ExportContext,
): Blob {
  switch (format) {
    case 'csv':
      return new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    case 'json':
      return new Blob([JSON.stringify(rows.map(jsonRow))], { type: 'application/json' });
    case 'otlp-json':
      return new Blob([toOtlp(ctx)], { type: 'application/json' });
    default: {
      const never: never = format;
      throw new Error(`unhandled export format ${String(never)}`);
    }
  }
}
