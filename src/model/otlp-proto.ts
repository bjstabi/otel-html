import { type DescMessage, fromBinary } from '@bufbuild/protobuf';
import { OtelHtmlError } from './errors.js';
import { ExportLogsServiceRequestSchema } from './gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import { ExportMetricsServiceRequestSchema } from './gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import { ExportTraceServiceRequestSchema } from './gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import type { OtlpRequest } from './otlp-json.js';

const SCHEMAS: Record<OtlpRequest['signal'], DescMessage> = {
  traces: ExportTraceServiceRequestSchema,
  logs: ExportLogsServiceRequestSchema,
  metrics: ExportMetricsServiceRequestSchema,
};

export function parseOtlpProtobuf(
  bytes: Uint8Array,
  signal: OtlpRequest['signal'],
  source: string,
): OtlpRequest {
  try {
    const request = fromBinary(SCHEMAS[signal], bytes);
    return { signal, request } as OtlpRequest;
  } catch (e) {
    throw new OtelHtmlError('invalid-otlp', {
      message: `${source}: invalid OTLP protobuf (${signal}): ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
