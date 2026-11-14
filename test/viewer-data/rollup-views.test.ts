import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createViews } from '../../src/viewer/data/engine/files.js';
import type { Engine } from '../../src/viewer/data/engine/start.js';
import type { SpanQuery } from '../../src/viewer/data/results.js';
import { costOf } from '../../test-support/scaling/cost.js';
import { type CountingEngine, openCountingEngine } from '../../test-support/scaling/counting-engine.js';
import { BASE, buildScalingReport, type ScalingReport } from '../../test-support/scaling/generator.js';

// Each test opens fresh DuckDB engines: about 1 s here, over 5 s on a Windows runner.
vi.setConfig({ testTimeout: 30_000 });

const query = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 100,
  groupBy: null,
  measureBy: null,
  needs: ['total'],
  facetKeys: null,
  ...over,
});

/** The manifest of the same report with its rollup files left out: a format-5 report that was written without rollups. */
function withoutRollups(m: ManifestV4): ManifestV4 {
  return {
    ...m,
    partitions: m.partitions.map((p) => {
      const files = { ...p.files };
      delete files.span_rollups;
      delete files.log_rollups;
      return { ...p, files };
    }),
  };
}

describe('lazy rollup views', () => {
  let report: ScalingReport;
  const opened: CountingEngine[] = [];
  const open = async (manifest: ManifestV4): Promise<CountingEngine> => {
    // the five base views at open, as a page makes them; the rollup views are the data source's to bind
    const c = await openCountingEngine(report.dir, manifest, { views: 'base' });
    opened.push(c);
    return c;
  };

  beforeAll(async () => {
    report = await buildScalingReport({ ...BASE, spacing: 'sparse' });
  }, 180_000);
  afterAll(async () => {
    for (const c of opened) await c.close();
    await report.close();
  });

  test('opening a format-5 report costs the same serial requests as the same report without rollup files', async () => {
    const withRollups = await open(report.manifest);
    const without = await open(withoutRollups(report.manifest));
    expect(report.manifest.partitions.some((p) => p.files.span_rollups !== undefined)).toBe(true);
    expect(withRollups.opened.some((e) => e.path.includes('_rollups'))).toBe(false);
    const a = costOf(withRollups.opened, new Map());
    const b = costOf(without.opened, new Map());
    expect(a.serial).toBeGreaterThan(0);
    expect(a.serial).toBe(b.serial);
  });

  test('a statement the router sends to the rollups binds their views, once; the next one finds them', async () => {
    const c = await open(report.manifest);
    const ds = createDuckDbDataSource({ engine: c.engine, manifest: report.manifest });
    await c.cold();
    expect(c.opened.length).toBeGreaterThanOrEqual(0);
    await ds.querySpans(query({ window: report.window, needs: ['total'] }));
    const first = await c.take();
    const prepared = c.prepared();
    // the rollup files are read (whole, being small) and the views bound over all of them
    expect(
      first.some((e) => e.path.includes('_rollups')) ||
        [...prepared.keys()].some((p) => p.includes('_rollups')),
    ).toBe(true);
    // a second statement of the same source binds nothing again
    await ds.querySpans(query({ window: report.window, needs: ['timeline'] }));
    const second = await c.take();
    expect(second.filter((e) => e.kind === 'open' && e.path.includes('span_rollups'))).toEqual([]);
  });

  test('a page that asks for rows, a short window or attribute facets never binds them', async () => {
    const c = await open(report.manifest);
    const ds = createDuckDbDataSource({ engine: c.engine, manifest: report.manifest });
    await c.cold();
    await ds.querySpans(
      query({ window: report.window, needs: ['rows', 'facets'], facetKeys: ['http.route'] }),
    );
    await ds.querySpans(
      query({
        window: { start: report.window.start, end: report.window.start + 1e9 },
        needs: ['total', 'timeline'],
      }),
    );
    const events = await c.take();
    expect(events.some((e) => e.path.includes('_rollups'))).toBe(false);
    expect([...c.prepared().keys()].some((p) => p.includes('_rollups'))).toBe(false);
  });

  test('a Refresh forgets the rollup views; the next statement binds the new file list', async () => {
    const c = await open(report.manifest);
    const asEngine = { connection: { query: (sql: string) => c.engine.exec(sql) } } as unknown as Engine;
    const first = createDuckDbDataSource({ engine: c.engine, manifest: report.manifest });
    const before = await first.querySpans(query({ window: report.window }));
    expect(before.total).toBeGreaterThan(0);
    // what the refresh does: the base views again, the rollup views dropped
    await createViews(asEngine, report.manifest);
    // the source of the new manifest has not bound them: its first measures statement does, and answers
    const second = createDuckDbDataSource({ engine: c.engine, manifest: report.manifest });
    c.engine.clearCache();
    const after = await second.querySpans(query({ window: report.window }));
    expect(after.total).toBe(before.total);
  });
});
