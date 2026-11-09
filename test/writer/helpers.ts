import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import type { Table } from '../../src/format/parquet/columns.js';
import type { Row } from '../../src/format/parquet/rows.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import type { JsonObject } from '../../test-support/otlp-builders.js';
import { span, traceRequest } from '../../test-support/otlp-builders.js';
import type { TestWriter } from '../../test-support/writer-deps.js';
import { EPOCH_NS } from '../../test-support/writer-deps.js';

export function manifestOf(w: TestWriter, out: string): ManifestV4 {
  const text = w.fs.snapshot().get(`${out}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  const m = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(m)) throw new Error('not a v4 manifest');
  return m;
}

/** Every row of one table across the report's partitions, in partition order, as the Parquet files decode. */
export function tableRowsOf(w: TestWriter, out: string, table: Table): Row[] {
  const bytes = w.fs.snapshotBytes();
  return manifestOf(w, out).partitions.flatMap((p) => {
    const file = p.files[table];
    if (file === undefined) return [];
    const b = bytes.get(`${out}/${file.path}`);
    if (b === undefined) throw new Error(`no partition file ${file.path}`);
    return decodeTable(table, b);
  });
}

export const allSpans = (w: TestWriter, out: string): Row[] => tableRowsOf(w, out, 'spans');
export const allLogs = (w: TestWriter, out: string): Row[] => tableRowsOf(w, out, 'logs');
export const allPoints = (w: TestWriter, out: string): Row[] => tableRowsOf(w, out, 'points');

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

/** A monotonic cumulative counter with explicit starts: one point per `[seconds, value, startSeconds]`. */
export function cumulativeRequest(
  name: string,
  points: readonly (readonly [number, number, number])[],
  attributes: readonly JsonObject[] = [],
): JsonObject {
  const base = BigInt(EPOCH_NS);
  const json = JSON.parse(JSON.stringify(counterRequest(name, [], attributes)));
  json.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints = points.map(([s, v, start]) => ({
    attributes,
    startTimeUnixNano: String(base + BigInt(start) * SEC),
    timeUnixNano: String(base + BigInt(s) * SEC),
    asInt: String(v),
  }));
  return json;
}

const REPORTS = join(import.meta.dirname, '../../fixtures/reports');

/** Copies the frozen `fixtures/reports/<fixture>` report (frozen format 1 to 4) into the writer's file system at `out`. */
export async function copyFrozenReport(w: TestWriter, out: string, fixture = 'format-3'): Promise<void> {
  const root = join(REPORTS, fixture, 'data');
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = join(e.parentPath, e.name).slice(root.length + 1);
    await w.deps.fs.writeBytes(`${out}/data/${rel}`, readFileSync(join(root, rel)));
  }
}

/** One cell of a decoded table row. */
export const cell = (row: Row | undefined, column: string): unknown =>
  row === undefined ? undefined : Reflect.get(row, column);
