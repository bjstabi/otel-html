import { describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile, wrapDataFile } from '../../src/format/data-file.js';
import {
  deriveLevels,
  EXEMPLAR_BASE_LEVEL,
  EXEMPLAR_WIDTH_NS,
  encodeExemplarFile,
  encodeSegmentFile,
  encodeSeriesFile,
  exemplarPages,
  GAP_SAMPLE,
  groupMetricFiles,
  LEVEL_MAX_BUCKETS,
  LEVEL0_WIDTH_NS,
  levelCount,
  levelPages,
  levelWidthNs,
  MAX_LEVEL,
  METRIC_FILE_PATH,
  mergeBucketSeries,
  metricDir,
  metricExemplarKey,
  metricExemplarPagePath,
  metricExemplarPath,
  metricLevelExemplarKey,
  metricLevelExemplarPagePath,
  metricLevelExemplarPath,
  metricLevelKey,
  metricLevelPagePath,
  metricLevelPath,
  metricSegmentKey,
  metricSegmentPath,
  metricSeriesKey,
  metricSeriesPath,
  PAGE_BUCKETS,
  pageOf,
  pagesIn,
  parseExemplarFile,
  parseLevelFile,
  parseMetricFilePath,
  parseSegmentFile,
  parseSeriesFile,
  type StoredExemplar,
  selectExemplars,
  seriesGaps,
  summaryQuantilesOf,
} from '../../src/format/metric-files.js';
import type { AnyValue } from '../../src/model/anyvalue.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { BucketAgg } from '../../src/rollups/metric-agg.js';
import type { SeriesDef } from '../../src/rollups/metric-catalog.js';

const counter = (delta: number): BucketAgg => ({ k: 'counter', delta, resets: 0 });
const str = (value: string): AnyValue => ({ kind: 'string', value });

function roundTrip(key: string, payload: unknown): unknown {
  return reviveDataJson(unwrapDataFile(wrapDataFile(key, payload), key));
}

function failure(fn: () => unknown): OtelHtmlError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('metric file paths', () => {
  test('use zero-padded numeric ids and match the manifest pattern', () => {
    expect(metricDir(7)).toBe('data/metrics/000007');
    expect(metricSeriesPath(7)).toBe('data/metrics/000007/series.js');
    expect(metricSegmentPath(7, 12)).toBe('data/metrics/000007/seg-000012.js');
    expect(metricLevelPath(7, 3)).toBe('data/metrics/000007/l3.js');
    expect(metricExemplarPath(7)).toBe('data/metrics/000007/ex.js');
    expect(metricSeriesKey(7)).toBe('metrics/000007/series');
    expect(metricSegmentKey(7, 12)).toBe('metrics/000007/seg-000012');
    expect(metricLevelKey(7, 3)).toBe('metrics/000007/l3');
    expect(metricExemplarKey(7)).toBe('metrics/000007/ex');
    for (const p of [
      metricSeriesPath(0),
      metricSegmentPath(999_999, 999_999),
      metricLevelPath(1, 0),
      metricLevelPath(1, MAX_LEVEL),
      metricExemplarPath(2),
      metricLevelExemplarPath(2, EXEMPLAR_BASE_LEVEL + 1),
      metricLevelExemplarPath(2, MAX_LEVEL),
    ]) {
      expect(METRIC_FILE_PATH.test(p), p).toBe(true);
    }
    expect(metricLevelExemplarKey(7, 4)).toBe('metrics/000007/ex4');
    expect(METRIC_FILE_PATH.test('data/metrics/000001/l7.js')).toBe(false);
    // ex.js serves levels 0…EXEMPLAR_BASE_LEVEL: there is no ex0.js-ex2.js.
    expect(METRIC_FILE_PATH.test('data/metrics/000001/ex2.js')).toBe(false);
    expect(failure(() => metricLevelExemplarPath(0, EXEMPLAR_BASE_LEVEL)).code).toBe('invalid-report');
    expect(METRIC_FILE_PATH.test('data/metrics/x/series.js')).toBe(false);
  });

  test('paged levels and exemplar files (format 3) have their own names and parse back', () => {
    expect(metricLevelPagePath(7, 0, 12)).toBe('data/metrics/000007/l0-000012.js');
    expect(metricExemplarPagePath(7, 3)).toBe('data/metrics/000007/ex-000003.js');
    expect(metricLevelExemplarPagePath(7, 4, 1)).toBe('data/metrics/000007/ex4-000001.js');
    for (const p of [
      metricLevelPagePath(0, MAX_LEVEL, 999_999),
      metricExemplarPagePath(1, 0),
      metricLevelExemplarPagePath(1, 3, 5),
    ]) {
      expect(METRIC_FILE_PATH.test(p), p).toBe(true);
    }
    expect(METRIC_FILE_PATH.test('data/metrics/000001/ex2-000000.js')).toBe(false);
    expect(METRIC_FILE_PATH.test('data/metrics/000001/l0-1.js')).toBe(false);
    expect(parseMetricFilePath(metricSeriesPath(7))).toEqual({ id: 7, kind: 'series' });
    expect(parseMetricFilePath(metricSegmentPath(7, 3))).toEqual({ id: 7, kind: 'segment', n: 3 });
    expect(parseMetricFilePath(metricLevelPath(7, 2))).toEqual({
      id: 7,
      kind: 'level',
      level: 2,
      page: null,
    });
    expect(parseMetricFilePath(metricLevelPagePath(7, 2, 9))).toEqual({
      id: 7,
      kind: 'level',
      level: 2,
      page: 9,
    });
    expect(parseMetricFilePath(metricExemplarPath(7))).toEqual({
      id: 7,
      kind: 'exemplars',
      level: EXEMPLAR_BASE_LEVEL,
      page: null,
    });
    expect(parseMetricFilePath(metricExemplarPagePath(7, 1))).toEqual({
      id: 7,
      kind: 'exemplars',
      level: EXEMPLAR_BASE_LEVEL,
      page: 1,
    });
    expect(parseMetricFilePath(metricLevelExemplarPath(7, 5))).toEqual({
      id: 7,
      kind: 'exemplars',
      level: 5,
      page: null,
    });
    expect(parseMetricFilePath(metricLevelExemplarPagePath(7, 5, 2))).toEqual({
      id: 7,
      kind: 'exemplars',
      level: 5,
      page: 2,
    });
    expect(parseMetricFilePath('data/rollups/metrics.js')).toBeNull();
  });

  test('groupMetricFiles sorts a listing by metric, level and page', () => {
    const grouped = groupMetricFiles([
      metricLevelPagePath(1, 0, 3),
      metricSeriesPath(1),
      metricLevelPagePath(1, 0, 1),
      metricLevelPath(1, 1),
      metricExemplarPagePath(1, 2),
      metricExemplarPagePath(1, 0),
      metricLevelExemplarPath(1, 3),
      metricSegmentPath(0, 2),
      metricSegmentPath(0, 0),
      'data/rollups/metrics.js',
    ]);
    expect([...grouped.keys()]).toEqual([1, 0]);
    expect(grouped.get(1)).toEqual({
      series: true,
      segments: [],
      levels: new Map([
        [0, [1, 3]],
        [1, null],
      ]),
      exemplars: new Map([
        [EXEMPLAR_BASE_LEVEL, [0, 2]],
        [3, null],
      ]),
    });
    expect(grouped.get(0)).toEqual({
      series: false,
      segments: [0, 2],
      levels: new Map(),
      exemplars: new Map(),
    });
  });

  test('reject ids, segment numbers and levels outside the layout', () => {
    expect(failure(() => metricDir(-1)).code).toBe('invalid-report');
    expect(failure(() => metricDir(1_000_000)).code).toBe('invalid-report');
    expect(failure(() => metricSegmentPath(0, 1.5)).code).toBe('invalid-report');
    expect(failure(() => metricLevelPath(0, MAX_LEVEL + 1)).code).toBe('invalid-report');
  });
});

describe('resolution ladder', () => {
  test('constants', () => {
    expect(LEVEL0_WIDTH_NS).toBe(1_024_000_000);
    expect(EXEMPLAR_WIDTH_NS).toBe(65_536_000_000);
    expect(levelWidthNs(EXEMPLAR_BASE_LEVEL)).toBe(EXEMPLAR_WIDTH_NS);
    expect(LEVEL_MAX_BUCKETS).toBe(2000);
    expect(MAX_LEVEL).toBe(6);
  });

  test('levelCount stops at the first level with at most LEVEL_MAX_BUCKETS buckets', () => {
    expect(levelCount(0, 0)).toBe(1);
    expect(levelCount(0, 1999 * LEVEL0_WIDTH_NS)).toBe(1); // 2000 buckets at level 0
    expect(levelCount(0, 2000 * LEVEL0_WIDTH_NS)).toBe(2); // 2001 at level 0, 251 at level 1
    // 1 h of data: 3516 level-0 buckets, 440 at level 1
    expect(levelCount(0, 3_600_000_000_000)).toBe(2);
    // 100 days: level 5 (≈ 9.3 h buckets) has 258
    expect(levelCount(0, 100 * 86_400_000_000_000)).toBe(6);
    // a range no level fits is capped at MAX_LEVEL
    expect(levelCount(0, 1e18)).toBe(MAX_LEVEL + 1);
    // negative times bucket by floor
    expect(levelCount(-1, 0)).toBe(1);
  });

  test('deriveLevels coarsens by 8 per level, merging buckets in time order', () => {
    const l0 = [{ id: 0, t: [-1, 0, 7, 8, 64], a: [1, 2, 3, 4, 5].map(counter) }];
    const levels = deriveLevels(l0, 3);
    expect(levels).toHaveLength(3);
    expect(levels[0]).toEqual(l0);
    expect(levels[1]).toEqual([{ id: 0, t: [-1, 0, 1, 8], a: [1, 5, 4, 5].map(counter) }]);
    expect(levels[2]).toEqual([{ id: 0, t: [-1, 0, 1], a: [1, 9, 5].map(counter) }]);
  });

  test('mergeBucketSeries unions parts by series and bucket', () => {
    const merged = mergeBucketSeries(
      [
        [
          { id: 1, t: [5], a: [counter(1)] },
          { id: 0, t: [1, 3], a: [counter(1), counter(2)] },
        ],
        [{ id: 0, t: [2, 3], a: [counter(10), counter(20)] }],
      ],
      'test',
    );
    expect(merged).toEqual([
      { id: 0, t: [1, 2, 3], a: [counter(1), counter(10), counter(22)] },
      { id: 1, t: [5], a: [counter(1)] },
    ]);
  });
});

describe('selectExemplars', () => {
  const ex = (time: number, value: number, traced = false): StoredExemplar => ({
    series: 0,
    time,
    value,
    traceId: traced ? '5b8efff798038103d269b633813fc60c' : null,
    spanId: null,
    attributes: new Map(),
  });

  test('keeps up to n, preferring a trace id, then the two largest and two smallest values', () => {
    const all = [ex(1, 5), ex(2, 1), ex(3, 9), ex(4, 3), ex(5, 7), ex(6, 2)];
    expect(selectExemplars(all, 4).map((e) => e.value)).toEqual([1, 9, 7, 2]); // time order
    const traced = [ex(1, 5), ex(2, 1, true), ex(3, 9), ex(4, 3, true)];
    expect(selectExemplars(traced, 3).map((e) => e.value)).toEqual([1, 9, 3]);
    expect(selectExemplars(traced, 2).map((e) => e.value)).toEqual([1, 3]);
    expect(selectExemplars(all.slice(0, 2), 4)).toHaveLength(2);
  });
});

describe('payloads', () => {
  const series: SeriesDef[] = [
    {
      id: 0,
      resource: 0,
      scope: 0,
      attributes: new Map([['k', str('</script><img src=x>')]]),
      bounds: null,
      other: false,
    },
    { id: 1, resource: -1, scope: -1, attributes: new Map(), bounds: [1, 2], other: true },
  ];
  const exemplar: StoredExemplar = {
    series: 0,
    time: 1_500_000_000,
    value: 2.5,
    traceId: '5b8efff798038103d269b633813fc60c',
    spanId: 'eee19b7ec3c1b174',
    attributes: new Map([['user', str('u1')]]),
  };

  test('round-trip through data files', () => {
    const s = roundTrip('k', encodeSeriesFile({ metric: 3, series }));
    expect(parseSeriesFile(s, 'series.js')).toEqual({ metric: 3, series });
    const gaps = series.map((_, i) => ({ n: i, median: 10 }));
    const withGaps = roundTrip('k', encodeSeriesFile({ metric: 3, series, gaps }));
    expect(parseSeriesFile(withGaps, 'series.js')).toEqual({ metric: 3, series, gaps });
    const quantiles = [0, 0.5, 0.99, 1];
    const withQuantiles = roundTrip('k', encodeSeriesFile({ metric: 3, series, gaps, quantiles }));
    expect(parseSeriesFile(withQuantiles, 'series.js')).toEqual({ metric: 3, series, gaps, quantiles });
    const seg = {
      metric: 3,
      widthNs: LEVEL0_WIDTH_NS,
      series: [{ id: 0, t: [1, 2], a: [counter(1), counter(2)] }],
      exemplars: [exemplar],
    };
    expect(parseSegmentFile(roundTrip('k', encodeSegmentFile(seg)), 'seg')).toEqual(seg);
    const level = { metric: 3, level: 2, widthNs: LEVEL0_WIDTH_NS * 64, series: seg.series };
    expect(parseLevelFile(roundTrip('k', level), 'l2')).toEqual(level);
    const exf = { metric: 3, exemplars: [exemplar] };
    expect(parseExemplarFile(roundTrip('k', encodeExemplarFile(exf)), 'ex')).toEqual(exf);
  });

  test('malformed payloads are invalid-report errors naming the file and field', () => {
    const bad = { metric: 0, level: 1, widthNs: LEVEL0_WIDTH_NS, series: [] };
    const e = failure(() => parseLevelFile(bad, 'data/metrics/000000/l1.js'));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain('data/metrics/000000/l1.js');
    const unsorted = {
      metric: 0,
      widthNs: LEVEL0_WIDTH_NS,
      series: [{ id: 0, t: [2, 1], a: [counter(1), counter(2)] }],
      exemplars: [],
    };
    expect(failure(() => parseSegmentFile(unsorted, 'seg')).message).toContain('seg.series[0]');
    const badAgg = {
      metric: 0,
      widthNs: LEVEL0_WIDTH_NS,
      series: [{ id: 0, t: [1], a: [{ k: 'counter', delta: 'x', resets: 0 }] }],
      exemplars: [],
    };
    expect(failure(() => parseSegmentFile(badAgg, 'seg')).message).toContain('seg.series[0].a[0]');
    const badId = {
      metric: 0,
      exemplars: [
        { ...encodeExemplarFile({ metric: 0, exemplars: [exemplar] }).exemplars[0], traceId: 'zz' },
      ],
    };
    expect(failure(() => parseExemplarFile(badId, 'ex')).message).toContain('ex.exemplars[0].traceId');
    const short = { ...encodeSeriesFile({ metric: 0, series }), gaps: [] };
    expect(failure(() => parseSeriesFile(short, 'series.js')).message).toContain('series.js.gaps');
    for (const quantiles of [[0.99, 0.5], [0.5, 0.5], [1.5]]) {
      const bad = { ...encodeSeriesFile({ metric: 0, series }), quantiles };
      expect(failure(() => parseSeriesFile(bad, 'series.js')).message).toContain('series.js.quantiles');
    }
  });
});

describe('pages', () => {
  const exemplar: StoredExemplar = {
    series: 0,
    time: 1,
    value: 2.5,
    traceId: null,
    spanId: null,
    attributes: new Map(),
  };
  test('a level in one page is one file; more pages split each series by bucket index, leaving empty pages out', () => {
    expect(PAGE_BUCKETS).toBe(2048);
    expect(pageOf(0)).toBe(0);
    expect(pageOf(2047)).toBe(0);
    expect(pageOf(2048)).toBe(1);
    // Buckets before the epoch (negative indexes) belong to page 0.
    expect(pageOf(-1)).toBe(0);
    expect(pageOf(-5000)).toBe(0);
    expect(
      levelPages([{ id: 0, t: [-3000, -1, 0, 2048], a: [counter(1), counter(2), counter(3), counter(4)] }]),
    ).toEqual(
      new Map([
        [0, [{ id: 0, t: [-3000, -1, 0], a: [counter(1), counter(2), counter(3)] }]],
        [1, [{ id: 0, t: [2048], a: [counter(4)] }]],
      ]),
    );
    const one = [{ id: 0, t: [5, 2047], a: [counter(1), counter(2)] }];
    expect(levelPages(one)).toEqual(new Map([[0, one]]));
    const many = [
      { id: 0, t: [5, 2048, 6144], a: [counter(1), counter(2), counter(3)] },
      { id: 1, t: [2049], a: [counter(4)] },
      { id: 2, t: [], a: [] },
    ];
    expect(levelPages(many)).toEqual(
      new Map([
        [0, [{ id: 0, t: [5], a: [counter(1)] }]],
        [
          1,
          [
            { id: 0, t: [2048], a: [counter(2)] },
            { id: 1, t: [2049], a: [counter(4)] },
          ],
        ],
        [3, [{ id: 0, t: [6144], a: [counter(3)] }]],
      ]),
    );
    expect(levelPages([])).toEqual(new Map());
  });

  test('exemplars page on the grid of the level they serve', () => {
    const w = levelWidthNs(2);
    const at = (bucket: number): StoredExemplar => ({ ...exemplar, time: bucket * w + 1 });
    const list = [at(0), at(2048 * 3), at(2047), at(2048)];
    expect(exemplarPages(list, w)).toEqual(
      new Map([
        [0, [at(0), at(2047)]],
        [1, [at(2048)]],
        [3, [at(2048 * 3)]],
      ]),
    );
    expect(exemplarPages([at(1)], w)).toEqual(new Map([[0, [at(1)]]]));
  });

  test('pagesIn picks the listed pages a window touches, all of them without a window', () => {
    const w = LEVEL0_WIDTH_NS;
    const listed = [0, 1, 3, 7];
    expect(pagesIn(listed, undefined, w)).toEqual(listed);
    expect(pagesIn(listed, { start: 0, end: w }, w)).toEqual([0]);
    expect(pagesIn(listed, { start: 2047 * w, end: 2048 * w }, w)).toEqual([0, 1]);
    expect(pagesIn(listed, { start: 2048 * 2 * w, end: 2048 * 8 * w }, w)).toEqual([3, 7]);
    expect(pagesIn(listed, { start: 2048 * 9 * w, end: 2048 * 10 * w }, w)).toEqual([]);
    expect(pagesIn(listed, { start: -5 * w, end: 0 }, w)).toEqual([0]);
    expect(pagesIn(null, { start: 0, end: w }, w)).toBeNull();
  });

  test('a page file keeps its page and rejects buckets outside it', () => {
    const page = {
      metric: 3,
      level: 1,
      widthNs: levelWidthNs(1),
      page: 2,
      series: [{ id: 0, t: [4096, 6143], a: [counter(1), counter(2)] }],
    };
    expect(parseLevelFile(roundTrip('k', page), 'l1-000002')).toEqual(page);
    const outside = { ...page, series: [{ id: 0, t: [4095], a: [counter(1)] }] };
    expect(failure(() => parseLevelFile(outside, 'l1-000002')).message).toContain('l1-000002.series[0].t[0]');
    const exPage = { metric: 3, page: 1, exemplars: [exemplar] };
    expect(parseExemplarFile(roundTrip('k', encodeExemplarFile(exPage)), 'ex-000001')).toEqual(exPage);
  });
});

describe('summaryQuantilesOf', () => {
  test('every quantile of every summary bucket, ascending, other kinds ignored', () => {
    const summary = (qs: number[]): BucketAgg => ({
      k: 'summary',
      count: 1,
      sum: 1,
      quantiles: qs.map((q) => ({ q, v: q })),
      lastTime: 0,
    });
    expect(
      summaryQuantilesOf([
        { id: 0, t: [0, 1], a: [summary([0.99, 0.5]), summary([0.5])] },
        { id: 1, t: [0], a: [counter(1)] },
        { id: 2, t: [5], a: [summary([0, 1])] },
      ]),
    ).toEqual([0, 0.5, 0.99, 1]);
    expect(summaryQuantilesOf([])).toEqual([]);
  });
});

describe('seriesGaps', () => {
  test('the upper median of the first GAP_SAMPLE gaps, in level-0 buckets', () => {
    expect(seriesGaps([])).toEqual({ n: 0, median: 0 });
    expect(seriesGaps([5])).toEqual({ n: 0, median: 0 });
    expect(seriesGaps([0, 2, 5])).toEqual({ n: 2, median: 3 });
    const t = Array.from({ length: GAP_SAMPLE + 10 }, (_, i) => i * 10);
    t.push(1e6);
    expect(seriesGaps(t)).toEqual({ n: GAP_SAMPLE, median: 10 });
  });
});
