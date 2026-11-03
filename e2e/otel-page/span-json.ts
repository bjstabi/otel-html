import type { Attributes, HrTime, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan as WorkerSpan } from '@opentelemetry/sdk-trace';
import type { ReadableSpan as PageSpan } from '@opentelemetry/sdk-trace-base';

/**
 * The plain-JSON shape of a finished span that crosses from the page (the recorder, bundled for the browser) to the
 * Playwright worker. Imported by both sides, so it holds no Node import and only type imports of the SDKs: the page
 * has sdk-trace-base 2.x spans, the worker rebuilds the SDK 3.0 `ReadableSpan` its exporter takes.
 */
type AttributeValue = string | number | boolean | string[] | number[] | boolean[];

export interface SpanJson {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: number;
  name: string;
  kind: number;
  start: [number, number];
  end: [number, number];
  attributes: Record<string, AttributeValue>;
  status: { code: number; message?: string };
  events: { name: string; time: [number, number]; attributes: SpanJson['attributes'] }[];
  scope: { name: string; version?: string };
}

/** The name of the function the page binds to hand a span to the worker. */
export const RECORDER_BINDING = '__otelHtmlSpans';
/** Where the `e2e:otel-recorder` task writes the bundle, relative to the repo root. */
export const RECORDER_PATH = 'e2e/.cache/otel-recorder.js';

function plain(attributes: Attributes | undefined): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (Array.isArray(value)) out[key] = [...value] as AttributeValue;
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      out[key] = value;
  }
  return out;
}

function hr(time: HrTime): [number, number] {
  return [time[0], time[1]];
}

export function toSpanJson(span: PageSpan): SpanJson {
  const { traceId, spanId, traceFlags } = span.spanContext();
  const { code, message } = span.status;
  const { name, version } = span.instrumentationScope;
  return {
    traceId,
    spanId,
    ...(span.parentSpanContext === undefined ? {} : { parentSpanId: span.parentSpanContext.spanId }),
    traceFlags,
    name: span.name,
    kind: span.kind,
    start: hr(span.startTime),
    end: hr(span.endTime),
    attributes: plain(span.attributes),
    status: { code, ...(message === undefined ? {} : { message }) },
    events: span.events.map((e) => ({ name: e.name, time: hr(e.time), attributes: plain(e.attributes) })),
    scope: { name, ...(version === undefined ? {} : { version }) },
  };
}

export function fromSpanJson(json: SpanJson, resource: Resource): WorkerSpan {
  const start = json.start;
  const end = json.end;
  let seconds = end[0] - start[0];
  let nanos = end[1] - start[1];
  if (nanos < 0) {
    seconds -= 1;
    nanos += 1e9;
  }
  return {
    name: json.name,
    kind: json.kind as SpanKind,
    spanContext: () => ({ traceId: json.traceId, spanId: json.spanId, traceFlags: json.traceFlags }),
    ...(json.parentSpanId === undefined
      ? {}
      : {
          parentSpanContext: {
            traceId: json.traceId,
            spanId: json.parentSpanId,
            traceFlags: json.traceFlags,
          },
        }),
    startTime: start,
    endTime: end,
    status: {
      code: json.status.code as SpanStatusCode,
      ...(json.status.message === undefined ? {} : { message: json.status.message }),
    },
    attributes: json.attributes,
    links: [],
    events: json.events.map((e) => ({ name: e.name, time: e.time, attributes: e.attributes })),
    duration: [seconds, nanos],
    ended: true,
    resource,
    instrumentationScope: {
      name: json.scope.name,
      ...(json.scope.version === undefined ? {} : { version: json.scope.version }),
    },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}
