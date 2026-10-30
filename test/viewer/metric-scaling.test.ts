import { describe, expect, test } from 'vitest';
import { reviveDataJson } from '../../src/format/data-file.js';
import {
  LEVEL_MAX_BUCKETS,
  LEVEL0_WIDTH_NS,
  PAGE_BUCKETS,
  parseExemplarFile,
  parseLevelFile,
} from '../../src/format/metric-files.js';
import { loadMetric } from '../../src/viewer/data/metric-load.js';
import {
  type MetricQuery,
  runMetricQuery,
  runMetricQueryAtWidth,
} from '../../src/viewer/data/metric-query.js';
import type { ScriptLoader } from '../../src/viewer/data/script-loader.js';
import { maxPointsFor } from '../../src/viewer/metrics/use-metric-query.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';
import { buildCounterRun, type Fixture } from './report-fixture.js';

/**
 * Issue #37: the Explorer's first chart (full range, the Explorer's bucket count) loads a bounded amount of data
 * whatever the run length. Each run is written at 1×, 2× and 4× a base duration by the writer session `Report`
 * wraps (`Report` itself needs Node types this browser-side project has not), and what the chart loads is counted
 * from the files it reads. "Not in step" is under 1.5× from 2× to 4×: loading every level, or one exemplar file for
 * all levels, grows about 2×.
 */

const SERIES = 3;
/** The Explorer's bucket count before its card is measured, as in these tests. */
const MAX_POINTS = maxPointsFor(null);
/** Exemplars kept per series per bucket (`writer.metricExemplars` default). */
const EXEMPLARS_PER_BUCKET = 4;

/** Whole level and exemplar files, and their pages (format 3). */
const LEVEL_FILE = /\/l[0-6](?:-[0-9]{6})?\.js$/;
const EXEMPLAR_FILE = /\/ex[0-6]?(?:-[0-9]{6})?\.js$/;

interface Counted {
  loader: ScriptLoader;
  /** Level files read, in order. */
  levels: string[];
  buckets: number;
  exemplars: number;
}

/** A loader over the report's files that counts the buckets and exemplars of every level and exemplar file read. */
function counting(f: Fixture): Counted {
  const inner = createScriptedLoader(f.files);
  const c: Counted = {
    levels: [],
    buckets: 0,
    exemplars: 0,
    loader: {
      async load(path, key) {
        const raw = await inner.load(path, key);
        if (LEVEL_FILE.test(path)) {
          c.levels.push(path);
          for (const s of parseLevelFile(reviveDataJson(raw), path).series) c.buckets += s.t.length;
        }
        if (EXEMPLAR_FILE.test(path))
          c.exemplars += parseExemplarFile(reviveDataJson(raw), path).exemplars.length;
        return raw;
      },
    },
  };
  return c;
}

const RATE: MetricQuery = {
  id: 'a',
  metric: 'run.requests',
  kind: null,
  unit: null,
  by: [],
  where: null,
  fn: [],
  alias: null,
  hidden: false,
  show: 'rate',
};

/** Opens metric 0 and draws the Explorer's default first chart: the counter's rate over the whole run. */
async function firstChart(f: Fixture): Promise<Counted & { widthNs: number }> {
  const range = f.manifest.range;
  if (range === null) throw new Error('the run has no range');
  const c = counting(f);
  const m = await loadMetric(c.loader, f.manifest, 0);
  const r = await runMetricQuery(m, RATE, range, MAX_POINTS);
  expect(r.series).toHaveLength(1);
  return { ...c, widthNs: r.widthNs };
}

describe('the first chart loads a bounded amount of data whatever the run length', () => {
  test('buckets: at most series × LEVEL_MAX_BUCKETS, and not in step with the run from 2× to 4×', async () => {
    // At 2× the coarsest level (l1) has ~1,500 buckets; at 4× it would pass LEVEL_MAX_BUCKETS, so l2 appears.
    const BASE_S = 6144;
    const loads: number[] = [];
    for (const times of [1, 2, 4]) {
      const run = await buildCounterRun({ durationS: BASE_S * times, stepS: 10, series: SERIES });
      const c = await firstChart(run);
      expect(c.buckets, `${times}×: buckets loaded`).toBeLessThanOrEqual(SERIES * LEVEL_MAX_BUCKETS);
      loads.push(c.buckets);
    }
    const [, twice = 0, four = 0] = loads;
    expect(four, `buckets loaded at 1×, 2×, 4×: ${loads.join(', ')}`).toBeLessThan(1.5 * twice);
  });

  test('exemplars: bounded per bucket of the charted level, and not in step with the run from 2× to 4×', async () => {
    // A point (and an exemplar) a minute: at 2× level 2 (the exemplar width) has ~1,500 buckets, at 4× l3 appears.
    const BASE_S = 49_152;
    const loads: number[] = [];
    for (const times of [1, 2, 4]) {
      const run = await buildCounterRun({
        durationS: BASE_S * times,
        stepS: 60,
        series: SERIES,
        exemplars: true,
      });
      const c = await firstChart(run);
      expect(c.buckets, `${times}×: buckets loaded`).toBeLessThanOrEqual(SERIES * LEVEL_MAX_BUCKETS);
      expect(c.exemplars, `${times}×: exemplars loaded`).toBeLessThanOrEqual(
        SERIES * LEVEL_MAX_BUCKETS * EXEMPLARS_PER_BUCKET,
      );
      loads.push(c.exemplars);
    }
    const [, twice = 0, four = 0] = loads;
    expect(four, `exemplars loaded at 1×, 2×, 4×: ${loads.join(', ')}`).toBeLessThan(1.5 * twice);
  });

  test('zooming in loads the finer level and draws at its resolution', async () => {
    const run = await buildCounterRun({ durationS: 6144 * 4, stepS: 10, series: SERIES });
    const range = run.manifest.range;
    if (range === null) throw new Error('the run has no range');
    const c = counting(run);
    const m = await loadMetric(c.loader, run.manifest, 0);
    const full = await runMetricQuery(m, RATE, range, MAX_POINTS);
    // The whole run: level 2 (65.536 s), the first with at most MAX_POINTS buckets.
    expect(full.widthNs).toBe(LEVEL0_WIDTH_NS * 64);
    const loadedFirst = [...c.levels];
    // Half an hour: level 1 (8.192 s) has 220 buckets; a point every 10 s widens them to 16 × level 0 (R12′).
    const window = { start: range.start + 3600e9, end: range.start + 5400e9 };
    const zoomed = await runMetricQuery(m, RATE, window, MAX_POINTS);
    expect(zoomed.widthNs).toBe(LEVEL0_WIDTH_NS * 16);
    // The zoom read exactly the finer level's page under the window (level 1 spans 3,000 buckets, two pages):
    // not level 0, not the other page, and level 2 was already loaded.
    expect(c.levels.slice(loadedFirst.length)).toEqual(['data/metrics/000000/l1-000000.js']);
    const points = zoomed.series[0]?.points ?? [];
    expect(points.length).toBeGreaterThanOrEqual(Math.floor(1800e9 / zoomed.widthNs));
    // Every bucket holds a point, so the line has no gaps; 3 series × 1 or 2 points per bucket, per second.
    for (const [, v] of points) {
      expect(v).not.toBeNull();
      expect([3, 6].map((n) => n / (zoomed.widthNs / 1e9))).toContainEqual(v);
    }
    // A second zoom on the same level reads no file again.
    const before = c.levels.length;
    await runMetricQuery(m, RATE, { start: window.start + 60e9, end: window.end - 60e9 }, MAX_POINTS);
    expect(c.levels.length).toBe(before);
  });

  test('a formula operand re-run at the shared width loads only the level at that width', async () => {
    const run = await buildCounterRun({ durationS: 6144 * 4, stepS: 10, series: SERIES });
    const range = run.manifest.range;
    if (range === null) throw new Error('the run has no range');
    const c = counting(run);
    const m = await loadMetric(c.loader, run.manifest, 0);
    // 16 × level 0 is off the ladder: level 1 (8.192 s) is the coarsest no wider, merged up to it. Over the whole
    // run that is both of its pages.
    const result = await runMetricQueryAtWidth(m, RATE, range, LEVEL0_WIDTH_NS * 16);
    expect(result.widthNs).toBe(LEVEL0_WIDTH_NS * 16);
    expect(c.levels).toEqual(['data/metrics/000000/l1-000000.js', 'data/metrics/000000/l1-000001.js']);
  });
});

/**
 * Issue #38: a zoomed chart's reads are bounded by the window it draws. The same window is charted on runs of 1×,
 * 2× and 4× a base duration; the pages under it are the same files, so the buckets and exemplars loaded are equal.
 */
describe('a zoomed chart loads the pages under its window whatever the run length', () => {
  /** The Explorer's bucket cap (`MAX_POINTS`): the zoom windows below then chart at the levels the comments name. */
  const ZOOM_POINTS = 2000;
  // Each paged test builds four runs of fixtures; the exemplar one took 5.4 s on windows-latest against the 5 s default.
  const PAGED_TIMEOUT_MS = 20_000;
  test(
    'buckets: the same page at 1×, 2× and 4×, at most a page per series',
    async () => {
      // 25 minutes from 600 s at a point every 10 s: the chart is at level 1 (16.384 s, R12′), over level-1 buckets
      // 73-256: page 0 of a level that spans 2, 3 and 6 pages (3,000, 6,000 and 12,000 buckets).
      const loads: number[] = [];
      for (const times of [1, 2, 4]) {
        const run = await buildCounterRun({ durationS: 24_576 * times, stepS: 10, series: SERIES });
        const range = run.manifest.range;
        if (range === null) throw new Error('the run has no range');
        const c = counting(run);
        const m = await loadMetric(c.loader, run.manifest, 0);
        const r = await runMetricQuery(
          m,
          RATE,
          { start: range.start + 600e9, end: range.start + 2100e9 },
          ZOOM_POINTS,
        );
        expect(r.widthNs).toBe(LEVEL0_WIDTH_NS * 16);
        expect(c.levels).toEqual(['data/metrics/000000/l1-000000.js']);
        expect(c.buckets).toBeLessThanOrEqual(SERIES * PAGE_BUCKETS);
        loads.push(c.buckets);
      }
      expect(new Set(loads).size, `buckets loaded at 1×, 2×, 4×: ${loads.join(', ')}`).toBe(1);
    },
    PAGED_TIMEOUT_MS,
  );

  test(
    'exemplars: the same pages at 1×, 2× and 4× from the exemplar file of the charted level',
    async () => {
      // Ten hours from 1 h at a point a minute: level 2 (65.536 s) has 549 buckets, so the chart is at level 2, and
      // `ex.js` pages on level 2's grid; at 1× and 2× (750 and 1,500 level-2 buckets) both are one file, at 4× and
      // 8× (3,000 and 6,000) pages, of which the window reads page 0.
      const loads: number[] = [];
      for (const times of [1, 2, 4, 8]) {
        const run = await buildCounterRun({
          durationS: 49_152 * times,
          stepS: 60,
          series: SERIES,
          exemplars: true,
        });
        const range = run.manifest.range;
        if (range === null) throw new Error('the run has no range');
        const c = counting(run);
        const m = await loadMetric(c.loader, run.manifest, 0);
        const r = await runMetricQuery(
          m,
          RATE,
          { start: range.start + 3600e9, end: range.start + 39_600e9 },
          ZOOM_POINTS,
        );
        expect(r.widthNs).toBe(LEVEL0_WIDTH_NS * 64);
        expect(c.buckets).toBeLessThanOrEqual(SERIES * PAGE_BUCKETS);
        expect(c.exemplars).toBeLessThanOrEqual(SERIES * PAGE_BUCKETS * EXEMPLARS_PER_BUCKET);
        loads.push(c.exemplars);
      }
      // The whole files grow with the run; from the first paged run on, the page under the window is the same file.
      const [one = 0, two = 0, four = 0, eight = 0] = loads;
      expect(one).toBeLessThan(two);
      expect(eight, `exemplars loaded at 1×, 2×, 4×, 8×: ${loads.join(', ')}`).toBe(four);
    },
    PAGED_TIMEOUT_MS,
  );

  test('a counter running total over a zoomed window counts the deltas before it from the coarsest level', async () => {
    // Every point adds 1 per series, every 10 s. The window sits in level 1's second page (level 1 has 6,000
    // buckets, level 2, the coarsest, 750); the total at a charted bucket is the number of points up to its end,
    // times the series, which the chart gets from level 2 (whole) and level 1's page 1, never page 0.
    const run = await buildCounterRun({ durationS: 49_152, stepS: 10, series: SERIES });
    const range = run.manifest.range;
    if (range === null) throw new Error('the run has no range');
    const c = counting(run);
    const m = await loadMetric(c.loader, run.manifest, 0);
    const start = range.start + 20_000e9;
    const window = { start, end: start + 1300e9 };
    const r = await runMetricQuery(m, { ...RATE, show: 'sum' }, window, ZOOM_POINTS);
    expect(r.widthNs).toBe(LEVEL0_WIDTH_NS * 16);
    expect(c.levels.sort()).toEqual(['data/metrics/000000/l1-000001.js', 'data/metrics/000000/l2.js']);
    const points = r.series[0]?.points ?? [];
    expect(points.length).toBeGreaterThan(50);
    for (const [t, v] of points) {
      const bucketEnd = t + r.widthNs;
      const pointsBefore = Math.floor((bucketEnd - 1 - range.start) / 10e9) + 1;
      expect(v, `running total at ${t}`).toBe(pointsBefore * SERIES);
    }
  });
});
