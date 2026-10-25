import type { LogRecordRecord, MetricPointRecord, SpanRecord } from '../model/records.js';
import type { ColumnSpec } from './columns.js';

export const SPAN_COLUMNS: ColumnSpec<SpanRecord> = {
  columns: [
    { name: 'traceId', kind: 'traceId' },
    { name: 'spanId', kind: 'spanId' },
    { name: 'parentSpanId', kind: 'nullableSpanId' },
    { name: 'traceState', kind: 'dict' },
    { name: 'flags', kind: 'int' },
    { name: 'name', kind: 'dict' },
    { name: 'kind', kind: 'int' },
    { name: 'start', kind: 'relnanos' },
    { name: 'end', kind: 'relnanos' },
    { name: 'attributes', kind: 'attrs' },
    { name: 'droppedAttributesCount', kind: 'int' },
    { name: 'events', kind: 'json' },
    { name: 'droppedEventsCount', kind: 'int' },
    { name: 'links', kind: 'json' },
    { name: 'droppedLinksCount', kind: 'int' },
    { name: 'status', kind: 'json' },
    { name: 'resource', kind: 'ref' },
    { name: 'scope', kind: 'ref' },
  ],
};

export const LOG_COLUMNS: ColumnSpec<LogRecordRecord> = {
  columns: [
    { name: 'time', kind: 'nullableRelnanos' },
    { name: 'observedTime', kind: 'nullableRelnanos' },
    { name: 'severityNumber', kind: 'int' },
    { name: 'severityText', kind: 'dict' },
    { name: 'body', kind: 'anyvalue' },
    { name: 'attributes', kind: 'attrs' },
    { name: 'droppedAttributesCount', kind: 'int' },
    { name: 'flags', kind: 'int' },
    { name: 'traceId', kind: 'nullableTraceId' },
    { name: 'spanId', kind: 'nullableSpanId' },
    { name: 'eventName', kind: 'dict' },
    { name: 'resource', kind: 'ref' },
    { name: 'scope', kind: 'ref' },
  ],
};

export const METRIC_COLUMNS: ColumnSpec<MetricPointRecord> = {
  columns: [
    { name: 'name', kind: 'dict' },
    { name: 'description', kind: 'dict' },
    { name: 'unit', kind: 'dict' },
    {
      name: 'type',
      kind: 'dict',
      oneOf: ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'],
    },
    { name: 'temporality', kind: 'dict', oneOf: ['unspecified', 'delta', 'cumulative'] },
    { name: 'monotonic', kind: 'bool' },
    { name: 'start', kind: 'nullableRelnanos' },
    { name: 'time', kind: 'relnanos' },
    { name: 'attributes', kind: 'attrs' },
    { name: 'flags', kind: 'int' },
    { name: 'point', kind: 'json' },
    { name: 'resource', kind: 'ref' },
    { name: 'scope', kind: 'ref' },
  ],
};
