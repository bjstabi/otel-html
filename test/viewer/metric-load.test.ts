import { beforeAll, describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile, wrapDataFile } from '../../src/format/data-file.js';
import {
  encodeExemplarFile,
  encodeSeriesFile,
  LEVEL0_WIDTH_NS,
  parseExemplarFile,
  parseLevelFile,
  parseSeriesFile,
} from '../../src/format/metric-files.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { loadMetric, loadMetricCatalog } from '../../src/viewer/data/metric-load.js';
import {
  defaultShow,
  type MetricQuery,
  NOTES,
  runMetricQuery,
  showOptions,
} from '../../src/viewer/data/metric-query.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';
import {
  buildCounterRun,
  buildMetricReports,
  buildSummaryRun,
  buildUnfinishedRun,
  type Fixture,
} from './report-fixture.js';

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

  test('a level holding a series id past the catalog count leaves it out, like series.js', async () => {
    const path = 'data/metrics/000000/l1.js';
    const key = 'metrics/000000/l1';
    const l1 = parseLevelFile(
      reviveDataJson(unwrapDataFile(reports.compacted.files.get(path) ?? '', key)),
      path,
    );
    const extra = { id: 99, t: [0], a: [{ k: 'counter', delta: 1, resets: 0 }] };
    const files = new Map(reports.compacted.files).set(
      path,
      wrapDataFile(key, { ...l1, series: [...l1.series, extra] }),
    );
    const m = await load(reports.compacted, 0, files);
    const level = await m.level(1);
    expect(m.series).toHaveLength(3);
    expect([...level.series.keys()]).toEqual([0, 1, 2]);
  });

  test('an unfinished report merges every segment: buckets and exemplars of each flush are all there', async () => {
    const f = await buildUnfinishedRun({ flushes: 3, pointsPerFlush: 4, series: 2 });
    const segments = f.manifest.metricFiles.filter((p) => p.includes('/seg-'));
    expect(segments).toHaveLength(3);
    const loader = createScriptedLoader(f.files);
    const m = await loadMetric(loader, f.manifest, 0);
    expect(m.fromSegments).toBe(true);
    const l0 = await m.level(0);
    // 12 points per series, 10 s apart: 12 level-0 buckets each (10 s spans ~10 buckets of 1.024 s).
    expect([...l0.series.values()].map((s) => s.t.length)).toEqual([12, 12]);
    // 12 points × 2 series exemplars, from all three segments, in time order.
    expect(l0.exemplars).toHaveLength(24);
    const times = l0.exemplars.map((e) => e.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(l0.exemplars.map((e) => e.traceId)).size).toBe(12);
    for (const p of segments) expect(loader.calls).toContain(p);
  });

  test('an exemplar whose series is past the catalog count is left out, like a stray series', async () => {
    const f = await buildCounterRun({ durationS: 600, stepS: 10, series: 2, exemplars: true });
    const path = 'data/metrics/000000/ex.js';
    const key = 'metrics/000000/ex';
    const ex = parseExemplarFile(reviveDataJson(unwrapDataFile(f.files.get(path) ?? '', key)), path);
    const first = ex.exemplars[0];
    if (first === undefined) throw new Error('the run has no exemplars');
    const stray = { ...first, series: 99, time: first.time + 1 };
    const files = new Map(f.files).set(
      path,
      wrapDataFile(key, encodeExemplarFile({ ...ex, exemplars: [...ex.exemplars, stray] })),
    );
    const m = await load(f, 0, files);
    const level = await m.level(0);
    expect(level.exemplars.some((e) => e.series === 99)).toBe(false);
    expect(level.exemplars).toHaveLength(ex.exemplars.length);
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
    // Levels 0-2 share ex.js, read once. Level 0 spans two pages (buckets 0, 976 and 4882), read without a window.
    expect(loader.calls).toEqual(['data/metrics/000000/l0-000000.js', 'data/metrics/000000/l0-000002.js']);
    expect((await m.level(0)).series.get(0)?.t).toEqual([0, 976, 4882]);
    // A window reads only the page under it, and shares the file with the whole-level read.
    loader.reset();
    const late = await m.level(0, { start: 4882 * LEVEL0_WIDTH_NS, end: 4883 * LEVEL0_WIDTH_NS });
    expect(loader.calls).toEqual([]);
    expect(late.series.get(0)?.t).toEqual([4882]);
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

  test('summary quantile options come from series.js, so one dropped early still shows without level 0 (#39)', async () => {
    // An hour at 1 s: levels 0 and 1 (8.192 s buckets). q0.99 is sent for the first 4 s only, so level 1's first
    // bucket (last point per bucket) has no q0.99 and the coarsest level would miss it.
    const f = await buildSummaryRun({ durationS: 3600, stepS: 1, dropAfterS: 4 });
    const loader = createScriptedLoader(f.files);
    const m = await loadMetric(loader, f.manifest, 0);
    expect(m.levels.map((l) => l.level)).toEqual([0, 1]);
    expect(m.quantiles).toEqual([0.5, 0.99]);
    expect(await showOptions(m)).toEqual(['q0.5', 'q0.99', 'count', 'sum']);
    expect(await defaultShow(m)).toBe('q0.99');
    expect(loader.calls.filter((p) => /\/l[0-6]\.js$/.test(p))).toEqual([]);
    const range = f.manifest.range ?? { start: 0, end: 0 };
    const q: MetricQuery = {
      id: 'a',
      metric: 'run.latency',
      kind: null,
      unit: null,
      by: [],
      where: null,
      fn: [],
      alias: null,
      hidden: false,
      show: 'q0.99',
    };
    expect((await runMetricQuery(m, q, range, 600)).notes).not.toContain(NOTES.quantilesFromLevel);

    // A report from before the set was recorded: the options come from the coarsest level and the chart says so.
    const path = 'data/metrics/000000/series.js';
    const key = 'metrics/000000/series';
    const parsed = parseSeriesFile(reviveDataJson(unwrapDataFile(f.files.get(path) ?? '', key)), path);
    const { quantiles: _dropped, ...withoutQuantiles } = parsed;
    const files = new Map(f.files).set(path, wrapDataFile(key, encodeSeriesFile(withoutQuantiles)));
    const oldLoader = createScriptedLoader(files);
    const old = await loadMetric(oldLoader, f.manifest, 0);
    expect(old.quantiles).toBeNull();
    expect(await showOptions(old)).toEqual(['q0.5', 'count', 'sum']);
    expect(oldLoader.calls.filter((p) => /\/l[0-6]\.js$/.test(p))).toEqual(['data/metrics/000000/l1.js']);
    expect((await runMetricQuery(old, q, range, 600)).notes).toContain(NOTES.quantilesFromLevel);
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
