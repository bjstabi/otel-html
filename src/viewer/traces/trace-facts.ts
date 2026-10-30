import { anyValueToDisplay } from '../../model/anyvalue.js';
import type { RelNanos } from '../../model/ids.js';
import { StatusCode } from '../../model/records.js';
import type { TraceDetail } from '../data/data-source.js';
import type { SpanRow } from '../data/span-query.js';

export interface TraceFacts {
  /** The root span: the earliest start among spans without a parent, else the earliest span of the trace. */
  root: SpanRow | null;
  /** The earliest span start and the latest span end; 0 for a trace with no spans. */
  start: RelNanos;
  end: RelNanos;
  durationNs: number;
  spans: number;
  services: number;
  errors: number;
  method: string | null;
  url: string | null;
  statusCode: string | null;
}

/** The run's epoch, where a trace with no spans is placed. */
const ZERO = 0 as RelNanos;

function attrText(r: SpanRow, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = r.span.attributes.get(k);
    if (v !== undefined) return anyValueToDisplay(v);
  }
  return null;
}

/** Header facts of a loaded trace, derived from every span (the authoritative source, not a list row). */
export function traceFacts(detail: TraceDetail): TraceFacts {
  const roots = detail.tree.roots;
  const root = roots.find((r) => r.row.span.parentSpanId === null)?.row ?? roots[0]?.row ?? null;
  let start: RelNanos | null = null;
  let end: RelNanos | null = null;
  let errors = 0;
  const services = new Set<string>();
  for (const r of detail.spans) {
    if (start === null || r.span.start < start) start = r.span.start;
    if (end === null || r.span.end > end) end = r.span.end;
    if (r.span.status.code === StatusCode.ERROR) errors++;
    services.add(r.service);
  }
  return {
    root,
    start: start ?? ZERO,
    end: end ?? ZERO,
    durationNs: start === null || end === null ? 0 : end - start,
    spans: detail.spans.length,
    services: services.size,
    errors,
    method: root === null ? null : attrText(root, 'http.request.method', 'http.method'),
    url: root === null ? null : attrText(root, 'url.full', 'http.url', 'http.target', 'url.path'),
    statusCode: root === null ? null : attrText(root, 'http.response.status_code', 'http.status_code'),
  };
}
