import { describe, expect, test } from 'vitest';
import type { MetricQueryResult, SeriesPoints } from '../../src/viewer/data/metric-query.js';
import { exportMetricCsv, exportMetricJson } from '../../src/viewer/metrics/export.js';

const S = 1_000_000_000;

function series(key: string, label: string, values: readonly (number | null)[]): SeriesPoints {
  return {
    key,
    label,
    group: {},
    unit: 's',
    points: values.map((v, i): [number, number | null] => [i * 10 * S, v]),
    resourceService: null,
  };
}

function result(queryId: string, s: SeriesPoints[]): MetricQueryResult {
  return {
    queryId,
    widthNs: 10 * S,
    series: s,
    exemplars: [],
    heat: null,
    distribution: null,
    notes: [],
  };
}

const RESULTS = [
  result('a', [series('a', 'a · p99', [1, 2, 3])]),
  result('f1', [series('f', 'f1 · "a, b"', [4, null, 6])]),
];

describe('exportMetricCsv', () => {
  test('2 series × 3 points is a header and 6 CRLF rows of time,query,series,value', () => {
    const lines = exportMetricCsv(RESULTS).split('\r\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('time,query,series,value');
    expect(lines[1]).toBe('0,a,a · p99,1');
    expect(lines[3]).toBe(`${20 * S},a,a · p99,3`);
    // A gap has an empty value; a label with a comma or quote is quoted.
    expect(lines[5]).toBe(`${10 * S},f1,"f1 · ""a, b""",`);
  });

  test('no results is just the header', () => {
    expect(exportMetricCsv([])).toBe('time,query,series,value');
  });

  test('a histogram result adds its heatmap cells and its distribution, labelled by bucket', () => {
    const h: MetricQueryResult = {
      ...result('h', []),
      heat: {
        bounds: [1, 5],
        cells: [
          [0, 0, 3],
          [10 * S, 2, 4],
        ],
      },
      distribution: { bounds: [1, 5], counts: [3, 0, 4] },
    };
    const lines = exportMetricCsv([h]).split('\r\n');
    expect(lines.slice(1)).toEqual([
      '0,h,heat ≤1,3',
      `${10 * S},h,heat >5,4`,
      ',h,distribution ≤1,3',
      ',h,distribution ≤5,0',
      ',h,distribution >5,4',
    ]);
    const [json] = JSON.parse(exportMetricJson([h])) as { heat: unknown; distribution: unknown }[];
    expect(json?.heat).toEqual(h.heat);
    expect(json?.distribution).toEqual(h.distribution);
    // A line result carries neither key.
    expect(JSON.parse(exportMetricJson(RESULTS))[0]).not.toHaveProperty('heat');
  });
});

describe('exportMetricJson', () => {
  test('lists each query with its width, notes and series points', () => {
    const parsed: unknown = JSON.parse(exportMetricJson(RESULTS));
    expect(parsed).toEqual([
      {
        query: 'a',
        widthNs: 10 * S,
        notes: [],
        series: [
          {
            key: 'a',
            label: 'a · p99',
            group: {},
            unit: 's',
            points: [
              [0, 1],
              [10 * S, 2],
              [20 * S, 3],
            ],
          },
        ],
      },
      {
        query: 'f1',
        widthNs: 10 * S,
        notes: [],
        series: [
          {
            key: 'f',
            label: 'f1 · "a, b"',
            group: {},
            unit: 's',
            points: [
              [0, 4],
              [10 * S, null],
              [20 * S, 6],
            ],
          },
        ],
      },
    ]);
  });
});
