import { anyValueToDisplay } from '../../model/anyvalue.js';
import { StatusCode } from '../../model/records.js';
import type { TraceDetail } from '../data/data-source.js';
import type { SpanRow } from '../data/span-query.js';

export interface TraceFacts {
  /** The root span: the earliest start among spans without a parent, else the earliest span of the trace. */
  root: SpanRow | null;
  start: number;
  end: number;
  durationNs: number;
  spans: number;
  services: number;
  errors: number;
  method: string | null;
  url: string | null;
  statusCode: string | null;
}

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
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let errors = 0;
  const services = new Set<string>();
  for (const r of detail.spans) {
    if (r.span.start < start) start = r.span.start;
    if (r.span.end > end) end = r.span.end;
    if (r.span.status.code === StatusCode.ERROR) errors++;
    services.add(r.service);
  }
  const empty = detail.spans.length === 0;
  return {
    root,
    start: empty ? 0 : start,
    end: empty ? 0 : end,
    durationNs: empty ? 0 : end - start,
    spans: detail.spans.length,
    services: services.size,
    errors,
    method: root === null ? null : attrText(root, 'http.request.method', 'http.method'),
    url: root === null ? null : attrText(root, 'url.full', 'http.url', 'http.target', 'url.path'),
    statusCode: root === null ? null : attrText(root, 'http.response.status_code', 'http.status_code'),
  };
}
