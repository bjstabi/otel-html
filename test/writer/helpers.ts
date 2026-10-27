import { decodeColumns } from '../../src/format/columns.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { type Manifest, parseManifest } from '../../src/format/manifest.js';
import { chunkKey, MANIFEST_KEY, rollupKey, type Signal } from '../../src/format/paths.js';
import { LOG_COLUMNS, METRIC_COLUMNS, SPAN_COLUMNS } from '../../src/format/specs.js';
import type { LogRecordRecord, MetricPointRecord, SpanRecord } from '../../src/model/records.js';
import { LogRollups } from '../../src/rollups/log-rollups.js';
import { QUERY_FACET_CAPS } from '../../src/viewer/data/query-common.js';
import type { JsonObject } from '../../test-support/otlp-builders.js';
import { span, traceRequest } from '../../test-support/otlp-builders.js';
import type { TestWriter } from '../../test-support/writer-deps.js';
import { EPOCH_NS } from '../../test-support/writer-deps.js';

export function manifestOf(w: TestWriter, out: string): Manifest {
  const text = w.fs.snapshot().get(`${out}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  return parseManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
}

export function readChunk<R>(w: TestWriter, out: string, signal: Signal, n: number): R[] {
  const key = chunkKey(signal, n);
  const text = w.fs.snapshot().get(`${out}/data/${key}.js`);
  if (text === undefined) throw new Error(`no chunk ${key}`);
  const payload = reviveDataJson(unwrapDataFile(text, key));
  const spec = signal === 'spans' ? SPAN_COLUMNS : signal === 'logs' ? LOG_COLUMNS : METRIC_COLUMNS;
  return decodeColumns(spec as never, payload).rows as R[];
}

export function allSpans(w: TestWriter, out: string): SpanRecord[] {
  return manifestOf(w, out)
    .chunks.filter((c) => c.signal === 'spans')
    .flatMap((c) => readChunk<SpanRecord>(w, out, 'spans', c.n));
}

export function allLogs(w: TestWriter, out: string): LogRecordRecord[] {
  return manifestOf(w, out)
    .chunks.filter((c) => c.signal === 'logs')
    .flatMap((c) => readChunk<LogRecordRecord>(w, out, 'logs', c.n));
}

export function allPoints(w: TestWriter, out: string): MetricPointRecord[] {
  return manifestOf(w, out)
    .chunks.filter((c) => c.signal === 'metrics')
    .flatMap((c) => readChunk<MetricPointRecord>(w, out, 'metrics', c.n));
}

const hex = (n: number, len: number): string => n.toString(16).padStart(len, '0');
export const traceIdOf = (n: number): string => hex(n + 1, 32);
export const spanIdOf = (n: number): string => hex(n + 1, 16);

/** A trace request of `count` distinct spans in distinct traces, starting `offsetNs` after the test epoch. */
export function spansRequest(count: number, offsetNs = 0, firstIndex = 0): JsonObject {
  const base = BigInt(EPOCH_NS) + BigInt(offsetNs);
  const spans = Array.from({ length: count }, (_, i) =>
    span({
      traceId: traceIdOf(firstIndex + i),
      spanId: spanIdOf(firstIndex + i),
      startTimeUnixNano: String(base + BigInt(i) * 1000n),
      endTimeUnixNano: String(base + BigInt(i) * 1000n + 500n),
    }),
  );
  return traceRequest(spans, [{ key: 'service.name', value: { stringValue: 'svc' } }]);
}

/** The report's `data/rollups/logs.js`, decoded the way the viewer will. */
export function logRollupsOf(w: TestWriter, out: string): LogRollups {
  const text = w.fs.snapshot().get(`${out}/data/rollups/logs.js`);
  if (text === undefined) throw new Error('no log rollups');
  return LogRollups.from(reviveDataJson(unwrapDataFile(text, rollupKey('logs'))), QUERY_FACET_CAPS);
}
