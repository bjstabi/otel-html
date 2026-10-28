import { decodeColumns } from '../../src/format/columns.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { type Manifest, parseManifest } from '../../src/format/manifest.js';
import { type LevelFile, parseLevelFile } from '../../src/format/metric-files.js';
import { chunkKey, MANIFEST_KEY, rollupKey, type Signal } from '../../src/format/paths.js';
import { LOG_COLUMNS, METRIC_COLUMNS, SPAN_COLUMNS } from '../../src/format/specs.js';
import type { LogRecordRecord, MetricPointRecord, SpanRecord } from '../../src/model/records.js';
import { LogRollups } from '../../src/rollups/log-rollups.js';
import { MetricCatalog } from '../../src/rollups/metric-catalog.js';
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

/** A data file of the report by its layout path, unwrapped with the key the path implies. */
export function readDataFile(w: TestWriter, out: string, path: string): unknown {
  const text = w.fs.snapshot().get(`${out}/${path}`);
  if (text === undefined) throw new Error(`no file ${path}`);
  return reviveDataJson(unwrapDataFile(text, path.slice('data/'.length, -'.js'.length)));
}

/** Files on disk under `data/metrics/`, as layout paths. */
export function metricFilesOnDisk(w: TestWriter, out: string): string[] {
  return [...w.fs.snapshot().keys()]
    .filter((k) => k.startsWith(`${out}/data/metrics/`))
    .map((k) => k.slice(out.length + 1))
    .sort();
}

/** The listed level files of metric `id`, decoded, finest first. */
export function levelsOf(w: TestWriter, out: string, id: number): LevelFile[] {
  const prefix = `data/metrics/${String(id).padStart(6, '0')}/l`;
  return manifestOf(w, out)
    .metricFiles.filter((p) => p.startsWith(prefix))
    .sort()
    .map((p) => parseLevelFile(readDataFile(w, out, p), p));
}

export function metricCatalogOf(w: TestWriter, out: string): MetricCatalog {
  const raw = readDataFile(w, out, 'data/rollups/metrics.js');
  const catalog = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'catalog') : undefined;
  return MetricCatalog.from(catalog, { seriesCap: 1000 });
}

const SEC = 1_000_000_000n;

/**
 * A monotonic cumulative counter: one point per `[seconds, value]`, all started at the test epoch (so the first
 * value counts in full).
 */
export function counterRequest(
  name: string,
  points: readonly (readonly [number, number])[],
  attributes: readonly JsonObject[] = [],
): JsonObject {
  const base = BigInt(EPOCH_NS);
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        scopeMetrics: [
          {
            scope: { name: 'test-scope' },
            metrics: [
              {
                name,
                unit: '1',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: points.map(([s, v]) => ({
                    attributes,
                    startTimeUnixNano: String(base),
                    timeUnixNano: String(base + BigInt(s) * SEC),
                    asInt: String(v),
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
