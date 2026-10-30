import { fromJson, toJson } from '@bufbuild/protobuf';
import { ROOT_CONTEXT, SeverityNumber, trace } from '@opentelemetry/api';
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { ExportLogsServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import { readableLogRecordsToRequest } from '../../src/model/sdk-logs.js';

function collectLogs(): ReadableLogRecord[] {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': 'svc', 'service.version': '1.2.3' }),
    processors: [new SimpleLogRecordProcessor({ exporter: exporter })],
  });
  const a = provider.getLogger('scope-a', '1.0.0');
  const b = provider.getLogger('scope-b', '2.0.0', {
    schemaUrl: 'https://example.com/schema',
    attributes: { 'scope.k': 'v' },
  });

  a.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: 'hello',
    attributes: {
      s: 'str',
      i: 42,
      d: 1.5,
      t: true,
      sa: ['x', 'y'],
      ia: [1, 2, 3],
      da: [0.5, 1.5],
      ba: [true, false],
    },
  });
  b.emit({ severityNumber: SeverityNumber.ERROR, body: { k: 'v', n: 3, nested: { z: [1, 'two'] } } });
  a.emit({ severityNumber: SeverityNumber.WARN, body: ['a', 1, true, new Uint8Array([1, 2, 3])] });
  b.emit({ body: 'named', eventName: 'my.event' });

  const span = new BasicTracerProvider().getTracer('t').startSpan('s');
  a.emit({ body: 'in span', context: trace.setSpan(ROOT_CONTEXT, span) });
  return exporter.getFinishedLogRecords();
}

const ID_KEYS = new Set(['traceId', 'spanId']);

// The upstream serializer emits OTLP/JSON hex ids; protobuf-es JSON uses base64 for bytes.
function hexIdsToBase64(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(hexIdsToBase64);
  if (typeof v !== 'object' || v === null) return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [
      k,
      ID_KEYS.has(k) && typeof x === 'string' ? Buffer.from(x, 'hex').toString('base64') : hexIdsToBase64(x),
    ]),
  );
}

describe('readableLogRecordsToRequest', () => {
  it('matches the upstream OTLP JSON serializer', () => {
    const logs = collectLogs();
    const actual = toJson(ExportLogsServiceRequestSchema, readableLogRecordsToRequest(logs));
    const oracle: unknown = JSON.parse(new TextDecoder().decode(JsonLogsSerializer.serializeRequest(logs)));
    const expected = toJson(
      ExportLogsServiceRequestSchema,
      fromJson(ExportLogsServiceRequestSchema, hexIdsToBase64(oracle) as never),
    );
    expect(actual).toEqual(expected);
  });

  it('groups by scope preserving order and carries trace context, event name and scope fields', () => {
    const req = readableLogRecordsToRequest(collectLogs());
    expect(req.resourceLogs).toHaveLength(1);
    const scopes = req.resourceLogs.flatMap((r) => r.scopeLogs);
    expect(scopes.map((x) => x.scope?.name)).toEqual(['scope-a', 'scope-b']);
    expect(scopes[1]?.schemaUrl).toBe('https://example.com/schema');
    expect(scopes[1]?.scope?.attributes.map((k) => k.key)).toEqual(['scope.k']);
    const all = scopes.flatMap((x) => x.logRecords);
    expect(all).toHaveLength(5);
    expect(all.find((l) => l.eventName === 'my.event')).toBeDefined();
    const traced = all.find((l) => l.body?.value.value === 'in span');
    expect(traced?.traceId).toHaveLength(16);
    expect(traced?.spanId).toHaveLength(8);
    expect(all.find((l) => l.body?.value.value === 'hello')?.traceId).toHaveLength(0);
  });

  it('returns an empty request for no records', () => {
    expect(readableLogRecordsToRequest([]).resourceLogs).toEqual([]);
  });
});
