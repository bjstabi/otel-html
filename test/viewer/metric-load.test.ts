import { beforeAll, describe, expect, test } from 'vitest';
import { wrapDataFile } from '../../src/format/data-file.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { loadMetric, loadMetricCatalog } from '../../src/viewer/data/metric-load.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';
import { buildMetricReports, type Fixture } from './report-fixture.js';

let reports: { compacted: Fixture; segments: Fixture };
beforeAll(async () => {
  reports = await buildMetricReports();
});

const load = (f: Fixture, id: number, files: ReadonlyMap<string, string> = f.files) =>
  loadMetric(createScriptedLoader(files), f.manifest, id);

describe('loadMetric', () => {
  test('the fixture pair is a finished and an unfinished report', () => {
    expect(reports.compacted.manifest.complete).toBe(true);
    expect(reports.segments.manifest.complete).toBe(false);
    expect(reports.compacted.manifest.metricFiles).toContain('data/metrics/000000/l1.js');
    expect(reports.segments.manifest.metricFiles).toContain('data/metrics/000000/seg-000000.js');
    expect(reports.segments.manifest.metricFiles.some((p) => /\/l[0-6]\.js$/.test(p))).toBe(false);
  });

  test('segments only give the same levels and series as the compacted twin', async () => {
    for (const id of [0, 1, 2]) {
      const done = await load(reports.compacted, id);
      const unfinished = await load(reports.segments, id);
      expect(done.fromSegments).toBe(false);
      expect(unfinished.fromSegments).toBe(true);
      expect(done.levels.map((l) => l.level)).toEqual([0, 1]);
      expect(unfinished.levels).toEqual(done.levels);
      expect(unfinished.series).toEqual(done.series);
      expect(unfinished.entry.name).toBe(done.entry.name);
    }
  });

  test('series carry their resource and scope', async () => {
    const m = await load(reports.segments, 0);
    expect(m.series.map((s) => s.resource?.attributes.get('service.name'))).toEqual([
      { kind: 'string', value: 'checkout' },
      { kind: 'string', value: 'checkout' },
      { kind: 'string', value: 'payments' },
    ]);
    expect(m.series[0]?.scope?.name).toBe('test-scope');
    expect(m.levels[0]?.series.get(0)?.t).toEqual([0, 976, 4882]);
  });

  test('a listed file that fails its schema rejects with invalid-report naming the file', async () => {
    for (const [path, key] of [
      ['data/metrics/000000/seg-000000.js', 'metrics/000000/seg-000000'],
      ['data/metrics/000000/series.js', 'metrics/000000/series'],
    ] as const) {
      const files = new Map(reports.segments.files).set(path, wrapDataFile(key, { metric: 0 }));
      const e = await load(reports.segments, 0, files).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(OtelHtmlError);
      expect(e).toMatchObject({ code: 'invalid-report' });
      expect(String(e)).toContain(path);
    }
    const files = new Map(reports.compacted.files).set(
      'data/metrics/000000/l1.js',
      wrapDataFile('metrics/000000/l1', { metric: 0, level: 1 }),
    );
    const e = await load(reports.compacted, 0, files).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'invalid-report' });
    expect(String(e)).toContain('data/metrics/000000/l1.js');
  });

  test('loads only the files the manifest lists', async () => {
    const loader = createScriptedLoader(reports.compacted.files);
    await loadMetric(loader, reports.compacted.manifest, 1);
    const listed = new Set(reports.compacted.manifest.metricFiles);
    const metricCalls = loader.calls.filter((p) => p.startsWith('data/metrics/'));
    expect(metricCalls.length).toBeGreaterThan(0);
    expect(metricCalls.every((p) => listed.has(p) && p.startsWith('data/metrics/000001/'))).toBe(true);
  });

  test('an unknown metric id is a usage error', async () => {
    await expect(load(reports.compacted, 99)).rejects.toMatchObject({ code: 'usage' });
  });
});

describe('loadMetricCatalog', () => {
  test('yields the entries and interned resources without the series files', async () => {
    const loader = createScriptedLoader(reports.compacted.files);
    const catalog = await loadMetricCatalog(loader, reports.compacted.manifest);
    expect(catalog.entries().map((e) => [e.name, e.series])).toEqual([
      ['http.server.requests', 3],
      ['checkout.queue.depth', 1],
      ['payments.balance', 1],
    ]);
    expect(catalog.resources()).toHaveLength(2);
    expect(loader.calls).toEqual(['data/rollups/metrics.js']);
  });
});
