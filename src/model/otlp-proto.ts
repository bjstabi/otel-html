import { type DescMessage, fromBinary } from '@bufbuild/protobuf';
import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';
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

/** Field 1 of every Export*ServiceRequest: its repeated resource entries. */
const RESOURCES_FIELD = 1;

function invalid(e: unknown, signal: OtlpRequest['signal'], source: string): OtelHtmlError {
  return new OtelHtmlError('invalid-otlp', {
    message: `${source}: invalid OTLP protobuf (${signal}): ${e instanceof Error ? e.message : String(e)}`,
  });
}

export function parseOtlpProtobuf(
  bytes: Uint8Array,
  signal: OtlpRequest['signal'],
  source: string,
): OtlpRequest {
  try {
    const request = fromBinary(SCHEMAS[signal], bytes);
    return { signal, request } as OtlpRequest;
  } catch (e) {
    throw invalid(e, signal, source);
  }
}

/**
 * Reads a protobuf Export*ServiceRequest one resource entry at a time: each encoded entry (field 1) is itself a
 * valid request holding just that entry, so it is decoded on its own and the whole message is never decoded at
 * once. Other top-level fields are skipped. An empty message yields one empty request.
 */
export function* streamOtlpProtobuf(
  bytes: Uint8Array,
  signal: OtlpRequest['signal'],
  source: string,
): Generator<OtlpRequest, void, undefined> {
  const reader = new BinaryReader(bytes);
  let entries = 0;
  while (reader.pos < reader.len) {
    let entry: Uint8Array | null = null;
    try {
      const start = reader.pos;
      const [field, wire] = reader.tag();
      reader.skip(wire, field);
      if (field === RESOURCES_FIELD && wire === WireType.LengthDelimited) {
        entry = bytes.subarray(start, reader.pos);
      }
    } catch (e) {
      throw invalid(e, signal, source);
    }
    if (entry !== null) {
      entries++;
      yield parseOtlpProtobuf(entry, signal, source);
    }
  }
  if (entries === 0) yield parseOtlpProtobuf(new Uint8Array(), signal, source);
}
