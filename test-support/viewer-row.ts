import { attributesFromJson } from '../src/format/columns.js';
import type { Row } from '../src/format/parquet/rows.js';
import type { RelNanos, SpanId, TraceId } from '../src/model/ids.js';
import type { SpanRecord } from '../src/model/records.js';
import { StatusCode } from '../src/model/records.js';
import type { SpanRow } from '../src/viewer/data/results.js';

/** A decoded spans row as the viewer holds it: times relative to the trace's earliest start (the exact `share` the data source reads). */
export function viewerRow(r: Row, origin: bigint): SpanRow {
  const start = Number((Reflect.get(r, 'start_time_unix_nano') as bigint) - origin);
  const end = Number((Reflect.get(r, 'end_time_unix_nano') as bigint) - origin);
  const span: SpanRecord = {
    traceId: String(Reflect.get(r, 'trace_id')) as TraceId,
    spanId: String(Reflect.get(r, 'span_id')) as SpanId,
    parentSpanId: (Reflect.get(r, 'parent_span_id') as SpanId | null) ?? null,
    traceState: '',
    flags: 0,
    name: String(Reflect.get(r, 'name')),
    kind: 1,
    start: start as RelNanos,
    end: end as RelNanos,
    attributes: attributesFromJson(String(Reflect.get(r, 'attributes') ?? '{}')),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: StatusCode.UNSET, message: '' },
    resource: 0 as never,
    scope: 0 as never,
  };
  return {
    span,
    service: String(Reflect.get(r, 'service_name') ?? ''),
    resource: '',
    durationNs: Number(Reflect.get(r, 'duration_ns')),
  };
}
