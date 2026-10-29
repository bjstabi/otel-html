import { describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile, wrapDataFile } from '../../src/format/data-file.js';
import {
  deriveLevels,
  EXEMPLAR_WIDTH_NS,
  encodeExemplarFile,
  encodeSegmentFile,
  encodeSeriesFile,
  LEVEL_MAX_BUCKETS,
  LEVEL0_WIDTH_NS,
  levelCount,
  MAX_LEVEL,
  METRIC_FILE_PATH,
  mergeBucketSeries,
  metricDir,
  metricExemplarKey,
  metricExemplarPath,
  metricLevelKey,
  metricLevelPath,
  metricSegmentKey,
  metricSegmentPath,
  metricSeriesKey,
  metricSeriesPath,
  parseExemplarFile,
  parseLevelFile,
  parseSegmentFile,
  parseSeriesFile,
  type StoredExemplar,
  selectExemplars,
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
    ]) {
      expect(METRIC_FILE_PATH.test(p), p).toBe(true);
    }
    expect(METRIC_FILE_PATH.test('data/metrics/000001/l7.js')).toBe(false);
    expect(METRIC_FILE_PATH.test('data/metrics/x/series.js')).toBe(false);
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
  });
});
