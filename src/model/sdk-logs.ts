import { create } from '@bufbuild/protobuf';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import {
  type ExportLogsServiceRequest,
  ExportLogsServiceRequestSchema,
} from './gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import { InstrumentationScopeSchema } from './gen/opentelemetry/proto/common/v1/common_pb.js';
import {
  type LogRecord,
  LogRecordSchema,
  type ResourceLogs,
  ResourceLogsSchema,
  type ScopeLogs,
  ScopeLogsSchema,
  type SeverityNumber,
} from './gen/opentelemetry/proto/logs/v1/logs_pb.js';
import { ResourceSchema } from './gen/opentelemetry/proto/resource/v1/resource_pb.js';
import { anyValueOf, attributesToKeyValues, hexToBytes, hrToNanos } from './sdk-spans.js';

function toLogRecord(log: ReadableLogRecord): LogRecord {
  const ctx = log.spanContext;
  return create(LogRecordSchema, {
    timeUnixNano: hrToNanos(log.hrTime),
    observedTimeUnixNano: hrToNanos(log.hrTimeObserved),
    // The SDK SeverityNumber (UNSPECIFIED=0 .. FATAL4=24) numerically matches OTLP's.
    severityNumber: (log.severityNumber ?? 0) as SeverityNumber,
    severityText: log.severityText ?? '',
    body: log.body === undefined ? undefined : anyValueOf(log.body),
    attributes: attributesToKeyValues(log.attributes),
    droppedAttributesCount: log.droppedAttributesCount,
    eventName: log.eventName ?? '',
    traceId: ctx ? hexToBytes(ctx.traceId) : new Uint8Array(),
    spanId: ctx ? hexToBytes(ctx.spanId) : new Uint8Array(),
    flags: ctx ? ctx.traceFlags : 0,
  });
}

/** Group SDK log records by resource, then by instrumentation scope (the SDK keeps both stable), first-seen order. */
export function readableLogRecordsToRequest(logs: readonly ReadableLogRecord[]): ExportLogsServiceRequest {
  const byResource = new Map<
    ReadableLogRecord['resource'],
    Map<ReadableLogRecord['instrumentationScope'], ReadableLogRecord[]>
  >();
  for (const log of logs) {
    let scopes = byResource.get(log.resource);
    if (!scopes) {
      scopes = new Map();
      byResource.set(log.resource, scopes);
    }
    const list = scopes.get(log.instrumentationScope);
    if (list) list.push(log);
    else scopes.set(log.instrumentationScope, [log]);
  }

  const resourceLogs: ResourceLogs[] = [];
  for (const [resource, scopes] of byResource) {
    const scopeLogs: ScopeLogs[] = [];
    for (const [sc, list] of scopes) {
      scopeLogs.push(
        create(ScopeLogsSchema, {
          scope: create(InstrumentationScopeSchema, {
            name: sc.name,
            version: sc.version ?? '',
            attributes: attributesToKeyValues(sc.attributes ?? {}),
            droppedAttributesCount: sc.droppedAttributesCount ?? 0,
          }),
          logRecords: list.map(toLogRecord),
          schemaUrl: sc.schemaUrl ?? '',
        }),
      );
    }
    resourceLogs.push(
      create(ResourceLogsSchema, {
        resource: create(ResourceSchema, { attributes: attributesToKeyValues(resource.attributes) }),
        scopeLogs,
        schemaUrl: resource.schemaUrl ?? '',
      }),
    );
  }
  return create(ExportLogsServiceRequestSchema, { resourceLogs });
}
