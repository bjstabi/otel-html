import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { mergeWith } from '../../src/api/convert.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, parseAnyManifest } from '../../src/format/manifest.js';
import { TABLES } from '../../src/format/parquet/columns.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
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
  if (!isV4(manifest)) throw new Error('merge did not write format 4');
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
