import type { ConfigInput } from '../src/config/schema.js';
import { reviveDataJson, unwrapDataFile } from '../src/format/data-file.js';
import { ENGINE_VERSION } from '../src/format/engine.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../src/format/manifest.js';
import { TABLES } from '../src/format/parquet/columns.js';
import { MANIFEST_KEY } from '../src/format/paths.js';
import type { OtlpRequest } from '../src/model/otlp-json.js';
import { viewStatements } from '../src/query/sql/views.js';
import { openSession } from '../src/writer/session.js';
import { openTestDb, type TestDb } from './duckdb-node.js';
import { span, traceRequest } from './otlp-builders.js';
import { createTestWriter, EPOCH_NS, otlp, testConfig } from './writer-deps.js';

export interface Format4Fixture {
  manifest: ManifestV4;
  files: Map<string, Uint8Array>;
  epoch: bigint;
}

const OUT = 'r';

/** A `site`-format report written by the real partition session into a memory file system: one flush per `requests` entry, so each is a partition; `close: false` leaves them uncompacted. */
export async function buildFormat4Report(
  requests: readonly OtlpRequest[],
  opts: { config?: ConfigInput; close?: boolean } = {},
): Promise<Format4Fixture> {
  const w = createTestWriter();
  const config = testConfig({ ...opts.config, writer: { ...opts.config?.writer, format: 'site' } });
  const session = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
  let i = 0;
  for (const request of requests) {
    await session.add(request, `fixture:${i++}`);
    await session.flush();
  }
  if (opts.close !== false) await session.close();
  const text = w.fs.snapshot().get(`${OUT}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(manifest)) throw new Error('not a v4 manifest');
  const files = new Map<string, Uint8Array>();
  for (const partition of manifest.partitions) {
    for (const table of TABLES) {
      const file = partition.files[table];
      if (file !== undefined) files.set(file.path, await w.fs.readBytes(`${OUT}/${file.path}`));
    }
  }
  return { manifest, files, epoch: BigInt(manifest.epochUnixNano) };
}

/** `openTestDb()` with every listed file registered under its manifest path and the views created. */
export async function openFixtureDb(f: Format4Fixture): Promise<TestDb> {
  const db = await openTestDb();
  for (const [path, bytes] of f.files) db.registerFile(path, bytes);
  for (const sql of viewStatements(f.manifest, (p) => p)) db.exec(sql);
  return db;
}

let nextSpan = 0;

/** `n` spans in one trace over two services (OTLP JSON through `otlp()` of writer-deps.ts). */
export function spansOnlyRequest(n: number): OtlpRequest {
  // span ids are unique across calls, or the writer's dedupe would drop the repeats
  const first = nextSpan;
  nextSpan += n;
  const base = BigInt(EPOCH_NS);
  const hex = (k: number, width: number): string => k.toString(16).padStart(width, '0');
  const spans = Array.from({ length: n }, (_, k) =>
    span({
      traceId: hex(1, 32),
      spanId: hex(first + k + 1, 16),
      name: `op-${k}`,
      startTimeUnixNano: String(base + BigInt(k) * 1000n),
      endTimeUnixNano: String(base + BigInt(k) * 1000n + 500n),
    }),
  );
  const resource = (name: string) => [{ key: 'service.name', value: { stringValue: name } }];
  const half = Math.ceil(n / 2);
  const a = traceRequest(spans.slice(0, half), resource('svc-a'));
  const b = traceRequest(spans.slice(half), resource('svc-b'));
  // one request carrying both resources
  const resourceSpans = [
    ...((a as { resourceSpans: unknown[] }).resourceSpans ?? []),
    ...((b as { resourceSpans: unknown[] }).resourceSpans ?? []),
  ];
  return otlp({ resourceSpans } as never);
}

/** A valid v4 manifest with no partitions. */
export function emptyManifest(): ManifestV4 {
  return {
    formatVersion: 4,
    otelHtmlVersion: '0.0.0',
    title: 'empty',
    epochUnixNano: EPOCH_NS,
    createdAt: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    complete: true,
    range: null,
    totals: { spans: 0, logs: 0, metrics: 0 },
    partitions: [],
    statisticsKeys: { spans: [], logs: [], points: [], traces: [], patterns: [] },
    engine: { version: ENGINE_VERSION, format: 'site', assetsBase: 'assets/' },
    config: {
      viewer: {
        eagerBudgetBytes: 75_000_000,
        listCap: 10_000,
        theme: 'system',
        defaultDashboard: 'fusion',
        home: 'traces',
      },
      dashboards: [],
      views: [],
    },
  };
}
