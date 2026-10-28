import { type DescMessage, fromJson, type JsonObject, type JsonValue, toJson } from '@bufbuild/protobuf';
import type { AnyValue, Attributes } from './anyvalue.js';
import { OtelHtmlError } from './errors.js';
import type { ExportLogsServiceRequest } from './gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import type { ExportMetricsServiceRequest } from './gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import type { ExportTraceServiceRequest } from './gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import type {
  InstrumentationScope,
  KeyValue,
  AnyValue as ProtoAnyValue,
} from './gen/opentelemetry/proto/common/v1/common_pb.js';
import {
  AggregationTemporality,
  ExemplarSchema,
  ExponentialHistogramDataPointSchema,
  HistogramDataPointSchema,
  type Metric,
  NumberDataPointSchema,
  SummaryDataPointSchema,
} from './gen/opentelemetry/proto/metrics/v1/metrics_pb.js';
import type { Resource } from './gen/opentelemetry/proto/resource/v1/resource_pb.js';
import {
  parseSpanId,
  parseTraceId,
  parseUnixNanos,
  type RelNanos,
  type SpanId,
  spanIdFromBytes,
  type TraceId,
  toRelNanos,
  traceIdFromBytes,
  type UnixNanos,
} from './ids.js';
import { canonicalAttributesKey, Interner } from './interner.js';
import type { OtlpRequest } from './otlp-json.js';
import type {
  LogRecordRecord,
  MetricPointRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
  SpanEventRecord,
  SpanLinkRecord,
  SpanRecord,
} from './records.js';

export interface NormalizeContext {
  readonly epoch: UnixNanos;
  readonly resources: Interner<ResourceRecord>;
  readonly scopes: Interner<ScopeRecord>;
}

export function createNormalizeContext(epoch: UnixNanos): NormalizeContext {
  return {
    epoch,
    resources: new Interner<ResourceRecord>(
      (r) =>
        `${JSON.stringify(r.schemaUrl)}|${r.droppedAttributesCount}|${canonicalAttributesKey(r.attributes)}`,
    ),
    scopes: new Interner<ScopeRecord>(
      (s) =>
        `${JSON.stringify([s.name, s.version, s.schemaUrl])}|${s.droppedAttributesCount}|${canonicalAttributesKey(s.attributes)}`,
    ),
  };
}

/** A field path, or a function building it only for an error (per-point paths are costly at volume). */
export type Path = string | (() => string);
const pathText = (p: Path): string => (typeof p === 'string' ? p : p());

function convertAnyValue(v: ProtoAnyValue, path: Path): AnyValue {
  const inner = v.value;
  switch (inner.case) {
    case 'stringValue':
      return { kind: 'string', value: inner.value };
    case 'boolValue':
      return { kind: 'bool', value: inner.value };
    case 'intValue':
      return { kind: 'int', value: inner.value };
    case 'doubleValue':
      return { kind: 'double', value: inner.value };
    case 'bytesValue':
      return { kind: 'bytes', value: inner.value };
    case 'arrayValue':
      return {
        kind: 'array',
        values: inner.value.values.map((x, i) => convertAnyValue(x, () => `${pathText(path)}[${i}]`)),
      };
    case 'kvlistValue':
      return { kind: 'kvlist', values: convertAttributes(inner.value.values, path) };
    case undefined:
      return { kind: 'empty' };
    case 'stringValueStrindex':
      throw new OtelHtmlError('invalid-otlp', {
        path: pathText(path),
        expected: 'an inline AnyValue',
        actual: 'string table index (profiles-only encoding)',
      });
  }
}

/** A value whose conversion cannot fail and needs no path (no child path is built for it). */
function isScalarValue(v: ProtoAnyValue): boolean {
  const c = v.value.case;
  return c !== 'arrayValue' && c !== 'kvlistValue' && c !== 'stringValueStrindex';
}

function convertAttributes(kvs: readonly KeyValue[], path: Path): Attributes {
  const out = new Map<string, AnyValue>();
  for (let i = 0; i < kvs.length; i++) {
    const kv = kvs[i] as KeyValue;
    out.set(
      kv.key,
      kv.value === undefined
        ? { kind: 'empty' }
        : convertAnyValue(kv.value, isScalarValue(kv.value) ? path : () => `${pathText(path)}[${i}].value`),
    );
  }
  return out;
}

function isAbsentId(b: Uint8Array): boolean {
  return b.every((x) => x === 0);
}

function traceIdOrNull(b: Uint8Array, path: string): TraceId | null {
  return isAbsentId(b) ? null : traceIdFromBytes(b, path);
}

function spanIdOrNull(b: Uint8Array, path: string): SpanId | null {
  return isAbsentId(b) ? null : spanIdFromBytes(b, path);
}

const MAX_REL = BigInt(Number.MAX_SAFE_INTEGER);

export function rel(t: bigint, ctx: NormalizeContext, path: Path): RelNanos {
  const d = t - ctx.epoch;
  if (t >= 0n && d <= MAX_REL && d >= -MAX_REL) return Number(d) as RelNanos;
  const at = pathText(path);
  return toRelNanos(parseUnixNanos(t, at), ctx.epoch, at);
}

/** Zero means "unset" for optional timestamps. */
export function relOrNull(t: bigint, ctx: NormalizeContext, path: Path): RelNanos | null {
  return t === 0n ? null : rel(t, ctx, path);
}

function internResource(
  r: Resource | undefined,
  schemaUrl: string,
  ctx: NormalizeContext,
  path: string,
): ResourceRef {
  return ctx.resources.intern({
    attributes: convertAttributes(r?.attributes ?? [], `${path}.resource.attributes`),
    droppedAttributesCount: r?.droppedAttributesCount ?? 0,
    schemaUrl,
  }) as ResourceRef;
}

function internScope(
  s: InstrumentationScope | undefined,
  schemaUrl: string,
  ctx: NormalizeContext,
  path: string,
): ScopeRef {
  return ctx.scopes.intern({
    name: s?.name ?? '',
    version: s?.version ?? '',
    attributes: convertAttributes(s?.attributes ?? [], `${path}.scope.attributes`),
    droppedAttributesCount: s?.droppedAttributesCount ?? 0,
    schemaUrl,
  }) as ScopeRef;
}

export function normalizeTraces(
  req: ExportTraceServiceRequest,
  ctx: NormalizeContext,
  source: string,
  first = 0,
): SpanRecord[] {
  const out: SpanRecord[] = [];
  for (const [ri, rs] of req.resourceSpans.entries()) {
    const rp = `resourceSpans[${first + ri}]`;
    const resource = internResource(rs.resource, rs.schemaUrl, ctx, `${source}: ${rp}`);
    for (const [si, ss] of rs.scopeSpans.entries()) {
      const sp = `${rp}.scopeSpans[${si}]`;
      const scope = internScope(ss.scope, ss.schemaUrl, ctx, `${source}: ${sp}`);
      for (const [pi, s] of ss.spans.entries()) {
        const p = `${source}: ${sp}.spans[${pi}]`;
        const events: SpanEventRecord[] = s.events.map((e, i) => ({
          time: rel(e.timeUnixNano, ctx, `${p}.events[${i}].timeUnixNano`),
          name: e.name,
          attributes: convertAttributes(e.attributes, `${p}.events[${i}].attributes`),
          droppedAttributesCount: e.droppedAttributesCount,
        }));
        const links: SpanLinkRecord[] = s.links.map((l, i) => ({
          traceId: traceIdFromBytes(l.traceId, `${p}.links[${i}].traceId`),
          spanId: spanIdFromBytes(l.spanId, `${p}.links[${i}].spanId`),
          traceState: l.traceState,
          attributes: convertAttributes(l.attributes, `${p}.links[${i}].attributes`),
          droppedAttributesCount: l.droppedAttributesCount,
          flags: l.flags,
        }));
        out.push({
          traceId: traceIdFromBytes(s.traceId, `${p}.traceId`),
          spanId: spanIdFromBytes(s.spanId, `${p}.spanId`),
          parentSpanId: spanIdOrNull(s.parentSpanId, `${p}.parentSpanId`),
          traceState: s.traceState,
          flags: s.flags,
          name: s.name,
          kind: s.kind,
          start: rel(s.startTimeUnixNano, ctx, `${p}.startTimeUnixNano`),
          end: rel(s.endTimeUnixNano, ctx, `${p}.endTimeUnixNano`),
          attributes: convertAttributes(s.attributes, `${p}.attributes`),
          droppedAttributesCount: s.droppedAttributesCount,
          events,
          droppedEventsCount: s.droppedEventsCount,
          links,
          droppedLinksCount: s.droppedLinksCount,
          status: { code: s.status?.code ?? 0, message: s.status?.message ?? '' },
          resource,
          scope,
        });
      }
    }
  }
  return out;
}

export function normalizeLogs(
  req: ExportLogsServiceRequest,
  ctx: NormalizeContext,
  source: string,
  first = 0,
): LogRecordRecord[] {
  const out: LogRecordRecord[] = [];
  for (const [ri, rl] of req.resourceLogs.entries()) {
    const rp = `resourceLogs[${first + ri}]`;
    const resource = internResource(rl.resource, rl.schemaUrl, ctx, `${source}: ${rp}`);
    for (const [si, sl] of rl.scopeLogs.entries()) {
      const sp = `${rp}.scopeLogs[${si}]`;
      const scope = internScope(sl.scope, sl.schemaUrl, ctx, `${source}: ${sp}`);
      for (const [li, l] of sl.logRecords.entries()) {
        const p = `${source}: ${sp}.logRecords[${li}]`;
        out.push({
          time: relOrNull(l.timeUnixNano, ctx, `${p}.timeUnixNano`),
          observedTime: relOrNull(l.observedTimeUnixNano, ctx, `${p}.observedTimeUnixNano`),
          severityNumber: l.severityNumber,
          severityText: l.severityText,
          body: l.body === undefined ? { kind: 'empty' } : convertAnyValue(l.body, `${p}.body`),
          attributes: convertAttributes(l.attributes, `${p}.attributes`),
          droppedAttributesCount: l.droppedAttributesCount,
          flags: l.flags,
          traceId: traceIdOrNull(l.traceId, `${p}.traceId`),
          spanId: spanIdOrNull(l.spanId, `${p}.spanId`),
          eventName: l.eventName,
          resource,
          scope,
        });
      }
    }
  }
  return out;
}

function temporality(t: AggregationTemporality): MetricPointRecord['temporality'] {
  switch (t) {
    case AggregationTemporality.DELTA:
      return 'delta';
    case AggregationTemporality.CUMULATIVE:
      return 'cumulative';
    default:
      return 'unspecified';
  }
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

interface PointLike {
  readonly attributes: readonly KeyValue[];
  readonly startTimeUnixNano: bigint;
  readonly timeUnixNano: bigint;
  readonly flags: number;
  readonly exemplars?: readonly { readonly traceId: Uint8Array; readonly spanId: Uint8Array }[];
}

const RECORD_LEVEL_POINT_FIELDS: ReadonlySet<string> = new Set([
  'attributes',
  'startTimeUnixNano',
  'timeUnixNano',
  'flags',
]);

function withHexIds(
  e: JsonValue,
  src: { readonly traceId: Uint8Array; readonly spanId: Uint8Array },
): JsonValue {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return e;
  const kept = Object.entries(e).filter(([k]) => k !== 'traceId' && k !== 'spanId');
  if (src.traceId.length > 0) kept.push(['traceId', hex(src.traceId)]);
  if (src.spanId.length > 0) kept.push(['spanId', hex(src.spanId)]);
  return Object.fromEntries(kept);
}

/** Point JSON without the fields that live on the record; exemplar ids as hex like OTLP JSON. */
function pointJson(schema: DescMessage, dp: PointLike): JsonValue {
  const entries = Object.entries(toJson(schema, dp as never) as JsonObject)
    .filter(([k]) => !RECORD_LEVEL_POINT_FIELDS.has(k))
    .map(([k, v]): [string, JsonValue] => {
      if (k !== 'exemplars' || !Array.isArray(v)) return [k, v];
      return [
        k,
        v.map((e, i) => {
          const src = dp.exemplars?.[i];
          return src === undefined ? e : withHexIds(e, src);
        }),
      ];
    });
  return Object.fromEntries(entries);
}

interface MetricShape {
  readonly type: MetricPointRecord['type'];
  readonly temporality: MetricPointRecord['temporality'];
  readonly monotonic: boolean;
  readonly schema: DescMessage;
  readonly points: readonly PointLike[];
}

function metricShape(m: Metric): MetricShape | null {
  const d = m.data;
  switch (d.case) {
    case 'gauge':
      return {
        type: 'gauge',
        temporality: 'unspecified',
        monotonic: false,
        schema: NumberDataPointSchema,
        points: d.value.dataPoints,
      };
    case 'sum':
      return {
        type: 'sum',
        temporality: temporality(d.value.aggregationTemporality),
        monotonic: d.value.isMonotonic,
        schema: NumberDataPointSchema,
        points: d.value.dataPoints,
      };
    case 'histogram':
      return {
        type: 'histogram',
        temporality: temporality(d.value.aggregationTemporality),
        monotonic: false,
        schema: HistogramDataPointSchema,
        points: d.value.dataPoints,
      };
    case 'exponentialHistogram':
      return {
        type: 'exponentialHistogram',
        temporality: temporality(d.value.aggregationTemporality),
        monotonic: false,
        schema: ExponentialHistogramDataPointSchema,
        points: d.value.dataPoints,
      };
    case 'summary':
      return {
        type: 'summary',
        temporality: 'unspecified',
        monotonic: false,
        schema: SummaryDataPointSchema,
        points: d.value.dataPoints,
      };
    case undefined:
      return null;
  }
}

export function normalizeMetrics(
  req: ExportMetricsServiceRequest,
  ctx: NormalizeContext,
  source: string,
  first = 0,
): MetricPointRecord[] {
  return [...metricRecords(req, ctx, source, first)];
}

/** `normalizeMetrics` one point at a time: each call walks the request again and yields equal records. */
export function* metricRecords(
  req: ExportMetricsServiceRequest,
  ctx: NormalizeContext,
  source: string,
  first = 0,
): Generator<MetricPointRecord, void, void> {
  for (const [ri, rm] of req.resourceMetrics.entries()) {
    const rp = `resourceMetrics[${first + ri}]`;
    const resource = internResource(rm.resource, rm.schemaUrl, ctx, `${source}: ${rp}`);
    for (const [si, sm] of rm.scopeMetrics.entries()) {
      const sp = `${rp}.scopeMetrics[${si}]`;
      const scope = internScope(sm.scope, sm.schemaUrl, ctx, `${source}: ${sp}`);
      for (const [mi, m] of sm.metrics.entries()) {
        const shape = metricShape(m);
        if (shape === null) continue;
        // Path builders made once per metric and read only for an error, while `di` is the failing point's.
        let di = 0;
        const p = (): string => `${source}: ${sp}.metrics[${mi}].${m.data.case}.dataPoints[${di}]`;
        const startPath = (): string => `${p()}.startTimeUnixNano`;
        const timePath = (): string => `${p()}.timeUnixNano`;
        const attributesPath = (): string => `${p()}.attributes`;
        for (; di < shape.points.length; di++) {
          const dp = shape.points[di] as (typeof shape.points)[number];
          yield {
            name: m.name,
            description: m.description,
            unit: m.unit,
            type: shape.type,
            temporality: shape.temporality,
            monotonic: shape.monotonic,
            start: relOrNull(dp.startTimeUnixNano, ctx, startPath),
            time: rel(dp.timeUnixNano, ctx, timePath),
            attributes: convertAttributes(dp.attributes, attributesPath),
            flags: dp.flags,
            point: pointJson(shape.schema, dp),
            resource,
            scope,
          };
        }
      }
    }
  }
}

/**
 * The earliest non-zero timestamp in the request (span start, log time or observed time, metric point
 * time), used to pick the report epoch. Zero means "unset" and is ignored. Null when there is none.
 */
export function earliestTimestamp(req: OtlpRequest): UnixNanos | null {
  let min: bigint | null = null;
  const see = (t: bigint): void => {
    if (t !== 0n && (min === null || t < min)) min = t;
  };
  switch (req.signal) {
    case 'traces':
      for (const rs of req.request.resourceSpans)
        for (const ss of rs.scopeSpans) for (const s of ss.spans) see(s.startTimeUnixNano);
      break;
    case 'logs':
      for (const rl of req.request.resourceLogs)
        for (const sl of rl.scopeLogs)
          for (const l of sl.logRecords) see(l.timeUnixNano !== 0n ? l.timeUnixNano : l.observedTimeUnixNano);
      break;
    case 'metrics':
      if (req.plain !== undefined) {
        if (req.plain.earliest !== null) see(req.plain.earliest);
        break;
      }
      for (const rm of req.request.resourceMetrics)
        for (const sm of rm.scopeMetrics)
          for (const m of sm.metrics) for (const dp of metricShape(m)?.points ?? []) see(dp.timeUnixNano);
      break;
  }
  return min === null ? null : parseUnixNanos(min, 'timestamp');
}

/** An exemplar of a metric point, decoded from the point JSON kept on the record. */
export interface PointExemplar {
  readonly time: RelNanos;
  readonly value: number;
  readonly traceId: TraceId | null;
  readonly spanId: SpanId | null;
  readonly attributes: Attributes;
}

function hexIdOrNull<T>(v: unknown, parse: (hex: string, path: string) => T, path: string): T | null {
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string') {
    throw new OtelHtmlError('invalid-otlp', { path, expected: 'a hex id', actual: JSON.stringify(v) });
  }
  return /^0+$/.test(v) ? null : parse(v, path);
}

/**
 * The exemplars of a point (`point.exemplars`, OTLP JSON with hex ids). An exemplar without a finite value is
 * left out; one without a time takes the point's. Times are relative to `epoch`.
 */
export function pointExemplars(p: MetricPointRecord, epoch: UnixNanos, at: Path): PointExemplar[] {
  const raw: unknown =
    typeof p.point === 'object' && p.point !== null ? Reflect.get(p.point, 'exemplars') : undefined;
  if (raw === undefined) return [];
  const path = pathText(at);
  if (!Array.isArray(raw)) {
    throw new OtelHtmlError('invalid-otlp', { path, expected: 'a list of exemplars', actual: typeof raw });
  }
  return raw.flatMap((e: unknown, i): PointExemplar[] => {
    const ep = `${path}[${i}]`;
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      throw new OtelHtmlError('invalid-otlp', {
        path: ep,
        expected: 'an exemplar object',
        actual: JSON.stringify(e),
      });
    }
    const { traceId, spanId, ...rest } = e as Record<string, unknown>;
    let msg: ReturnType<typeof fromJson<typeof ExemplarSchema>>;
    try {
      msg = fromJson(ExemplarSchema, rest as JsonValue);
    } catch (err) {
      throw new OtelHtmlError('invalid-otlp', {
        path: ep,
        expected: 'an OTLP exemplar',
        actual: err instanceof Error ? err.message : String(err),
      });
    }
    const v = msg.value;
    const value = v.case === 'asDouble' ? v.value : v.case === 'asInt' ? Number(v.value) : null;
    if (value === null || !Number.isFinite(value)) return [];
    return [
      {
        time:
          msg.timeUnixNano === 0n
            ? p.time
            : toRelNanos(parseUnixNanos(msg.timeUnixNano, `${ep}.timeUnixNano`), epoch, `${ep}.timeUnixNano`),
        value,
        traceId: hexIdOrNull(traceId, parseTraceId, `${ep}.traceId`),
        spanId: hexIdOrNull(spanId, parseSpanId, `${ep}.spanId`),
        attributes: convertAttributes(msg.filteredAttributes, `${ep}.filteredAttributes`),
      },
    ];
  });
}
