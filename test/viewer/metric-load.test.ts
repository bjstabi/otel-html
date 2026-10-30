import { beforeAll, describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile, wrapDataFile } from '../../src/format/data-file.js';
import { encodeSeriesFile, LEVEL0_WIDTH_NS, parseSeriesFile } from '../../src/format/metric-files.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { loadMetric, loadMetricCatalog } from '../../src/viewer/data/metric-load.js';
import { type MetricQuery, runMetricQuery } from '../../src/viewer/data/metric-query.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';
import { buildCounterRun, buildMetricReports, type Fixture } from './report-fixture.js';

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
      for (const { level } of done.levels) {
        const [a, b] = await Promise.all([done.level(level), unfinished.level(level)]);
        expect(b.series).toEqual(a.series);
      }
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
    expect((await m.level(0)).series.get(0)?.t).toEqual([0, 976, 4882]);
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
    // Levels are read on demand: the bad file fails the chart that reads it.
    const m = await load(reports.compacted, 0, files);
    const e = await m.level(1).catch((x: unknown) => x);
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

  test('a finished report reads each level when first asked, once', async () => {
    const loader = createScriptedLoader(reports.compacted.files);
    const m = await loadMetric(loader, reports.compacted.manifest, 0);
    expect(loader.calls.filter((p) => p.startsWith('data/metrics/'))).toEqual([
      'data/metrics/000000/series.js',
    ]);
    loader.reset();
    const [a, b] = await Promise.all([m.level(1), m.level(1)]);
    expect(a).toBe(b);
    expect(await m.level(1)).toBe(a);
    expect([...loader.calls].sort()).toEqual(['data/metrics/000000/ex.js', 'data/metrics/000000/l1.js']);
    loader.reset();
    await m.level(0);
    // Levels 0-2 share ex.js, read once.
    expect(loader.calls).toEqual(['data/metrics/000000/l0.js']);
    await expect(m.level(5)).rejects.toMatchObject({ code: 'usage' });
  });

  test('a failed level read is tried again on the next call', async () => {
    const files = new Map(reports.compacted.files);
    const l1 = files.get('data/metrics/000000/l1.js') ?? '';
    files.delete('data/metrics/000000/l1.js');
    const m = await load(reports.compacted, 0, files);
    await expect(m.level(1)).rejects.toThrow(/l1\.js/);
    files.set('data/metrics/000000/l1.js', l1);
    expect((await m.level(1)).level).toBe(1);
  });

  test("a finished report carries its series' gaps; an unfinished one measures them on level 0", async () => {
    const done = await load(reports.compacted, 0);
    // Three points per series: two gaps each, 976 and 3906 level-0 buckets.
    expect(done.gaps).toEqual([
      { n: 2, median: 3906 },
      { n: 2, median: 3906 },
      { n: 2, median: 3906 },
    ]);
    expect((await load(reports.segments, 0)).gaps).toBeNull();
  });

  test('a format-1 report (no gaps in series.js) still charts alike, measuring gaps on level 0', async () => {
    // An hour of 10 s points: the interval (10 level-0 buckets) sets the width, so the gaps matter.
    const f = await buildCounterRun({ durationS: 3600, stepS: 10, series: 3 });
    const path = 'data/metrics/000000/series.js';
    const key = 'metrics/000000/series';
    const parsed = parseSeriesFile(reviveDataJson(unwrapDataFile(f.files.get(path) ?? '', key)), path);
    expect(parsed.gaps).toBeDefined();
    const files = new Map(f.files).set(
      path,
      wrapDataFile(key, encodeSeriesFile({ metric: parsed.metric, series: parsed.series })),
    );
    const v1 = { ...f, manifest: { ...f.manifest, formatVersion: 1 as const } };
    const old = await load(v1, 0, files);
    const now = await load(f, 0);
    expect(old.gaps).toBeNull();
    const range = f.manifest.range ?? { start: 0, end: 0 };
    const q: MetricQuery = {
      id: 'a',
      metric: now.entry.name,
      kind: null,
      unit: null,
      by: [],
      where: null,
      fn: [],
      alias: null,
      hidden: false,
      show: 'rate',
    };
    const [a, b] = await Promise.all([
      runMetricQuery(old, q, range, 1100),
      runMetricQuery(now, q, range, 1100),
    ]);
    // 8.192 s (level 1) would leave every other bucket empty: both widen to 16.384 s.
    expect(b.widthNs).toBe(LEVEL0_WIDTH_NS * 16);
    expect(a).toEqual(b);
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
