import { literal, Query, sql } from '@uwdata/mosaic-sql';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  byExpr,
  identityTerms,
  type MetricIdentity,
  metricDefsQuery,
  metricIdentitiesQuery,
  metricSparkQuery,
  pointIntervalQuery,
  SPARK_BUCKETS,
  seriesQuery,
  summaryQuantilesQuery,
} from '../../../src/query/sql/points.js';
import { bucketSpec } from '../../../src/query/sql/time.js';
import type { TestDb } from '../../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../../test-support/format4-fixture.js';
import {
  attr,
  gauge,
  histogram,
  metricsRequest,
  pointsAt,
  sum,
  summary,
} from '../../../test-support/otlp-builders.js';
import { otlp } from '../../../test-support/writer-deps.js';

type Key =
  | 'metric_name'
  | 'point_type'
  | 'points'
  | 'series'
  | 'resets'
  | 'out_of_order'
  | 'no_value'
  | 'scopes'
  | 'is_monotonic'
  | 'aggregation_temporality'
  | 'sum'
  | 'n'
  | 'bucket'
  | 'q'
  | 'g0'
  | 'g1'
  | 'gap'
  | 'filename'
  | 'resource_attributes';
type Row = Partial<Record<Key, unknown>> & Record<string, unknown>;
const str = (v: string) => ({ stringValue: v });
const resA = [attr('service.name', str('svc-a'))];
const resB = [attr('service.name', str('svc-b'))];
const q = (quantile: number, value: number) => ({ quantile, value });

// Partition 0: gauge `g` by two series (host=h1 on svc-a, host=h2 on svc-b), a counter with a reset, a summary (0.5).
const P0 = otlp(
  metricsRequest(
    [
      gauge(
        'g',
        pointsAt([0, 10], (i) => ({ asDouble: 1 + i }), [attr('host', str('h1'))]),
      ),
      sum(
        'c',
        pointsAt([0, 10, 20], (i) => ({ asDouble: [5, 8, 2][i] ?? 0 })),
        {
          monotonic: true,
          temporality: 'cumulative',
        },
      ),
      summary(
        's',
        pointsAt([0], () => ({ count: '2', sum: 3, quantileValues: [q(0.5, 1)] })),
      ),
    ],
    resA,
  ) as never,
);
// Partition 1: the gauge again (series host=h1 again, and a second series on a second resource), the summary (0.99).
const P1 = otlp(
  metricsRequest(
    [
      gauge(
        'g',
        pointsAt([30], () => ({ asDouble: 4 }), [attr('host', str('h1'))]),
      ),
      summary(
        's',
        pointsAt([30], () => ({ count: '2', sum: 3, quantileValues: [q(0.99, 9), q(1, 10)] })),
      ),
    ],
    resA,
  ) as never,
);
const P2 = otlp(
  metricsRequest(
    [
      gauge(
        'g',
        pointsAt([40], () => ({ asDouble: 7 }), [attr('host', str('h2'))]),
      ),
    ],
    resB,
  ) as never,
);

let f: Format4Fixture;
let db: TestDb;
beforeAll(async () => {
  f = await buildFormat4Report([P0, P1, P2], { close: false });
  db = await openFixtureDb(f);
});
const run = (query: { toString(): string }): Row[] => db.rows(query.toString());
const num = (v: unknown): number => Number(v);
const def = (rows: Row[], name: string): Row => {
  const r = rows.find((x) => x.metric_name === name);
  if (r === undefined) throw new Error(`no def ${name}`);
  return r;
};

describe('metric catalog queries', () => {
  test('definitions count series across partitions once', () => {
    const rows = run(metricDefsQuery());
    expect(rows.map((r) => r.metric_name)).toEqual(['c', 'g', 's']);
    const g = def(rows, 'g');
    expect(num(g.points)).toBe(4);
    expect(num(g.series)).toBe(2);
    expect(g.point_type).toBe('gauge');
    expect([...(g.scopes as string[])]).toEqual(['test-scope']);
    expect(num(g.no_value)).toBe(0);
    const c = def(rows, 'c');
    expect(c.point_type).toBe('sum');
    expect(c.is_monotonic).toBe(true);
    expect(num(c.aggregation_temporality)).toBe(2);
    expect(num(c.resets)).toBe(1);
    expect(num(c.out_of_order)).toBe(0);
    expect(num(def(rows, 's').series)).toBe(1);
  });

  test('identities are distinct rows with their resource and scope columns', () => {
    const rows = run(metricIdentitiesQuery());
    expect(rows.filter((r) => r.metric_name === 'g')).toHaveLength(2);
    expect(rows).toHaveLength(4);
    for (const k of ['attributes', 'resource_attributes', 'scope_name', 'explicit_bounds']) {
      expect(Object.keys(rows[0] ?? {})).toContain(k);
    }
  });

  test('sparkline sums the natural value per bucket', () => {
    const spec = bucketSpec({ start: 0, end: 40e6 }, null, SPARK_BUCKETS);
    const rows = run(metricSparkQuery(spec, f.epoch));
    const of = (name: string) => rows.filter((r) => r.metric_name === name);
    // Gauge: 1 and 2 (ms 0, 10), 4 (ms 30), 7 (ms 40); the bucket is 1 ms wide here.
    expect(of('g').reduce((a, r) => a + num(r.sum), 0)).toBe(14);
    expect(of('g').reduce((a, r) => a + num(r.n), 0)).toBe(4);
    // Counter: no delta for the first point, then 3, then a reset: 2.
    expect(of('c').reduce((a, r) => a + num(r.sum), 0)).toBe(5);
    // Summary: count.
    expect(of('s').reduce((a, r) => a + num(r.sum), 0)).toBe(4);
  });

  test('summary quantiles are the distinct values across partitions, ascending', () => {
    const id: MetricIdentity = { name: 's', type: 'summary', unit: '1', temporality: 0, monotonic: false };
    expect(run(summaryQuantilesQuery(id)).map((r) => num(r.q))).toEqual([0.5, 0.99, 1]);
  });

  test('identityTerms match nullable columns with IS NOT DISTINCT FROM', () => {
    const id: MetricIdentity = { name: 's', type: 'summary', unit: '1', temporality: 0, monotonic: false };
    expect(identityTerms(id)).toHaveLength(5);
    const bad: MetricIdentity = { ...id, name: 'g', type: 'gauge' };
    expect(
      run(
        Query.from('points')
          .select({ n: sql`count(*)` })
          .where(...identityTerms(bad)),
      )[0]?.n,
    ).toBe(4n);
  });
});

describe('metric sparkline buckets', () => {
  test('points land in the bucket of their time, for every natural-value branch', async () => {
    const ms = [0, 10, 20, 30];
    const request = otlp(
      metricsRequest(
        [
          gauge(
            'g',
            pointsAt(ms, (i) => ({ asDouble: [1, 2, 4, 8][i] ?? 0 })),
          ),
          sum(
            'u',
            pointsAt(ms, (i) => ({ asDouble: [10, 20, 30, 40][i] ?? 0 })),
            { monotonic: false, temporality: 'cumulative' },
          ),
          sum(
            'm',
            pointsAt(ms, (i) => ({ asDouble: [1, 3, 6, 10][i] ?? 0 })),
            { monotonic: true, temporality: 'cumulative' },
          ),
          histogram(
            'h',
            pointsAt(ms, (i) => ({
              count: String([2, 3, 4, 5][i] ?? 0),
              sum: 1,
              explicitBounds: [1],
              bucketCounts: ['1', String((([2, 3, 4, 5][i] ?? 0) as number) - 1)],
            })),
            { temporality: 'delta' },
          ),
        ],
        resA,
      ) as never,
    );
    const fx = await buildFormat4Report([request], { close: false });
    const own = await openFixtureDb(fx);
    // 16 ms buckets: [0, 16) holds ms 0 and 10, [16, 32) holds ms 20 and 30.
    const spec = bucketSpec({ start: 0, end: 40e6 }, null, 4);
    expect(spec.widthNs).toBe(16e6);
    const rows: Row[] = own.rows(metricSparkQuery(spec, fx.epoch).toString());
    const byBucket = (name: string): [number, number, number][] =>
      rows
        .filter((r) => r.metric_name === name)
        .map((r): [number, number, number] => [num(r.bucket), num(r.sum), num(r.n)]);
    expect(byBucket('g')).toEqual([
      [0, 3, 2],
      [16e6, 12, 2],
    ]);
    // Non-monotonic sum: value_double.
    expect(byBucket('u')).toEqual([
      [0, 30, 2],
      [16e6, 70, 2],
    ]);
    // Monotonic sum: delta_value (a stream's first point has delta 0).
    expect(byBucket('m')).toEqual([
      [0, 2, 2],
      [16e6, 7, 2],
    ]);
    // Delta histogram: delta_count.
    expect(byBucket('h')).toEqual([
      [0, 5, 2],
      [16e6, 9, 2],
    ]);
  });
});

describe('metric series, by and the point interval', () => {
  const idG: MetricIdentity = { name: 'g', type: 'gauge', unit: '1', temporality: 0, monotonic: false };
  const all = { files: ['all-files'], all: true, total: 1 } as const;
  const base = { identity: idG, files: all, where: null, resourceTexts: null, seriesIds: null } as const;

  test('by groups int 1 and string "1" apart', async () => {
    const request = otlp(
      metricsRequest(
        [
          gauge(
            'g',
            pointsAt([0], () => ({ asDouble: 1 }), [attr('k', { intValue: '1' })]),
          ),
          gauge(
            'g',
            pointsAt([10], () => ({ asDouble: 2 }), [attr('k', str('1'))]),
          ),
        ],
        resA,
      ) as never,
    );
    const fx = await buildFormat4Report([request], { close: false });
    const own = await openFixtureDb(fx);
    const rows: Row[] = own.rows(
      seriesQuery({ ...base, by: [byExpr('attributes["k"]')] })
        .orderby(sql`g0`)
        .toString(),
    );
    expect(rows.map((r) => r.g0)).toEqual(['"1"', '1']);
    expect(byExpr('attributes["k"]').identity).toBe(true);
    for (const bad of ['time_unix_nano', 'name', 'metric.name["x"]'])
      expect(() => byExpr(bad)).toThrow(expect.objectContaining({ code: 'invalid-ottl' }));
    expect(byExpr('resource.attributes["service.name"]').identity).toBe(true);
    const r: Row[] = own.rows(
      seriesQuery({
        ...base,
        by: [byExpr('resource.attributes["service.name"]'), byExpr('metric.name')],
      }).toString(),
    );
    expect(r.map((x) => [x.g0, x.g1])).toEqual([
      ['"svc-a"', '"g"'],
      ['"svc-a"', '"g"'],
    ]);
  });

  test('where keeps the matching series; resourceTexts and seriesIds narrow', () => {
    const by = [byExpr('attributes["host"]')];
    const host = (rows: Row[]) => rows.map((r) => r.g0).sort();
    expect(host(run(seriesQuery({ ...base, by })))).toEqual(['"h1"', '"h2"']);
    const where = sql`json_extract_string(attributes, '/host') = 'h2'`;
    expect(host(run(seriesQuery({ ...base, by, where })))).toEqual(['"h2"']);
    const ids = run(seriesQuery({ ...base, by }));
    const texts = ids.filter((r) => String(r.resource_attributes).includes('svc-b'));
    expect(texts).toHaveLength(1);
    const narrowed = run(
      seriesQuery({ ...base, by, resourceTexts: [String(texts[0]?.resource_attributes)] }),
    );
    expect(host(narrowed)).toEqual(['"h2"']);
    const one = run(
      seriesQuery({
        ...base,
        by,
        seriesIds: Query.from('points').select({ series_id: sql`series_id` }).where(sql`value_double = 7`),
      }),
    );
    expect(host(one)).toEqual(['"h2"']);
    expect(Object.keys(ids[0] ?? {})).toEqual(
      expect.arrayContaining(['series_id', 'metric_name', 'point_type', 'metric_unit', 'g0']),
    );
  });

  test('files prune the series: none keeps nothing, a subset filters by filename', () => {
    expect(run(seriesQuery({ ...base, files: { files: [], all: false, total: 3 }, by: [] }))).toHaveLength(0);
    const names = run(Query.from('points').distinct().select({ filename: sql`filename` })).map((x) =>
      String(x.filename),
    );
    expect(names.length).toBeGreaterThan(1);
    const [first] = names;
    const of = (list: string[]) =>
      run(seriesQuery({ ...base, files: { files: list, all: false, total: names.length }, by: [] }));
    const some = of(first === undefined ? [] : [first]);
    expect(some.length).toBeGreaterThan(0);
    const inFirst = run(
      Query.from('points')
        .select({ n: sql`count(DISTINCT series_id)` })
        .where(sql`metric_name = ${literal(base.identity.name)} AND filename = ${literal(first ?? '')}`),
    );
    expect(some.length).toBe(Number(inFirst[0]?.n));
    expect(of(names).length).toBe(run(seriesQuery({ ...base, by: [] })).length);
  });

  test('the point interval returns 32 gaps per sampled series, none for one point', async () => {
    const ms = Array.from({ length: 40 }, (_, i) => i * 10_000);
    const request = otlp(
      metricsRequest(
        [
          gauge(
            'long',
            pointsAt(ms, () => ({ asDouble: 1 })),
          ),
          gauge(
            'single',
            pointsAt([0], () => ({ asDouble: 1 })),
          ),
        ],
        resA,
      ) as never,
    );
    const fx = await buildFormat4Report([request], { close: false });
    const own = await openFixtureDb(fx);
    const of = (name: string, window: { start: bigint; end: bigint } | null = null): Row[] =>
      own.rows(
        pointIntervalQuery(
          seriesQuery({
            ...base,
            identity: { ...idG, name },
            by: [],
          }),
          all,
          window,
        ).toString(),
      );
    const gaps = of('long');
    expect(gaps).toHaveLength(32);
    expect(gaps.every((r) => r.gap === 10_000_000_000n)).toBe(true);
    expect(of('single')).toHaveLength(0);
    const w = { start: fx.epoch, end: fx.epoch + 100_000_000_000n };
    expect(of('long', w)).toHaveLength(10);
  });
});
