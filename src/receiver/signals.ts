import { create, type DescMessage, type Message } from '@bufbuild/protobuf';
import type { GenService, GenServiceMethods } from '@bufbuild/protobuf/codegenv2';
import {
  ExportLogsServiceRequestSchema,
  ExportLogsServiceResponseSchema,
  LogsService,
} from '../model/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import {
  ExportMetricsServiceRequestSchema,
  ExportMetricsServiceResponseSchema,
  MetricsService,
} from '../model/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import {
  ExportTraceServiceRequestSchema,
  ExportTraceServiceResponseSchema,
  TraceService,
} from '../model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import type { Metric } from '../model/gen/opentelemetry/proto/metrics/v1/metrics_pb.js';
import type { OtlpRequest, OtlpSignal } from '../model/otlp-json.js';

/** What the receiver needs to know about one OTLP signal: its endpoint, gRPC service, messages and counting. */
export interface SignalService {
  readonly signal: OtlpSignal;
  readonly path: '/v1/traces' | '/v1/logs' | '/v1/metrics';
  readonly service: GenService<GenServiceMethods>;
  readonly request: DescMessage;
  readonly response: DescMessage;
  readonly rejectedField: 'rejectedSpans' | 'rejectedLogRecords' | 'rejectedDataPoints';
  /** The records (spans, log records or metric data points) an entry carries. */
  recordCount(entry: OtlpRequest): number;
  /** The export response: a `partialSuccess` only when something was rejected or there is a message to carry. */
  respond(accepted: number, rejected: number, errorMessage: string | null): Message;
}

function metricPoints(m: Metric): number {
  const d = m.data;
  switch (d.case) {
    case 'gauge':
    case 'sum':
    case 'histogram':
    case 'exponentialHistogram':
    case 'summary':
      return d.value.dataPoints.length;
    case undefined:
      return 0;
  }
}

/** Data points of a request `plainMetrics` accepted: only gauges and sums, read from the JSON it kept. */
function plainPoints(items: readonly unknown[]): number {
  let n = 0;
  for (const rm of items) {
    for (const sm of arrayField(rm, 'scopeMetrics')) {
      for (const m of arrayField(sm, 'metrics')) {
        const data = objectField(m, 'gauge') ?? objectField(m, 'sum');
        if (data !== null) n += arrayField(data, 'dataPoints').length;
      }
    }
  }
  return n;
}

function objectField(o: unknown, key: string): object | null {
  if (typeof o !== 'object' || o === null) return null;
  const v: unknown = Reflect.get(o, key);
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
}

function arrayField(o: unknown, key: string): readonly unknown[] {
  if (typeof o !== 'object' || o === null) return [];
  const v: unknown = Reflect.get(o, key);
  return Array.isArray(v) ? v : [];
}

function partial(rejected: number, errorMessage: string | null): boolean {
  return rejected > 0 || errorMessage !== null;
}

export const SIGNAL_SERVICES: readonly SignalService[] = [
  {
    signal: 'traces',
    path: '/v1/traces',
    service: TraceService,
    request: ExportTraceServiceRequestSchema,
    response: ExportTraceServiceResponseSchema,
    rejectedField: 'rejectedSpans',
    recordCount(entry) {
      if (entry.signal !== 'traces')
        throw new Error(`invariant violated: traces service counted a ${entry.signal} entry`);
      let n = 0;
      for (const rs of entry.request.resourceSpans) for (const ss of rs.scopeSpans) n += ss.spans.length;
      return n;
    },
    respond: (_accepted, rejected, errorMessage) =>
      create(
        ExportTraceServiceResponseSchema,
        partial(rejected, errorMessage)
          ? { partialSuccess: { rejectedSpans: BigInt(rejected), errorMessage: errorMessage ?? '' } }
          : {},
      ),
  },
  {
    signal: 'logs',
    path: '/v1/logs',
    service: LogsService,
    request: ExportLogsServiceRequestSchema,
    response: ExportLogsServiceResponseSchema,
    rejectedField: 'rejectedLogRecords',
    recordCount(entry) {
      if (entry.signal !== 'logs')
        throw new Error(`invariant violated: logs service counted a ${entry.signal} entry`);
      let n = 0;
      for (const rl of entry.request.resourceLogs) for (const sl of rl.scopeLogs) n += sl.logRecords.length;
      return n;
    },
    respond: (_accepted, rejected, errorMessage) =>
      create(
        ExportLogsServiceResponseSchema,
        partial(rejected, errorMessage)
          ? { partialSuccess: { rejectedLogRecords: BigInt(rejected), errorMessage: errorMessage ?? '' } }
          : {},
      ),
  },
  {
    signal: 'metrics',
    path: '/v1/metrics',
    service: MetricsService,
    request: ExportMetricsServiceRequestSchema,
    response: ExportMetricsServiceResponseSchema,
    rejectedField: 'rejectedDataPoints',
    recordCount(entry) {
      if (entry.signal !== 'metrics')
        throw new Error(`invariant violated: metrics service counted a ${entry.signal} entry`);
      // Reading `request` of a plain entry would decode the whole JSON, which `plain` exists to avoid.
      if (entry.plain !== undefined) return plainPoints(entry.plain.items);
      let n = 0;
      for (const rm of entry.request.resourceMetrics)
        for (const sm of rm.scopeMetrics) for (const m of sm.metrics) n += metricPoints(m);
      return n;
    },
    respond: (_accepted, rejected, errorMessage) =>
      create(
        ExportMetricsServiceResponseSchema,
        partial(rejected, errorMessage)
          ? { partialSuccess: { rejectedDataPoints: BigInt(rejected), errorMessage: errorMessage ?? '' } }
          : {},
      ),
  },
];

export function serviceOf(signal: OtlpSignal): SignalService {
  const found = SIGNAL_SERVICES.find((s) => s.signal === signal);
  if (found === undefined) throw new Error(`invariant violated: no service for signal ${signal}`);
  return found;
}

export function serviceAtPath(path: string): SignalService | undefined {
  return SIGNAL_SERVICES.find((s) => s.path === path);
}
