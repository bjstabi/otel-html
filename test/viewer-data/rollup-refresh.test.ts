import { describe, expect, test } from 'vitest';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { viewStatements } from '../../src/query/sql/views.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createViews, restoreViews } from '../../src/viewer/data/engine/files.js';
import type { Engine } from '../../src/viewer/data/engine/start.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import type { SpanQuery } from '../../src/viewer/data/results.js';
import { openTestDb } from '../../test-support/duckdb-node.js';
import { buildLayouts, longWindow } from '../../test-support/rollup-fixture.js';
import { openLayout } from './rollup-open.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const query = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 1,
  groupBy: null,
  measureBy: null,
  needs: ['total'],
  facetKeys: null,
  ...over,
});

describe('rollup views across a Refresh', () => {
  test('a statement of the old source that binds late neither takes the views nor hides the new partitions', async () => {
    const { A } = await buildLayouts();
    const full: ManifestV4 = A.fixture.manifest;
    const old: ManifestV4 = { ...full, partitions: full.partitions.slice(0, 4) };
    const db = await openTestDb();
    try {
      for (const [path, bytes] of A.fixture.files) db.registerFile(path, bytes);
      for (const sql of viewStatements(old, (p) => p, 'base')) db.exec(sql);
      // the old source's first statement is held where it loads the rollup files, as a slow fetch does
      let release: () => void = () => undefined;
      let held: Promise<void> = Promise.resolve();
      const inner = mosaicQueryEngine(createCoordinator(db.connector, silent), db);
      const engine: QueryEngine = {
        ...inner,
        prepare: async (paths, signal) => {
          await held;
          return inner.prepare(paths, signal);
        },
      };
      const epoch = BigInt(full.epochUnixNano);
      const window = longWindow(epoch);
      const first = createDuckDbDataSource({ engine, manifest: old });
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const late = first.querySpans(query({ window }));
      // the Refresh: the base views of the new manifest, the rollup views forgotten, a source over the new manifest
      const asEngine = { connection: { query: async (sql: string) => db.exec(sql) } } as unknown as Engine;
      await createViews(asEngine, full);
      const second = createDuckDbDataSource({ engine, manifest: full, replaceRollupViews: true });
      release();
      await expect(late).rejects.toMatchObject({ name: 'AbortError' });
      const [row] = db.rows(
        `SELECT count(*) AS n FROM spans WHERE start_time_unix_nano >= ${epoch + BigInt(window.start)} AND start_time_unix_nano < ${epoch + BigInt(window.end)}`,
      );
      const total = (await second.querySpans(query({ window }))).total;
      expect(total).toBe(Number(Reflect.get(row ?? {}, 'n')));
      const files = db.rows('SELECT count(DISTINCT filename) AS n FROM span_rollups');
      const listed = full.partitions.filter((p) => p.files.span_rollups !== undefined).length;
      expect(Number(Reflect.get(files[0] ?? {}, 'n'))).toBe(listed);
      // the old source's statement, late, changed nothing
      await expect(first.querySpans(query({ window }))).rejects.toMatchObject({ name: 'AbortError' });
      expect(
        Number(Reflect.get(db.rows('SELECT count(DISTINCT filename) AS n FROM span_rollups')[0] ?? {}, 'n')),
      ).toBe(listed);
    } finally {
      db.close();
    }
  });
});

describe('long windows far from the epoch', () => {
  test.each([
    ['at the epoch', 0n],
    ['200 days after it', -200n * 86_400n * 1_000_000_000n - 123n],
    ['two years after it', -730n * 86_400n * 1_000_000_000n - 987_654_321n],
  ])('a window %s is aligned in bigint and answers as it does at the epoch', async (_label, shift) => {
    const { A } = await buildLayouts();
    const near = await openLayout(A.fixture);
    // a report whose range is more than 2^53 ns from its epoch does not open at all; the window is what is far here
    const far = await openLayout({ ...A.fixture, manifest: { ...A.fixture.manifest, range: null } }, shift);
    try {
      const ask = (o: typeof near) =>
        o.ds.querySpans(query({ window: longWindow(o.epoch), needs: ['total'] }));
      const want = await ask(near);
      const got = await ask(far);
      expect(want.total).toBeGreaterThan(0);
      // a window far from the epoch is a pair of rounded numbers: the data source aligns it outward, so it may take the
      // spans of the grain beside each end; it never throws and never loses one
      expect(got.total).toBeGreaterThanOrEqual(want.total);
      expect(got.total).toBeLessThanOrEqual(want.total + 3);
      if (shift === 0n) expect(got.total).toBe(want.total);
    } finally {
      near.close();
      far.close();
    }
  });

  test('a failed Refresh puts the rollup views back for the source that bound them', async () => {
    const { A } = await buildLayouts();
    const full: ManifestV4 = A.fixture.manifest;
    const old: ManifestV4 = { ...full, partitions: full.partitions.slice(0, 4) };
    const db = await openTestDb();
    try {
      for (const [path, bytes] of A.fixture.files) db.registerFile(path, bytes);
      for (const sql of viewStatements(old, (p) => p, 'base')) db.exec(sql);
      const engine = mosaicQueryEngine(createCoordinator(db.connector, silent), db);
      const epoch = BigInt(full.epochUnixNano);
      const window = longWindow(epoch);
      const shown = createDuckDbDataSource({ engine, manifest: old });
      const before = (await shown.querySpans(query({ window }))).total;
      // the Refresh recreated the views for the new manifest (and forgot the rollup views), then failed
      const asEngine = { connection: { query: async (sql: string) => db.exec(sql) } } as unknown as Engine;
      await createViews(asEngine, full);
      await restoreViews(asEngine, old);
      // a statement the coordinator has not cached: the shown source bound its views once and will not again
      const after = await shown.querySpans(query({ window, needs: ['total', 'timeline'] }));
      expect(after.total).toBe(before);
      const listed = old.partitions.filter((p) => p.files.span_rollups !== undefined).length;
      expect(
        Number(Reflect.get(db.rows('SELECT count(DISTINCT filename) AS n FROM span_rollups')[0] ?? {}, 'n')),
      ).toBe(listed);
    } finally {
      db.close();
    }
  });
});
