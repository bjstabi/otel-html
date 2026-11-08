import { Query, sql } from '@uwdata/mosaic-sql';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  identityTerms,
  type MetricIdentity,
  metricDefsQuery,
  metricIdentitiesQuery,
  metricSparkQuery,
  SPARK_BUCKETS,
  summaryQuantilesQuery,
} from '../../../src/query/sql/points.js';
import { bucketSpec } from '../../../src/query/sql/time.js';
import type { TestDb } from '../../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../../test-support/format4-fixture.js';
import { attr, gauge, metricsRequest, pointsAt, sum, summary } from '../../../test-support/otlp-builders.js';
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
  | 'q';
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
        pointsAt([30], () => ({ count: '2', sum: 3, quantileValues: [q(0.99, 9)] })),
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
    expect(run(summaryQuantilesQuery(id)).map((r) => num(r.q))).toEqual([0.5, 0.99]);
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
