/** Builders for OTLP-JSON objects (the wire shape, not protobuf-es messages). */

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
export type JsonObject = { readonly [k: string]: Json };

export const TRACE_ID = '5b8efff798038103d269b633813fc60c';
export const SPAN_ID = 'eee19b7ec3c1b174';
export const T0 = '1700000000000000000';

export function attr(key: string, value: Json): JsonObject {
  return { key, value };
}

export function span(overrides: JsonObject = {}): JsonObject {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    name: 'op',
    kind: 1,
    startTimeUnixNano: T0,
    endTimeUnixNano: '1700000000000001000',
    ...overrides,
  };
}

export function traceRequest(
  spans: readonly JsonObject[],
  resourceAttrs: readonly JsonObject[] = [],
): JsonObject {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [{ scope: { name: 'test-scope', version: '1.0.0' }, spans }],
      },
    ],
  };
}

export function logRecord(overrides: JsonObject = {}): JsonObject {
  return {
    timeUnixNano: T0,
    observedTimeUnixNano: T0,
    severityNumber: 9,
    severityText: 'INFO',
    body: { stringValue: 'hello' },
    ...overrides,
  };
}

export function logsRequest(
  logRecords: readonly JsonObject[],
  resourceAttrs: readonly JsonObject[] = [],
): JsonObject {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [{ scope: { name: 'test-scope' }, logRecords }],
      },
    ],
  };
}

export function gauge(name: string, dataPoints: readonly JsonObject[]): JsonObject {
  return { name, unit: '1', gauge: { dataPoints } };
}

export function metricsRequest(
  metrics: readonly JsonObject[],
  resourceAttrs: readonly JsonObject[] = [],
): JsonObject {
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttrs },
        scopeMetrics: [{ scope: { name: 'test-scope' }, metrics }],
      },
    ],
  };
}
