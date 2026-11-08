import { literal, Query, sql } from '@uwdata/mosaic-sql';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  byExpr,
  type Cell,
  cellExpr,
  exemplarsQuery,
  identityTerms,
  type MetricIdentity,
  type MetricKind,
  metricCellsQuery,
  metricDefsQuery,
  metricIdentitiesQuery,
  metricSparkQuery,
  pointIntervalQuery,
  runsQuery,
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
  expHistogram,
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
  | 'resource_attributes'
  | 'cell'
  | 'filename'
  | 'c'
  | 'metric_unit'
  | 'delta'
  | 'value'
  | 'count'
  | 'min'
  | 'max'
  | 'counts'
  | 'bounds'
  | 'scale'
  | 'zero_count'
  | 'positive'
  | 'negative'
  | 'quantiles'
  | 'points'
  | 'time_ns'
  | 'exemplars'
  | 'run'
  | 't'
  | 'revision'
  | 'n_series'
  | 'left_out'
  | 'series_id';
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
          { ...idG, name },
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

describe('metric cells, exemplars and runs', () => {
  const sec = (n: number): number => n * 1000;
  const ms10 = [0, 10, 20, 30, 40, 50].map(sec);
  const host = (v: string) => [attr('host', str(v))];
  const exp = (scale: number, offset: number, counts: string[], extra: Record<string, unknown> = {}) => ({
    scale,
    zeroCount: '0',
    positive: { offset, bucketCounts: counts },
    ...extra,
  });
  const MAIN = otlp(
    metricsRequest(
      [
        sum(
          'c',
          pointsAt(ms10, (i) => ({ asDouble: [1, 3, 6, 2, 5, 9][i] ?? 0 }), host('h1')),
          { monotonic: true, temporality: 'cumulative' },
        ),
        sum(
          'c',
          pointsAt(ms10, (i) => ({ asDouble: i })),
          { monotonic: true, temporality: 'cumulative' },
        ),
        gauge(
          'n',
          pointsAt([0, 10, 20, 30].map(sec), (i) => ({ asDouble: [1, 3, 5, 7][i] ?? 0 }), host('h1')),
        ),
        gauge(
          'n',
          pointsAt([0, 10, 20, 30].map(sec), (i) => ({ asDouble: [10, 20, 30, 40][i] ?? 0 }), host('h2')),
        ),
        histogram(
          'h',
          pointsAt(
            [0, 10].map(sec),
            (i) => ({
              count: i === 0 ? '6' : '2',
              sum: 1,
              min: i === 0 ? 0.5 : 0.25,
              max: 7,
              explicitBounds: [1, 5],
              bucketCounts: i === 0 ? ['1', '2', '3'] : ['1', '0', '1'],
            }),
            host('h1'),
          ),
          { temporality: 'delta' },
        ),
        histogram(
          'h',
          pointsAt(
            [0, 10].map(sec),
            (i) => ({
              count: i === 0 ? '6' : '1',
              sum: 1,
              explicitBounds: [1, 5],
              bucketCounts: i === 0 ? ['2', '2', '2'] : ['0', '1', '0'],
            }),
            host('h2'),
          ),
          { temporality: 'delta' },
        ),
        histogram(
          'h',
          pointsAt(
            [0],
            () => ({ count: '3', sum: 1, explicitBounds: [2], bucketCounts: ['1', '2'] }),
            host('h3'),
          ),
          { temporality: 'delta' },
        ),
        histogram(
          'hn',
          pointsAt([0, 10].map(sec), (i) => ({ count: String(i + 4), sum: 1, bucketCounts: [] }), host('h1')),
          { temporality: 'delta' },
        ),
        expHistogram(
          'e',
          pointsAt([0], () => exp(3, 2, ['1', '2'], { zeroCount: '1', count: '4', sum: 5 }), host('a')),
          { temporality: 'delta' },
        ),
        expHistogram(
          'e',
          pointsAt(
            [0],
            () =>
              exp(5, 8, ['1', '1', '1', '1', '2'], {
                count: '9',
                sum: 7,
                negative: { offset: -9, bucketCounts: ['3'] },
              }),
            host('b'),
          ),
          { temporality: 'delta' },
        ),
        expHistogram(
          'e',
          pointsAt([0], () => ({ scale: 1, zeroCount: '2', count: '2', sum: 0 }), host('c')),
          { temporality: 'delta' },
        ),
        summary(
          's',
          pointsAt(
            [0, 10].map(sec),
            (i) => ({ count: i === 0 ? '2' : '5', sum: i, quantileValues: [q(0.5, i + 1)] }),
            host('h1'),
          ),
        ),
        summary(
          's',
          pointsAt([0], () => ({ count: '1', sum: 9, quantileValues: [q(0.5, 8)] }), host('h2')),
        ),
      ],
      resA,
    ) as never,
  );
  const ex = (i: number) => ({
    timeUnixNano: String(BigInt('1700000000000000000') + BigInt(i) * 1_000_000_000n),
    asDouble: i,
    traceId: 'aa'.repeat(16),
  });
  const EXEM = otlp(
    metricsRequest(
      [
        gauge('x', [
          ...pointsAt([0], () => ({ asDouble: 1 }), host('h1')),
          ...pointsAt([10_000], () => ({ asDouble: 2, exemplars: [ex(10)] }), host('h1')),
          ...pointsAt([20_000], () => ({ asDouble: 3, exemplars: [ex(20)] }), host('h1')),
        ]),
      ],
      resA,
    ) as never,
  );
  const runPoint = (ms: number, v: string | null) =>
    gauge(
      'r',
      pointsAt([ms], () => ({ asDouble: 1 }), v === null ? host('x') : [attr('run', str(v))]),
    );
  const rev = (r: string) => [attr('vcs.ref.head.revision', str(r))];
  const RUNS1 = otlp(
    metricsRequest(
      [runPoint(0, 'r1'), runPoint(5000, 'r2'), runPoint(1000, null), runPoint(2000, '')],
      rev('x1'),
    ) as never,
  );
  const RUNS2 = otlp(metricsRequest([runPoint(10_000, 'r1')], rev('x2')) as never);

  let cf: Format4Fixture;
  let cdb: TestDb;
  const rowsOf = (query: string): Row[] => cdb.rows(query);
  beforeAll(async () => {
    cf = await buildFormat4Report([MAIN, EXEM, RUNS1, RUNS2], { close: false });
    cdb = await openFixtureDb(cf);
  });
  const all = { files: ['all-files'], all: true, total: 1 } as const;
  const idOf = (name: string): MetricIdentity => {
    const d = rowsOf(metricDefsQuery().toString()).find((r) => r.metric_name === name);
    if (d === undefined) throw new Error(name);
    return {
      name,
      type: String(d.point_type),
      unit: d.metric_unit === null ? null : String(d.metric_unit),
      temporality: d.aggregation_temporality === null ? null : Number(d.aggregation_temporality),
      monotonic: d.is_monotonic === null ? null : Boolean(d.is_monotonic),
    };
  };
  const seriesOf = (name: string, by: string[] = ['attributes["host"]']) =>
    seriesQuery({
      identity: idOf(name),
      files: all,
      where: null,
      resourceTexts: null,
      seriesIds: null,
      by: by.map(byExpr),
    });
  // The offset of the test clock from the report's epoch, so a cell can be named by its test time.
  const cellAt = (ms: number, w: number): number =>
    Math.floor((ms * 1e6 + Number(BigInt('1700000000000000000') - cf.epoch)) / w) * w;
  const W20 = 20e9;
  const cells = (
    name: string,
    kind: MetricKind,
    over: {
      show?: string;
      window?: { start: bigint; end: bigint } | null;
      baseline?: boolean;
      by?: string[];
    } = {},
  ): Row[] => {
    const by = over.by ?? ['attributes["host"]'];
    return rowsOf(
      metricCellsQuery({
        identity: idOf(name),
        kind,
        show: over.show ?? 'avg',
        series: seriesOf(name, by),
        files: all,
        window: over.window ?? null,
        cell: { kind: 'time', widthNs: W20, baseline: over.baseline ?? false },
        epoch: cf.epoch,
        byCount: by.length,
      }).toString(),
    );
  };

  test('counter cells sum the deltas of both series and count the reset', () => {
    const rows = cells('c', 'counter', { by: [] });
    expect(rows.map((r) => [num(r.cell), num(r.delta), num(r.resets), num(r.n)])).toEqual([
      [cellAt(0, W20), 3, 0, 4],
      [cellAt(20_000, W20), 7, 1, 4],
      [cellAt(40_000, W20), 9, 0, 4],
    ]);
  });

  test('the baseline cell -1 holds the deltas before the window', () => {
    const window = { start: cf.epoch + BigInt(cellAt(20_000, W20)), end: cf.epoch + 70_000_000_000n };
    const rows = cells('c', 'counter', { by: [], window, baseline: true });
    expect(rows.map((r) => [num(r.cell), num(r.delta)])).toEqual([
      [-1, 3],
      [cellAt(20_000, W20), 7],
      [cellAt(40_000, W20), 9],
    ]);
  });

  test('a time cell floors with a non-negative modulo; a baseline sends earlier rows to -1', () => {
    const cell: Cell = { kind: 'time', widthNs: W20, baseline: true };
    const window = { start: cf.epoch + 20_000_000_000n, end: cf.epoch + 60_000_000_000n };
    const at = (c: Cell, t: bigint): unknown =>
      rowsOf(
        Query.from({
          t: Query.from('points')
            .select({ time_unix_nano: sql`${literal(t)}::BIGINT` })
            .limit(1),
        })
          .select({ c: cellExpr(c, cf.epoch, window) })
          .toString(),
      )[0]?.c;
    expect(num(at(cell, cf.epoch + 25_000_000_000n))).toBe(20e9);
    expect(num(at(cell, cf.epoch + 19_000_000_000n))).toBe(-1);
    expect(num(at({ ...cell, baseline: false }, cf.epoch - 1n))).toBe(-W20);
  });

  test('number cells combine the per-series values by show', () => {
    const at = (show: string) =>
      cells('n', 'number', { show, by: [] }).map((r) => [num(r.cell), num(r.value), num(r.n)]);
    const c0 = cellAt(0, W20);
    const c1 = cellAt(20_000, W20);
    expect(at('last')).toEqual([
      [c0, 23, 2],
      [c1, 47, 2],
    ]);
    expect(at('avg')).toEqual([
      [c0, 8.5, 2],
      [c1, 20.5, 2],
    ]);
    expect(at('min')[0]?.[1]).toBe(1);
    expect(at('max')[1]?.[1]).toBe(40);
  });

  test('hist cells sum bucket counts elementwise and keep a row per bounds set', () => {
    const rows = cells('h', 'hist', { by: [] });
    const shaped = rows.map((r) => ({
      cell: num(r.cell),
      bounds: [...(r.bounds as number[])],
      count: num(r.count),
      sum: num(r.sum),
      counts: [...(r.counts as bigint[])].map(Number),
    }));
    const c0 = cellAt(0, W20);
    expect(shaped).toEqual([
      { cell: c0, bounds: [1, 5], count: 6 + 2 + 6 + 1, sum: 4, counts: [4, 5, 6] },
      { cell: c0, bounds: [2], count: 3, sum: 1, counts: [1, 2] },
    ]);
    expect(num(rows[0]?.min)).toBe(0.25);
    expect(num(rows[0]?.max)).toBe(7);
  });

  test('a histogram with no bounds has one bucket holding its count', () => {
    const rows = cells('hn', 'hist', { by: [] });
    expect(rows).toHaveLength(1);
    expect([num(rows[0]?.count), [...((rows[0]?.counts as bigint[]) ?? [])].map(Number)]).toEqual([9, [9]]);
  });

  test('exp cells come back at the smallest scale with floor-shifted indexes', () => {
    const [r] = cells('e', 'exp', { by: [] });
    expect(num(r?.scale)).toBe(3);
    const side = (v: unknown) =>
      [...(v as { idx: number; cnt: bigint }[])].map((e) => [e.idx, Number(e.cnt)]);
    // a: indexes 2, 3; b at scale 5: 8..11 -> 2, 12 -> 3.
    expect(side(r?.positive)).toEqual([
      [2, 5],
      [3, 4],
    ]);
    // b's negative index -9 at scale 5 is floor(-9 / 4) = -3 at scale 3.
    expect(side(r?.negative)).toEqual([[-3, 3]]);
    expect(num(r?.count)).toBe(4 + 9 + 2);
    expect(num(r?.zero_count)).toBe(1 + 0 + 2);
    expect(num(r?.sum)).toBe(12);
  });

  test('summary cells are per series: the last point and the points in the cell', () => {
    const rows = cells('s', 'summary');
    expect(rows).toHaveLength(2);
    const h = (v: string) => rows.find((r) => r.g0 === `"${v}"`);
    expect([num(h('h1')?.count), num(h('h1')?.sum), num(h('h1')?.points)]).toEqual([5, 1, 2]);
    expect(String(h('h1')?.quantiles)).toContain('2');
    expect([num(h('h2')?.count), num(h('h2')?.points)]).toEqual([1, 1]);
    expect(Object.keys(rows[0] ?? {})).toContain('series_id');
  });

  test('exemplars come oldest first with the limit and relative times', () => {
    const mk = (limit: number) =>
      rowsOf(exemplarsQuery(idOf('x'), seriesOf('x'), all, null, cf.epoch, limit, 1).toString());
    const rows = mk(10);
    expect(rows.map((r) => num(r.time_ns))).toEqual([cellAt(10_000, 1), cellAt(20_000, 1)]);
    expect(rows.map((r) => r.g0)).toEqual(['"h1"', '"h1"']);
    expect(String(rows[0]?.exemplars)).toContain('aa');
    expect(mk(1)).toHaveLength(1);
  });

  test('runs carry the latest time, the revision of the latest point and the left-out count', () => {
    const rows = rowsOf(runsQuery(idOf('r'), seriesOf('r', ['attributes["run"]']), all, cf.epoch).toString());
    const run = (v: string | null) => rows.find((r) => r.run === v);
    expect([num(run('"r1"')?.t), run('"r1"')?.revision, num(run('"r1"')?.n_series)]).toEqual([
      cellAt(10_000, 1),
      'x2',
      // Two series: the run's points came from two resources.
      2,
    ]);
    expect([num(run('"r2"')?.t), run('"r2"')?.revision]).toEqual([cellAt(5000, 1), 'x1']);
    expect(num(run(null)?.left_out)).toBe(2);
    expect(rows.map((r) => r.run)).toEqual(['"r2"', '"r1"', null]);
  });

  test('a run cell is the run expression', () => {
    const by = byExpr('attributes["run"]');
    const rows = rowsOf(
      metricCellsQuery({
        identity: idOf('r'),
        kind: 'number',
        show: 'avg',
        series: seriesOf('r', ['attributes["run"]']),
        files: all,
        window: null,
        cell: { kind: 'run', run: by },
        epoch: cf.epoch,
        byCount: 1,
      }).toString(),
    );
    expect(rows.map((r) => [r.g0, r.cell, num(r.value)])).toEqual([
      ['""', '""', 1],
      ['"r1"', '"r1"', 1],
      ['"r2"', '"r2"', 1],
      [null, null, 1],
    ]);
  });
});

describe('series identity and the baseline across partitions', () => {
  const g = (...kv: [string, string][]) => kv.map(([k, v]) => attr(k, str(v)));
  const id: MetricIdentity = { name: 'g', type: 'gauge', unit: '1', temporality: 0, monotonic: false };
  const all = { files: ['all-files'], all: true, total: 1 } as const;

  test('the same series written with its attribute keys reordered is one row', async () => {
    const one = otlp(
      metricsRequest(
        [
          gauge(
            'g',
            pointsAt([0], () => ({ asDouble: 1 }), g(['a', '1'], ['b', '2'])),
          ),
        ],
        resA,
      ) as never,
    );
    const two = otlp(
      metricsRequest(
        [
          gauge(
            'g',
            pointsAt([10], () => ({ asDouble: 2 }), g(['b', '2'], ['a', '1'])),
          ),
        ],
        resA,
      ) as never,
    );
    const fx = await buildFormat4Report([one, two], { close: false });
    const db0 = await openFixtureDb(fx);
    const own = { rows: (q: string): Row[] => db0.rows(q) };
    const rows: Row[] = own.rows(
      seriesQuery({
        identity: id,
        files: all,
        where: null,
        resourceTexts: null,
        seriesIds: null,
        by: [],
      }).toString(),
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {})).toContain('metric_description');
  });

  test('a baseline with files pruned without the lower bound holds the earlier partition', async () => {
    const cum = (ms: number[], vals: number[]) =>
      otlp(
        metricsRequest(
          [
            sum(
              'c',
              pointsAt(ms, (i) => ({ asDouble: vals[i] ?? 0 })),
              { monotonic: true, temporality: 'cumulative' },
            ),
          ],
          resA,
        ) as never,
      );
    const fx = await buildFormat4Report([cum([0, 10_000], [1, 4]), cum([20_000, 30_000], [6, 10])], {
      close: false,
    });
    const db0 = await openFixtureDb(fx);
    const own = { rows: (q: string): Row[] => db0.rows(q) };
    const names = own
      .rows('SELECT DISTINCT filename FROM points ORDER BY min(time_unix_nano) OVER (PARTITION BY filename)')
      .map((r) => String(r.filename));
    expect(names.length).toBe(2);
    const second = names.at(-1) ?? '';
    // The window lies inside the second partition; pruning kept both files (no lower bound).
    const window = { start: fx.epoch + 20_000_000_000n, end: fx.epoch + 40_000_000_000n };
    const cid: MetricIdentity = { name: 'c', type: 'sum', unit: '1', temporality: 2, monotonic: true };
    const run = (files: { files: string[]; all: boolean; total: number }): Row[] =>
      own.rows(
        metricCellsQuery({
          identity: cid,
          kind: 'counter',
          show: 'sum',
          series: seriesQuery({
            identity: cid,
            files,
            where: null,
            resourceTexts: null,
            seriesIds: null,
            by: [],
          }),
          files,
          window,
          cell: { kind: 'time', widthNs: 20e9, baseline: true },
          epoch: fx.epoch,
          byCount: 0,
        }).toString(),
      );
    const full = run({ files: names, all: true, total: 2 });
    expect(full.map((r) => [Number(r.cell), Number(r.delta)])).toEqual([
      [-1, 3],
      [20e9, 6],
    ]);
    // Pruned with the window's lower bound, the first partition is gone and cell -1 is empty.
    const cut = run({ files: [second], all: false, total: 2 });
    expect(cut.map((r) => Number(r.cell))).toEqual([20e9]);
  });
});
