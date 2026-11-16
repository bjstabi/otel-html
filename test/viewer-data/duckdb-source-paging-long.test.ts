import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { buildFilter } from '../../src/query/sql/filter.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import type { SpanQuery } from '../../src/viewer/data/results.js';
import { type CountingEngine, openCountingEngine } from '../../test-support/scaling/counting-engine.js';
import { BASE, buildScalingReport, type ScalingReport } from '../../test-support/scaling/generator.js';

vi.setConfig({ testTimeout: 60_000 });

let report: ScalingReport;
let counting: CountingEngine;
beforeAll(async () => {
  report = await buildScalingReport({ ...BASE, spacing: 'sparse' });
  counting = await openCountingEngine(report.dir, report.manifest, { views: 'base' });
}, 180_000);
afterAll(async () => {
  await counting.close();
  await report.close();
});

const query = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: report.window,
  mode: 'spans',
  sort: { column: 'start', dir: 'desc' },
  limit: 5,
  groupBy: null,
  measureBy: null,
  needs: ['rows'],
  facetKeys: null,
  ...over,
});

/** The files each statement lists or, for the shared view, null. */
function recording() {
  const lists: (string[] | null)[] = [];
  const inner = counting.engine;
  const engine: QueryEngine = {
    ...inner,
    query: (q, signal) => {
      const text = String(q);
      if (text.includes('ORDER BY') && text.includes('"spans"')) {
        const listed = !text.includes('read_parquet([')
          ? []
          : [...text.matchAll(/'([^']+spans\.parquet)'/g)].map((m) => m[1] as string);
        lists.push(listed.length > 0 ? listed : null);
      }
      return inner.query(q, signal);
    },
  };
  return { lists, source: createDuckDbDataSource({ engine, manifest: report.manifest }) };
}

test('a query with only rows and a rollup-routed total reads the cutoff files on its first page', async () => {
  const { lists, source } = recording();
  const r = await source.querySpans(query({}));
  expect(r.rows).toHaveLength(5);
  const windowed = buildFilter({
    manifest: report.manifest,
    table: 'spans',
    condition: null,
    text: '',
    window: report.window,
    long: true,
  }).filter.files.files;
  expect(windowed.length).toBeGreaterThan(1);
  const [page] = lists;
  expect(page).not.toBeNull();
  expect(page?.length ?? 0).toBeLessThan(windowed.length);
});

test('a first page with raw facets reads every file of the window, as main', async () => {
  const { lists, source } = recording();
  await source.querySpans(query({ needs: ['rows', 'facets'] }));
  // the shared view with every file of the window, not a list of its own
  expect(lists[0]).toBeNull();
});
