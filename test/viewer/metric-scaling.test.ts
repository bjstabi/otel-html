import { describe, expect, test } from 'vitest';
import { reviveDataJson } from '../../src/format/data-file.js';
import {
  LEVEL_MAX_BUCKETS,
  LEVEL0_WIDTH_NS,
  parseExemplarFile,
  parseLevelFile,
} from '../../src/format/metric-files.js';
import { loadMetric } from '../../src/viewer/data/metric-load.js';
import { type MetricQuery, runMetricQuery } from '../../src/viewer/data/metric-query.js';
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

const LEVEL_FILE = /\/l[0-6]\.js$/;
const EXEMPLAR_FILE = /\/ex[0-6]?\.js$/;

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
    expect(c.levels.slice(loadedFirst.length).concat(loadedFirst)).toContain('data/metrics/000000/l1.js');
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
});
