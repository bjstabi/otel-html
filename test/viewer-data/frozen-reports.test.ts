import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tableFromIPC } from 'apache-arrow';
import { describe, expect, test } from 'vitest';
import { mergeWith } from '../../src/api/convert.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isPartitioned, parseAnyManifest } from '../../src/format/manifest.js';
import { TABLES } from '../../src/format/parquet/columns.js';
import { MANIFEST_KEY, partitionKey, partitionWrapperPath } from '../../src/format/paths.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { fromBase64 } from '../../src/viewer/data/engine/bytes.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { SpanQuery, TraceRow } from '../../src/viewer/data/results.js';
import { type Format4Fixture, openFixtureDb } from '../../test-support/format4-fixture.js';
import { createTestWriter } from '../../test-support/writer-deps.js';

const REPORTS = join(import.meta.dirname, '../../fixtures/reports');
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1));
}

/** Distinct trace ids in each frozen fixture (the three share one scenario; the count is the same in all). */
const FROZEN_TRACES = 80;

const query = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 1000,
  groupBy: null,
  measureBy: null,
  needs: ['rows', 'facets'],
  facetKeys: null,
  ...over,
});

/** The frozen fixture merged into a format-4 (`site`) report in memory, as `Format4Fixture` files. */
async function mergedFixture(name: string): Promise<Format4Fixture> {
  const w = createTestWriter();
  const root = join(REPORTS, name, 'data');
  for (const rel of filesUnder(root)) {
    await w.deps.fs.writeBytes(`${name}/data/${rel}`, readFileSync(join(root, rel)));
  }
  await mergeWith({ inputs: [name], out: 'm4', config: { writer: { format: 'site' } } }, w.deps);
  const text = w.fs.snapshot().get('m4/data/manifest.js');
  if (text === undefined) throw new Error('no manifest');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isPartitioned(manifest)) throw new Error('merge did not write format 4');
  const files = new Map<string, Uint8Array>();
  for (const partition of manifest.partitions) {
    for (const table of TABLES) {
      const file = partition.files[table];
      if (file !== undefined) files.set(file.path, await w.fs.readBytes(`m4/${file.path}`));
    }
  }
  return { manifest, files, epoch: BigInt(manifest.epochUnixNano) };
}

describe.each([
  ['format-1', 1],
  ['format-2', 2],
  ['format-3', 3],
  ['format-4', 4],
  ['format-5', 5],
])('the viewer opens frozen %s after merge', (name, version) => {
  test('reads the totals and one trace', async () => {
    const src = parseAnyManifest(
      reviveDataJson(
        unwrapDataFile(readFileSync(join(REPORTS, name, 'data/manifest.js'), 'utf8'), MANIFEST_KEY),
      ),
    );
    expect(src.formatVersion).toBe(version);
    const f = await mergedFixture(name);
    expect(f.manifest.totals).toEqual(src.totals);
    const db = await openFixtureDb(f);
    const ds = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
      manifest: f.manifest,
    });
    try {
      const spans = await ds.querySpans(query({}));
      expect(spans.total).toBe(src.totals.spans);
      expect(spans.total).toBeGreaterThan(0);

      const traces = await ds.querySpans(query({ mode: 'traces' }));
      expect(traces.total).toBe(FROZEN_TRACES);
      const first = traces.rows[0] as TraceRow | undefined;
      if (first === undefined) throw new Error('no trace row');
      const trace = await ds.getTrace(first.traceId);
      expect(trace.spans).toHaveLength(first.spans);
      expect(trace.tree.roots.length).toBeGreaterThan(0);
    } finally {
      await ds.close();
      db.close();
    }
  });
});

/** A frozen report read as written: its manifest, and every listed file decoded from its `.parquet.js` wrapper (as after `otel-html upgrade` of a local report). */
async function openAsWritten(name: string) {
  const root = join(REPORTS, name);
  const manifest = parseAnyManifest(
    reviveDataJson(unwrapDataFile(readFileSync(join(root, 'data/manifest.js'), 'utf8'), MANIFEST_KEY)),
  );
  if (!isPartitioned(manifest)) throw new Error(`the frozen report ${name} is not a partition report`);
  const files = new Map<string, Uint8Array>();
  for (const partition of manifest.partitions) {
    for (const table of TABLES) {
      const file = partition.files[table];
      if (file === undefined) continue;
      const wrapper = readFileSync(join(root, partitionWrapperPath(partition.n, table)), 'utf8');
      const payload = unwrapDataFile(wrapper, partitionKey(partition.n, table));
      if (typeof payload !== 'string') throw new Error(`${table} wrapper payload is not a string`);
      const decoded = fromBase64(payload);
      expect(Buffer.from(decoded).equals(readFileSync(join(root, file.path)))).toBe(true);
      expect(decoded.length).toBe(file.bytes);
      files.set(file.path, decoded);
    }
  }
  expect(files.size).toBeGreaterThan(0);
  const db = await openFixtureDb({ manifest, files, epoch: BigInt(manifest.epochUnixNano) });
  const ds = createDuckDbDataSource({
    engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
    manifest,
  });
  const count = async (table: string): Promise<number> => {
    const bytes = await db.connector.query({ type: 'arrow', sql: `SELECT count(*) AS n FROM ${table}` });
    const [row] = tableFromIPC(bytes).toArray() as { n: bigint | number }[];
    return Number(row?.n);
  };
  return {
    manifest,
    files,
    ds,
    count,
    close: async () => {
      await ds.close();
      db.close();
    },
  };
}

describe.each([
  ['format-4', 4],
  ['format-5', 5],
])('the viewer opens the frozen %s report as written', (name, version) => {
  test('its manifest and .parquet.js wrappers are read directly, as after `otel-html upgrade` of a local report', async () => {
    const r = await openAsWritten(name);
    try {
      expect(r.manifest.formatVersion).toBe(version);
      expect((await r.ds.querySpans(query({}))).total).toBe(1228);
      expect((await r.ds.querySpans(query({ mode: 'traces' }))).total).toBe(FROZEN_TRACES);
      // 10 metrics, counted once from the fixture (the points side of the Parquet files).
      expect((await r.ds.metricCatalog()).entries).toHaveLength(10);
    } finally {
      await r.close();
    }
  });
});

test('the frozen format-5 report opens and its checksums hold', async () => {
  const sums = new Map<string, string>();
  for (const line of readFileSync(join(REPORTS, 'SHA256SUMS'), 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) sums.set(m[2], m[1]);
  }
  const r = await openAsWritten('format-5');
  try {
    expect(r.manifest.formatVersion).toBe(5);
    for (const partition of r.manifest.partitions) {
      expect(Object.keys(partition.files).sort()).toEqual(['points', 'span_rollups', 'spans', 'traces']);
      for (const file of Object.values(partition.files)) {
        const digest = createHash('sha256')
          .update(readFileSync(join(REPORTS, 'format-5', file.path)))
          .digest('hex');
        expect(sums.get(`format-5/${file.path}`)).toBe(digest);
      }
    }
    expect(await r.count('span_rollups')).toBeGreaterThan(0);
    expect(await r.count('log_rollups')).toBe(0);
    expect((await r.ds.querySpans(query({}))).total).toBe(1228);
  } finally {
    await r.close();
  }
});

test('the frozen format-4 report still opens, with empty rollup views', async () => {
  const r = await openAsWritten('format-4');
  try {
    expect(await r.count('span_rollups')).toBe(0);
    expect(await r.count('log_rollups')).toBe(0);
  } finally {
    await r.close();
  }
});
