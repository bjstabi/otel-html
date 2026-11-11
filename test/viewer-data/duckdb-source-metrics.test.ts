import { tableFromArrays } from '@uwdata/flechette';
import { and } from '@uwdata/mosaic-sql';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { OtlpRequest } from '../../src/model/otlp-json.js';
import type { MetricQuery } from '../../src/query/metric-query.js';
import { toSql } from '../../src/query/sql/columns.js';
import { buildFilter, whereOf } from '../../src/query/sql/filter.js';
import { quantileOf } from '../../src/rollups/metric-agg.js';
import { metricMethods } from '../../src/viewer/data/duckdb-metrics.js';
import type { MetricEntry } from '../../src/viewer/data/metric-catalog.js';
import { seriesTarget } from '../../src/viewer/data/metric-mappers.js';
import {
  type CatalogRows,
  catalogFrom,
  type MetricMethods,
  type MetricQueryResult,
} from '../../src/viewer/data/metric-results.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';
import { medianMsAsync } from '../../test-support/median-ms.js';
import {
  attr,
  expHistogram,
  gauge,
  histogram,
  metricsRequest,
  pointsAt,
  sum,
  summary,
} from '../../test-support/otlp-builders.js';
import { perfFactor } from '../../test-support/perf-inject.js';
import { otlp } from '../../test-support/writer-deps.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const str = (v: string) => ({ stringValue: v });
const resA = [attr('service.name', str('svc-a'))];
const resB = [attr('service.name', str('svc-b'))];
const q = (quantile: number, value: number) => ({ quantile, value });

// Partition 0 (svc-a): all five kinds, and `u` twice with two units.
const P0 = otlp(
  metricsRequest(
    [
      gauge(
        'g',
        pointsAt([0, 10], (i) => ({ asDouble: 1 + i }), [attr('host', str('h1'))]),
      ),
      sum(
        'c',
        pointsAt([0, 10], (i) => ({ asDouble: 5 + i })),
        { monotonic: true, temporality: 'cumulative' },
      ),
      histogram(
        'h',
        pointsAt([0], () => ({ count: '2', sum: 3, explicitBounds: [1], bucketCounts: ['1', '1'] })),
        { temporality: 'delta' },
      ),
      expHistogram(
        'e',
        pointsAt([5], () => ({
          count: '1',
          sum: 1,
          scale: 0,
          zeroCount: '0',
          positive: { offset: 0, bucketCounts: ['1'] },
        })),
        { temporality: 'delta' },
      ),
      summary(
        's',
        pointsAt([0], () => ({ count: '2', sum: 3, quantileValues: [q(0.5, 1)] })),
      ),
      sum(
        'u',
        pointsAt([0], () => ({ asDouble: 1 })),
        { monotonic: false, temporality: 'cumulative' },
      ),
      sum(
        'u',
        pointsAt([0], () => ({ asDouble: 1 })),
        { monotonic: false, temporality: 'cumulative', unit: 'ms' },
      ),
    ],
    resA,
  ) as never,
);
// Partition 1 (svc-b): the gauge on another host with another attribute key, the summary with 0.99.
const P1 = otlp(
  metricsRequest(
    [
      gauge(
        'g',
        pointsAt([30], () => ({ asDouble: 4 }), [attr('host', str('h2')), attr('az', str('x'))]),
      ),
      summary(
        's',
        pointsAt([30], () => ({ count: '2', sum: 3, quantileValues: [q(0.99, 9)] })),
      ),
    ],
    resB,
  ) as never,
);

let f: Format4Fixture;
let db: TestDb;
let engine: QueryEngine;
let queries: number;
let m: MetricMethods;

beforeAll(async () => {
  f = await buildFormat4Report([P0, P1], { close: false });
  db = await openFixtureDb(f);
  const inner = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
  queries = 0;
  engine = {
    ...inner,
    query: (qq, signal) => {
      queries++;
      return inner.query(qq, signal);
    },
  };
  m = metricMethods({ engine, manifest: f.manifest, epoch: f.epoch, range: { start: 0, end: 40e6 } });
});

const byName = (es: readonly MetricEntry[], name: string, unit?: string): MetricEntry => {
  const e = es.find((x) => x.name === name && (unit === undefined || x.unit === unit));
  if (e === undefined) throw new Error(`no entry ${name}`);
  return e;
};

describe('metricCatalog', () => {
  test('entries are ordered with sequential ids and describe each definition', async () => {
    const before = queries;
    const cat = await m.metricCatalog();
    expect(queries - before).toBe(3);
    await m.metricCatalog();
    expect(queries - before).toBe(3);
    expect(cat.entries.map((e) => [e.id, e.name, e.unit])).toEqual([
      [0, 'c', '1'],
      [1, 'e', '1'],
      [2, 'g', '1'],
      [3, 'h', '1'],
      [4, 's', '1'],
      [5, 'u', '1'],
      [6, 'u', 'ms'],
    ]);
    expect(cat.entries.map((e) => e.conflicting)).toEqual([false, false, false, false, false, true, true]);
    const c = byName(cat.entries, 'c');
    expect([c.type, c.temporality, c.monotonic]).toEqual(['sum', 'cumulative', true]);
    const g = byName(cat.entries, 'g');
    expect([g.type, g.temporality, g.monotonic]).toEqual(['gauge', 'unspecified', false]);
    expect(byName(cat.entries, 'e').type).toBe('exponentialHistogram');
    expect(byName(cat.entries, 'h').temporality).toBe('delta');
    expect(byName(cat.entries, 's').type).toBe('summary');
  });

  test('series, points, attribute keys, resources and scopes', async () => {
    const cat = await m.metricCatalog();
    const g = byName(cat.entries, 'g');
    expect(g.series).toBe(2);
    expect(g.points).toBe(3);
    expect(g.attributeKeys).toEqual(['az', 'host']);
    expect(g.scopes).toEqual(['test-scope']);
    expect(cat.resources).toHaveLength(2);
    expect(cat.scopes).toHaveLength(1);
    const names = (e: MetricEntry): (string | undefined)[] =>
      e.resources.map((i) => {
        const v = cat.resources[i]?.attributes.get('service.name');
        return v?.kind === 'string' ? v.value : undefined;
      });
    expect(names(g).sort()).toEqual(['svc-a', 'svc-b']);
    expect(names(byName(cat.entries, 'c'))).toEqual(['svc-a']);
    expect(byName(cat.entries, 'c').attributeKeys).toEqual([]);
  });

  test('the sparkline has at most 128 buckets of the points natural values', async () => {
    const cat = await m.metricCatalog();
    const g = byName(cat.entries, 'g');
    expect(g.spark.sums.length).toBeLessThanOrEqual(128);
    expect(g.spark.counts.length).toBe(g.spark.sums.length);
    expect(g.spark.sums.reduce((a, b) => a + b, 0)).toBe(1 + 2 + 4);
    expect(g.spark.counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(g.spark.widthNs).toBeGreaterThan(0);
  });
});

describe('metricShowOptions', () => {
  test('the summary lists its quantiles, then count and sum, in one statement', async () => {
    const cat = await m.metricCatalog();
    const s = byName(cat.entries, 's');
    const before = queries;
    expect(await m.metricShowOptions(s.id)).toEqual(['q0.5', 'q0.99', 'count', 'sum']);
    expect(queries - before).toBe(1);
  });

  test('two calls for one summary issue one statement', async () => {
    const inner = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
    let runs = 0;
    const counting: QueryEngine = {
      ...inner,
      query: (qq, signal) => {
        runs++;
        return inner.query(qq, signal);
      },
    };
    const mm = metricMethods({ engine: counting, manifest: f.manifest, epoch: f.epoch, range: null });
    const s = byName((await mm.metricCatalog()).entries, 's');
    const before = runs;
    const [a, b] = await Promise.all([mm.metricShowOptions(s.id), mm.metricShowOptions(s.id)]);
    await mm.metricShowOptions(s.id);
    expect(a).toEqual(b);
    expect(runs - before).toBe(1);
  });

  test('a rejected read is not kept: the next call retries', async () => {
    const inner = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
    let armed = false;
    const flaky: QueryEngine = {
      ...inner,
      query: (qq, signal) => {
        if (armed) {
          armed = false;
          return Promise.reject(new Error('boom'));
        }
        return inner.query(qq, signal);
      },
    };
    const mm = metricMethods({ engine: flaky, manifest: f.manifest, epoch: f.epoch, range: null });
    const s = byName((await mm.metricCatalog()).entries, 's');
    armed = true;
    await expect(mm.metricShowOptions(s.id)).rejects.toThrow('boom');
    expect(await mm.metricShowOptions(s.id)).toEqual(['q0.5', 'q0.99', 'count', 'sum']);
  });

  test('other kinds use the fixed options and no statement', async () => {
    const cat = await m.metricCatalog();
    const before = queries;
    expect(await m.metricShowOptions(byName(cat.entries, 'c').id)).toEqual(['rate', 'increase', 'sum']);
    expect(await m.metricShowOptions(byName(cat.entries, 'g').id)).toEqual(['avg', 'min', 'max', 'last']);
    expect(queries - before).toBe(0);
  });
});

describe('metricsForResources', () => {
  test('lists only the metrics with a series on the resource', async () => {
    const cat = await m.metricCatalog();
    const b = cat.resources.find((r) => {
      const v = r.attributes.get('service.name');
      return v?.kind === 'string' && v.value === 'svc-b';
    });
    if (b === undefined) throw new Error('no svc-b');
    const found = await m.metricsForResources([b]);
    expect(found.map((e) => e.name)).toEqual(['g', 's']);
  });
});

describe('catalog robustness', () => {
  test('a rejected load clears the memo; the next call succeeds', async () => {
    const inner = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
    let failures = 1;
    const flaky: QueryEngine = {
      ...inner,
      query: (qq, signal) => {
        if (failures > 0) {
          failures--;
          return Promise.reject(new Error('boom'));
        }
        return inner.query(qq, signal);
      },
    };
    const mm = metricMethods({ engine: flaky, manifest: f.manifest, epoch: f.epoch, range: null });
    await expect(mm.metricCatalog()).rejects.toThrow('boom');
    expect((await mm.metricCatalog()).entries.length).toBeGreaterThan(0);
  });

  test('one resource stored with its attributes in two key orders has one record and two texts', () => {
    const texts = ['{"a":"1","b":"2"}', '{"b":"2","a":"1"}'];
    const def = {
      metric_name: ['m'],
      point_type: ['gauge'],
      metric_unit: ['1'],
      aggregation_temporality: [0],
      is_monotonic: [false],
    };
    const defs = tableFromArrays({
      ...def,
      description: [''],
      points: [2n],
      series: [2n],
      resets: [0n],
      out_of_order: [0n],
      no_value: [0n],
      scopes: [['s']],
    });
    const ids = tableFromArrays({
      metric_name: ['m', 'm'],
      point_type: ['gauge', 'gauge'],
      metric_unit: ['1', '1'],
      aggregation_temporality: [0, 0],
      is_monotonic: [false, false],
      attributes: ['{}', '{}'],
      resource_attributes: texts,
      resource_schema_url: ['', ''],
      resource_dropped_attributes_count: [0n, 0n],
      scope_name: ['s', 's'],
      scope_version: ['', ''],
      scope_attributes: ['{}', '{}'],
      scope_schema_url: ['', ''],
      scope_dropped_attributes_count: [0n, 0n],
    });
    const spark = tableFromArrays({ ...def, bucket: [0n], sum: [1], n: [1n] });
    const cat = catalogFrom(defs, ids, spark, { widthNs: 1e6, startNs: 0, endNs: 0 });
    expect(cat.resources).toHaveLength(1);
    expect([...(cat.resourceTexts[0] ?? [])].sort()).toEqual([...texts].sort());
    expect(cat.entries[0]?.resources).toEqual([0]);
    expect(cat.entries[0]?.series).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Chart and run queries (D22 to D28)
// ---------------------------------------------------------------------------------------------

const S = 1e9;
const sec = (...s: number[]): number[] => s.map((x) => x * 1000);

interface Env {
  m: MetricMethods;
  f: Format4Fixture;
  cat: CatalogRows;
  entry(name: string, unit?: string): MetricEntry;
  db: TestDb;
}

const opened: TestDb[] = [];
afterAll(() => {
  for (const d of opened) d.close();
});

/** A report with one partition per request, and the data layer over it. */
async function openEnv(
  requests: readonly OtlpRequest[],
  wrap: (e: QueryEngine) => QueryEngine = (e) => e,
): Promise<Env> {
  const fx = await buildFormat4Report(requests, { close: false });
  const d = await openFixtureDb(fx);
  opened.push(d);
  const engine = wrap(mosaicQueryEngine(createCoordinator(d.connector, silentLogger), d));
  const mm = metricMethods({
    engine,
    manifest: fx.manifest,
    epoch: fx.epoch,
    range: { start: 0, end: 4000 * S },
  });
  const cat = await mm.metricCatalog();
  return {
    m: mm,
    f: fx,
    cat: cat as CatalogRows,
    db: d,
    entry: (name, unit) => byName(cat.entries, name, unit),
  };
}

const req = (name: string, over: Partial<MetricQuery> = {}): MetricQuery => ({
  id: 'a',
  metric: name,
  kind: null,
  unit: null,
  show: 'avg',
  by: [],
  where: null,
  fn: [],
  alias: null,
  hidden: false,
  ...over,
});

const chart = (
  env: Env,
  name: string,
  over: Partial<MetricQuery>,
  window: { start: number; end: number },
  extra: { widthNs?: number; resources?: readonly number[]; exemplars?: boolean; maxPoints?: number } = {},
): Promise<MetricQueryResult> =>
  env.m.metricQuery({
    entry: env.entry(name),
    query: req(name, over),
    window,
    maxPoints: extra.maxPoints ?? 600,
    exemplars: extra.exemplars ?? false,
    ...(extra.widthNs === undefined ? {} : { widthNs: extra.widthNs }),
    ...(extra.resources === undefined ? {} : { resources: extra.resources }),
  });

const vals = (r: MetricQueryResult, i = 0): (number | null)[] =>
  (r.series[i]?.points ?? []).map(([, v]) => v);
const times = (r: MetricQueryResult, i = 0): number[] => (r.series[i]?.points ?? []).map(([t]) => t);
const ALL = { start: 0, end: 3600 * S };

describe('counters', () => {
  // Series A spans both partitions (its cumulative stream continues), B has only early points.
  const P_A = otlp(
    metricsRequest(
      [
        sum(
          'c',
          pointsAt(sec(0, 10, 20), (i) => ({ asDouble: [10, 30, 60][i] ?? 0 }), [attr('k', str('a'))]),
          {
            monotonic: true,
            temporality: 'cumulative',
          },
        ),
        sum(
          'c',
          pointsAt(sec(0, 5), (i) => ({ asDouble: [5, 12][i] ?? 0 }), [attr('k', str('b'))]),
          {
            monotonic: true,
            temporality: 'cumulative',
          },
        ),
        sum(
          'cr',
          pointsAt(sec(0, 10, 20), (i) => ({ asDouble: [100, 150, 20][i] ?? 0 })),
          {
            monotonic: true,
            temporality: 'cumulative',
          },
        ),
      ],
      resA,
    ) as never,
  );
  const P_B = otlp(
    metricsRequest(
      [
        sum(
          'c',
          pointsAt(sec(30, 40), (i) => ({ asDouble: [100, 150][i] ?? 0 }), [attr('k', str('a'))]),
          {
            monotonic: true,
            temporality: 'cumulative',
          },
        ),
      ],
      resA,
    ) as never,
  );
  let env: Env;
  beforeAll(async () => {
    env = await openEnv([P_A, P_B]);
  });
  const w = { start: 0, end: 49.9 * S };

  test('the fixture has two partitions', () => {
    expect(env.f.manifest.partitions).toHaveLength(2);
  });

  test('rate over 10 s buckets with delta 20 is 2/s; the unit is 1/s', async () => {
    const r = await chart(env, 'c', { show: 'rate' }, w, { widthNs: 10 * S });
    expect(vals(r).map((v) => Number(v?.toFixed(9)))).toEqual([0.7, 2, 3, 4, 5]);
    expect(r.series[0]?.unit).toBe('1/s');
    expect(r.widthNs).toBe(10 * S);
  });

  test('increase is the delta', async () => {
    const r = await chart(env, 'c', { show: 'increase' }, w, { widthNs: 10 * S });
    expect(vals(r)).toEqual([7, 20, 30, 40, 50]);
    expect(r.series[0]?.unit).toBe('1');
  });

  test('sum is the running total including the deltas before the window, of both series shapes', async () => {
    // A straddles the window (0+20+30 before it), B lies wholly before it (7); the window sits in the second partition.
    const r = await chart(env, 'c', { show: 'sum' }, { start: 25 * S, end: 49.9 * S }, { widthNs: 10 * S });
    // the window starts mid-bucket: the 20 s bucket is read whole (A's 30 on top of 20 + 7 before it), none before it
    expect(vals(r)).toEqual([57, 97, 147]);
    expect(times(r)).toEqual([20 * S, 30 * S, 40 * S]);
  });

  test('sum by group draws only groups with data in the window, with their own baseline', async () => {
    const r = await chart(
      env,
      'c',
      { show: 'sum', by: ['attributes["k"]'] },
      { start: 25 * S, end: 49.9 * S },
      { widthNs: 10 * S },
    );
    expect(r.series.map((s) => [s.label, vals(r, r.series.indexOf(s))])).toEqual([['a', [50, 90, 140]]]);
  });

  test('a window starting mid-bucket reads the whole first bucket', async () => {
    const r = await chart(
      env,
      'c',
      { show: 'increase' },
      { start: 25 * S, end: 45 * S },
      { widthNs: 10 * S },
    );
    // the 20 s bucket holds A's delta 30 although its point lies before the window; the 40 s bucket is read to its end
    expect(vals(r)).toEqual([30, 40, 50]);
    expect(times(r)).toEqual([20 * S, 30 * S, 40 * S]);
  });

  test('a reset shows the reset point and gives the note', async () => {
    const r = await chart(env, 'cr', { show: 'increase' }, w, { widthNs: 10 * S });
    expect(vals(r)).toEqual([0, 50, 20]);
    expect(r.notes).toContain('1 counter reset in range');
  });
});

describe('numbers', () => {
  const G = otlp(
    metricsRequest(
      [
        gauge('g', [
          ...pointsAt(sec(0, 5), (i) => ({ asDouble: [1, 3][i] ?? 0 }), [attr('host', str('h1'))]),
          ...pointsAt(sec(0, 5), (i) => ({ asDouble: [10, 20][i] ?? 0 }), [attr('host', str('h2'))]),
        ]),
        gauge('ty', [
          ...pointsAt(sec(0), () => ({ asDouble: 1 }), [attr('k', { intValue: '1' })]),
          ...pointsAt(sec(0), () => ({ asDouble: 2 }), [attr('k', str('1'))]),
          ...pointsAt(sec(0), () => ({ asDouble: 3 }), [attr('k', { doubleValue: 3 })]),
          ...pointsAt(sec(0), () => ({ asDouble: 4 }), [attr('k', { intValue: '3' })]),
        ]),
        gauge(
          'odd',
          pointsAt(sec(0), () => ({ asDouble: 1 }), [attr('a/b~c', str('x'))]),
        ),
        gauge('rs', [
          ...pointsAt(sec(0), () => ({ asDouble: 1 }), [attr('k', str('abc'))]),
          ...pointsAt(sec(0), () => ({ asDouble: 2 }), [attr('k', str('ab'))]),
          ...pointsAt(sec(0), () => ({ asDouble: 3 }), [attr('k', str('abcd'))]),
        ]),
        gauge('early', [
          ...pointsAt(sec(0), () => ({ asDouble: 1 }), [attr('host', str('h1'))]),
          ...pointsAt(sec(50), () => ({ asDouble: 2 }), [attr('host', str('h2'))]),
        ]),
      ],
      resA,
    ) as never,
  );
  let env: Env;
  beforeAll(async () => {
    env = await openEnv([G]);
  });
  const w = { start: 0, end: 9.9 * S };

  test.each([
    ['avg', [8.5]],
    ['min', [1]],
    ['max', [20]],
    ['last', [23]],
  ])('%s across two series', async (show, expected) => {
    const r = await chart(env, 'g', { show }, w, { widthNs: 10 * S });
    expect(vals(r)).toEqual(expected);
    expect(r.series[0]?.resourceService).toBe('svc-a');
  });

  test('by labels groups and keeps one line per value', async () => {
    const r = await chart(env, 'g', { by: ['attributes["host"]'], show: 'avg' }, w, { widthNs: 10 * S });
    expect(r.series.map((s) => [s.label, s.group, vals(r, r.series.indexOf(s))])).toEqual([
      ['h1', { 'attributes["host"]': 'h1' }, [2]],
      ['h2', { 'attributes["host"]': 'h2' }, [15]],
    ]);
  });

  test('by keeps int 1 and string "1" apart, and a double 3 from an int 3 (Review Focus 2)', async () => {
    const r = await chart(env, 'ty', { by: ['attributes["k"]'], show: 'last' }, w, { widthNs: 10 * S });
    expect(r.series).toHaveLength(4);
    expect(new Set(r.series.map((s) => s.key)).size).toBe(4);
    expect(r.series.map((s) => s.label).sort()).toEqual(['1', '1', '3', '3']);
    expect(r.series.map((s) => vals(r, r.series.indexOf(s))[0]).sort()).toEqual([1, 2, 3, 4]);
  });

  test('where on the string "1" keeps that series only', async () => {
    const r = await chart(env, 'ty', { where: 'attributes["k"] == "1"', show: 'last' }, w, {
      widthNs: 10 * S,
    });
    expect(vals(r)).toEqual([2]);
    expect(r.notes.some((n) => n.startsWith('Evaluated in the browser'))).toBe(false);
  });

  test('an attribute key with / and ~ works in by and where', async () => {
    const r = await chart(
      env,
      'odd',
      { by: ['attributes["a/b~c"]'], where: 'attributes["a/b~c"] == "x"' },
      w,
      { widthNs: 10 * S },
    );
    expect(r.series.map((s) => s.label)).toEqual(['x']);
  });

  test('a residual where gives the same series as the SQL form, and the note (Review Focus 5)', async () => {
    const sql = await chart(
      env,
      'rs',
      { where: 'attributes["k"] != "ab"', by: ['attributes["k"]'], show: 'last' },
      w,
      {
        widthNs: 10 * S,
      },
    );
    const residual = await chart(
      env,
      'rs',
      { where: 'Len(attributes["k"]) > 2', by: ['attributes["k"]'], show: 'last' },
      w,
      { widthNs: 10 * S },
    );
    expect(residual.series).toEqual(sql.series);
    expect(residual.series.map((s) => s.label)).toEqual(['abc', 'abcd']);
    expect(residual.notes.filter((n) => n.startsWith('Evaluated in the browser: ')).length).toBe(1);
    expect(residual.notes.join(' ')).toContain('Len(');
    expect(sql.notes).toEqual([]);
  });

  test('a residual where drops its temp table', async () => {
    const before = env.db.rows(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'otel_residual_%'",
    );
    await chart(env, 'rs', { where: 'Len(attributes["k"]) > 2' }, w, { widthNs: 10 * S });
    const after = env.db.rows(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'otel_residual_%'",
    );
    expect(after).toEqual(before);
  });

  test('a per-point path in where is rejected', async () => {
    await expect(chart(env, 'g', { where: 'time_unix_nano > 5' }, w, { widthNs: 10 * S })).rejects.toThrow();
  });

  test('a show the kind does not offer is a usage error', async () => {
    await expect(chart(env, 'g', { show: 'rate' }, w, { widthNs: 10 * S })).rejects.toThrow(/show/);
  });

  test('series with no point in the window are not charted', async () => {
    const r = await chart(
      env,
      'early',
      { by: ['attributes["host"]'] },
      { start: 0, end: 10 * S },
      { widthNs: 10 * S },
    );
    expect(r.series.map((s) => s.label)).toEqual(['h1']);
  });

  test('an aborted signal rejects', async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      env.m.metricQuery(
        { entry: env.entry('g'), query: req('g'), window: w, maxPoints: 600, exemplars: false },
        c.signal,
      ),
    ).rejects.toThrow();
  });

  test('buildFilter and whereOf bound the points by the window', () => {
    const { filter } = buildFilter({
      manifest: env.f.manifest,
      table: 'points',
      condition: null,
      text: '',
      window: { start: 0, end: 10 * S },
    });
    const where = toSql(and(...whereOf(filter, 'points')));
    expect(where).toContain('time_unix_nano');
    const [counted] = env.db.rows(
      `SELECT count(*) AS n FROM points WHERE metric_name = 'early' AND ${where}`,
    );
    const { n } = counted ?? {};
    expect(Number(n)).toBe(1);
  });
});

describe('histograms', () => {
  const hp = (counts: string[], count: string, bounds: number[], k: string) =>
    pointsAt(
      sec(0),
      () => ({ count, sum: 5, min: 0.5, max: 12, explicitBounds: bounds, bucketCounts: counts }),
      [attr('k', str(k))],
    );
  const H = otlp(
    metricsRequest(
      [
        histogram(
          'h',
          [...hp(['2', '1', '0'], '3', [1, 10], 'a'), ...hp(['0', '3', '1'], '4', [1, 10], 'b')],
          {
            temporality: 'delta',
          },
        ),
        histogram('hd', [...hp(['2', '1', '0'], '3', [1, 10], 'a'), ...hp(['1', '1'], '2', [5], 'b')], {
          temporality: 'delta',
        }),
        histogram(
          'hw',
          pointsAt(sec(0, 10, 20), () => ({
            count: '1',
            sum: 1,
            explicitBounds: [1],
            bucketCounts: ['1', '0'],
          })),
          { temporality: 'delta' },
        ),
        expHistogram(
          'e',
          [
            ...pointsAt(
              sec(0),
              () => ({
                count: '1',
                sum: 1,
                scale: 3,
                zeroCount: '0',
                positive: { offset: 0, bucketCounts: ['1'] },
              }),
              [attr('k', str('a'))],
            ),
            ...pointsAt(
              sec(0),
              () => ({
                count: '3',
                sum: 3,
                scale: 5,
                zeroCount: '0',
                positive: { offset: 0, bucketCounts: ['1', '2'] },
              }),
              [attr('k', str('b'))],
            ),
          ],
          { temporality: 'delta' },
        ),
      ],
      resA,
    ) as never,
  );
  let env: Env;
  beforeAll(async () => {
    env = await openEnv([H]);
  });
  const w = { start: 0, end: 9.9 * S };

  test('p95 of merged series equals quantileOf over the summed counts; same bounds give heat and distribution', async () => {
    const r = await chart(env, 'h', { show: 'p95' }, w, { widthNs: 10 * S });
    const expected = quantileOf(
      { k: 'hist', count: 7, sum: 10, min: 0.5, max: 12, bounds: [1, 10], counts: [2, 4, 1] },
      0.95,
    );
    expect(vals(r)).toEqual([expected]);
    expect(r.series).toHaveLength(1);
    expect(r.distribution).toEqual({ bounds: [1, 10], counts: [2, 4, 1] });
    expect(r.heat?.cells).toEqual([
      [0, 0, 2],
      [0, 1, 4],
      [0, 2, 1],
    ]);
    expect(r.heat?.widthNs).toBe(10 * S);
  });

  test('count, sum and avg', async () => {
    expect(vals(await chart(env, 'h', { show: 'count' }, w, { widthNs: 10 * S }))).toEqual([7]);
    expect(vals(await chart(env, 'h', { show: 'sum' }, w, { widthNs: 10 * S }))).toEqual([10]);
    expect(vals(await chart(env, 'h', { show: 'avg' }, w, { widthNs: 10 * S }))).toEqual([10 / 7]);
  });

  test('different bounds give two lines labelled by bounds, the notes and no heatmap (Review Focus 3)', async () => {
    const r = await chart(env, 'hd', { show: 'count' }, w, { widthNs: 10 * S });
    expect(r.series.map((s) => s.label)).toEqual(['hd · bounds [1, 10]', 'hd · bounds [5]']);
    expect(new Set(r.series.map((s) => s.key)).size).toBe(2);
    expect(r.notes).toContain('histogram bounds differ');
    expect(r.notes).toContain('histogram bounds differ across series: no heatmap or distribution');
    expect(r.heat).toBeNull();
    expect(r.distribution).toBeNull();
  });

  test('exponential scales 3 and 5 merge at 3 with heat and distribution', async () => {
    const r = await chart(env, 'e', { show: 'count' }, w, { widthNs: 10 * S });
    expect(vals(r)).toEqual([4]);
    expect(r.distribution?.counts.reduce((a, b) => a + b, 0)).toBe(4);
    expect(r.heat?.cells.reduce((a, [, , c]) => a + c, 0)).toBe(4);
    const p95 = await chart(env, 'e', { show: 'p95' }, w, { widthNs: 10 * S });
    expect(vals(p95)[0]).not.toBeNull();
  });

  test('rollup re-buckets the series to 60 s; the heat cells keep the source width (#146)', async () => {
    const r = await chart(
      env,
      'hw',
      { show: 'count', fn: [{ op: 'rollup', agg: 'max', intervalMs: 60_000 }] },
      { start: 0, end: 59.9 * S },
      { widthNs: 10 * S },
    );
    expect(r.widthNs).toBe(60 * S);
    expect(times(r)).toEqual([0]);
    expect(vals(r)).toEqual([1]);
    expect(r.heat?.widthNs).toBe(10 * S);
    expect(r.heat?.cells.map((c) => c[0])).toEqual([0, 10 * S, 20 * S]);
  });
});

describe('summaries', () => {
  const sp = (k: string, c: [string, string], hi: [number, number]) =>
    pointsAt(
      sec(0, 5),
      (i) => ({ count: c[i] ?? '0', sum: 3, quantileValues: [q(0.5, 1), q(0.99, hi[i] ?? 0)] }),
      [attr('k', str(k))],
    );
  const SM = otlp(
    metricsRequest(
      [summary('s', [...sp('a', ['2', '4'], [9, 11]), ...sp('b', ['1', '3'], [5, 7])])],
      resA,
    ) as never,
  );
  let env: Env;
  beforeAll(async () => {
    env = await openEnv([SM]);
  });
  const w = { start: 0, end: 9.9 * S };

  test('q0.99 is the last point per bucket; two points in a bucket give the notes', async () => {
    const r = await chart(env, 's', { show: 'q0.99' }, w, { widthNs: 10 * S });
    expect(r.series.map((s) => [s.label, vals(r, r.series.indexOf(s))])).toEqual([
      ['k=a', [11]],
      ['k=b', [7]],
    ]);
    expect(r.notes).toContain('summary quantiles from the last point per bucket');
    expect(r.notes).toContain('summaries are not combined');
    const top = await chart(env, 's', { show: 'qmax' }, w, { widthNs: 10 * S });
    expect(top.series.map((s) => vals(top, top.series.indexOf(s)))).toEqual([[11], [7]]);
  });

  test('count is the last cumulative count and needs no coarse note', async () => {
    const r = await chart(env, 's', { show: 'count' }, w, { widthNs: 10 * S });
    expect(r.series.map((s) => vals(r, r.series.indexOf(s)))).toEqual([[4], [3]]);
    expect(r.series[0]?.unit).toBe('{count}');
    expect(r.notes).not.toContain('summary quantiles from the last point per bucket');
  });

  test('by one attribute per series: no "not combined" note; by a shared value: the note', async () => {
    const own = await chart(env, 's', { show: 'q0.5', by: ['attributes["k"]'] }, w, { widthNs: 10 * S });
    expect(own.notes).not.toContain('summaries are not combined');
    expect(own.series.map((s) => s.label)).toEqual(['a · k=a', 'b · k=b']);
    const shared = await chart(env, 's', { show: 'q0.5', by: ['resource.attributes["service.name"]'] }, w, {
      widthNs: 10 * S,
    });
    expect(shared.notes).toContain('summaries are not combined');
    expect(shared.series).toHaveLength(2);
  });
});

describe('widths, windows and exemplars', () => {
  const trace = (n: number) => `${'ab'.repeat(15)}${n.toString(16).padStart(2, '0')}`;
  const span16 = '0102030405060708';
  const ex = (ms: number, v: number, withTrace: boolean) => ({
    timeUnixNano: String(BigInt('1700000000000000000') + BigInt(ms) * 1_000_000n),
    asDouble: v,
    ...(withTrace ? { traceId: trace(v), spanId: span16 } : {}),
  });
  const W = otlp(
    metricsRequest(
      [
        gauge(
          'w',
          pointsAt(
            Array.from({ length: 360 }, (_, i) => i * 10_000),
            (i) => ({ asDouble: i }),
          ),
        ),
        gauge('x', [
          ...pointsAt(
            sec(0, 3),
            (i) => ({
              asDouble: 100,
              exemplars:
                i === 0
                  ? [
                      ex(100, 1, false),
                      ex(200, 2, false),
                      ex(300, 3, true),
                      ex(400, 4, true),
                      ex(500, 5, true),
                      ex(600, 6, false),
                      ex(500_000, 9, true),
                    ]
                  : [],
            }),
            [attr('host', str('h1'))],
          ),
          ...pointsAt(sec(0), () => ({ asDouble: 1, exemplars: [ex(100, 7, true)] }), [
            attr('host', str('h2')),
          ]),
        ]),
      ],
      resA,
    ) as never,
  );
  const P1 = otlp(
    metricsRequest(
      [
        gauge(
          'p',
          pointsAt(sec(0), () => ({ asDouble: 1 })),
        ),
      ],
      resA,
    ) as never,
  );
  const P2 = otlp(
    metricsRequest(
      [
        gauge(
          'p',
          pointsAt(sec(30), () => ({ asDouble: 2 })),
        ),
      ],
      resB,
    ) as never,
  );
  let env: Env;
  beforeAll(async () => {
    env = await openEnv([W, P1, P2]);
  });

  test('10 s points over 1 h at 600 points chart at 16.384 s', async () => {
    const r = await chart(env, 'w', { show: 'last' }, ALL, { maxPoints: 600 });
    expect(r.widthNs).toBe(16.384 * S);
    expect(times(r).every((t) => t % (16.384 * S) === 0)).toBe(true);
    expect(vals(r).every((v) => v !== null)).toBe(true);
  });

  test('widthNs re-runs at exactly that width', async () => {
    const r = await chart(env, 'w', { show: 'last' }, ALL, { widthNs: 20 * S });
    expect(r.widthNs).toBe(20 * S);
    expect(times(r).slice(0, 3)).toEqual([0, 20 * S, 40 * S]);
    expect(vals(r).slice(0, 3)).toEqual([1, 3, 5]);
  });

  test('top 1 keeps the largest group and its exemplars only; exemplars carry the key, prefer trace ids, at most 4 per bucket', async () => {
    const r = await chart(
      env,
      'x',
      { by: ['attributes["host"]'], show: 'max', fn: [{ op: 'top', n: 1, by: 'max' }] },
      { start: 0, end: 9.9 * S },
      { widthNs: 10 * S, exemplars: true },
    );
    expect(r.series.map((s) => s.label)).toEqual(['h1']);
    expect(r.exemplars).toHaveLength(4);
    expect(r.exemplars.every((e) => e.seriesKey === r.series[0]?.key)).toBe(true);
    // the three with trace ids (3, 4, 5), then the largest of the rest (6); the one at 500 s is outside the window
    expect(r.exemplars.map((e) => e.value)).toEqual([3, 4, 5, 6]);
    expect(r.exemplars.slice(0, 3).every((e) => e.traceId !== null && e.spanId === span16)).toBe(true);
    expect(r.exemplars[3]?.traceId).toBeNull();
    expect(r.exemplars.map((e) => e.time)).toEqual([300e6, 400e6, 500e6, 600e6]);
    const none = await chart(
      env,
      'x',
      { by: ['attributes["host"]'], show: 'max' },
      { start: 0, end: 9.9 * S },
      { widthNs: 10 * S },
    );
    expect(none.exemplars).toEqual([]);
  });

  test('a window spanning two partitions charts both (Review Focus 4)', async () => {
    const r = await chart(env, 'p', { show: 'last' }, { start: 0, end: 39.9 * S }, { widthNs: 10 * S });
    expect(vals(r)).toEqual([1, null, null, 2]);
    expect(times(r)).toEqual([0, 10 * S, 20 * S, 30 * S]);
  });

  test('resources narrows to one resource', async () => {
    const b = env.cat.resources.findIndex((x) => {
      const v = x.attributes.get('service.name');
      return v?.kind === 'string' && v.value === 'svc-b';
    });
    expect(b).toBeGreaterThanOrEqual(0);
    const r = await chart(
      env,
      'p',
      { show: 'last' },
      { start: 0, end: 39.9 * S },
      { widthNs: 10 * S, resources: [b] },
    );
    expect(vals(r)).toEqual([2]);
    expect(times(r)).toEqual([30 * S]);
    expect(r.series[0]?.resourceService).toBe('svc-b');
    const none = await chart(
      env,
      'p',
      { show: 'last' },
      { start: 0, end: 39.9 * S },
      { widthNs: 10 * S, resources: [] },
    );
    expect(none.series).toEqual([]);
  });
});

describe('the served refusal (D43)', () => {
  const G = otlp(
    metricsRequest(
      [
        gauge('rs', [
          ...pointsAt(sec(0), () => ({ asDouble: 1 }), [attr('k', str('abc'))]),
          ...pointsAt(sec(0), () => ({ asDouble: 2 }), [attr('k', str('ab'))]),
        ]),
      ],
      resA,
    ) as never,
  );
  const w = { start: 0, end: 9.9 * S };

  test('a residual where is refused before the probe; a translatable one resolves', async () => {
    let queries = 0;
    const env = await openEnv([G], (inner) => ({
      ...inner,
      tempTables: false,
      query: (qq, signal) => {
        queries++;
        return inner.query(qq, signal);
      },
    }));
    const before = queries;
    const refused = chart(env, 'rs', { where: 'Len(attributes["k"]) > 2' }, w, { widthNs: 10 * S });
    await expect(refused).rejects.toMatchObject({ code: 'usage' });
    await expect(refused).rejects.toThrow(
      'this served report evaluates conditions in SQL only: "Len(attributes["k"]) > 2" has no SQL form; rewrite or remove it',
    );
    expect(queries).toBe(before);
    const ok = await chart(env, 'rs', { where: 'attributes["k"] != "ab"', by: ['attributes["k"]'] }, w, {
      widthNs: 10 * S,
    });
    expect(ok.series.map((s) => s.label)).toEqual(['abc']);
  });

  test('with temp tables every call resolves as before', async () => {
    const env = await openEnv([G], (inner) => ({ ...inner, tempTables: true }));
    const r = await chart(env, 'rs', { where: 'Len(attributes["k"]) > 2' }, w, { widthNs: 10 * S });
    expect(r.series).toHaveLength(1);
  });
});

describe('the residual series cap (D5)', () => {
  test('more than 200 000 series reject with the usage message', async () => {
    const G = otlp(
      metricsRequest(
        [
          gauge(
            'rs',
            pointsAt(sec(0), () => ({ asDouble: 1 }), [attr('k', str('abc'))]),
          ),
        ],
        resA,
      ) as never,
    );
    const env = await openEnv([G], (inner) => ({
      ...inner,
      query: (qq, signal) =>
        String(qq).includes('LIMIT 200001')
          ? Promise.resolve(tableFromArrays({ series_id: Array.from({ length: 200_001 }, () => 'x') }))
          : inner.query(qq, signal),
    }));
    await expect(
      chart(
        env,
        'rs',
        { where: 'Len(attributes["k"]) > 2' },
        { start: 0, end: 9.9 * S },
        { widthNs: 10 * S },
      ),
    ).rejects.toThrow(/more than 200000 rows.*narrow the window/);
  });
});

describe('run charts', () => {
  const RUN = 'resource.attributes["cicd.pipeline.run.id"]';
  const runReq = (env: Env, over: Partial<MetricQuery> = {}, extra: Record<string, unknown> = {}) =>
    env.m.metricRunQuery({
      entry: env.entry('job.duration'),
      query: req('job.duration', { show: 'avg', by: ['attributes["job"]'], ...over }),
      window: { start: 0, end: 1000 * S },
      runBy: RUN,
      failedWhen: null,
      ...extra,
    });
  const job = (
    run: string | null,
    sha: string | null,
    jobName: string,
    at: number[],
    avgs: number[],
    result = 'success',
  ) => {
    const res = [
      attr('service.name', str('ci')),
      ...(run === null ? [] : [attr('cicd.pipeline.run.id', str(run))]),
      ...(sha === null ? [] : [attr('vcs.ref.head.revision', str(sha))]),
    ];
    return {
      res,
      points: pointsAt(
        sec(...at),
        (i) => ({ count: '1', sum: avgs[i] ?? 0, explicitBounds: [10, 100], bucketCounts: ['0', '1', '0'] }),
        [attr('job', str(jobName)), attr('result', str(result))],
      ),
    };
  };
  const reqOf = (jobs: ReturnType<typeof job>[]): OtlpRequest[] =>
    jobs.map((j) =>
      otlp(
        metricsRequest(
          [histogram('job.duration', j.points, { temporality: 'delta', unit: 's' })],
          j.res,
        ) as never,
      ),
    );
  const THREE = [
    job('r1', 'sha1', 'build', [0], [10]),
    job('r1', 'sha1', 'check', [10], [20]),
    job('r2', 'sha2', 'build', [90], [11]),
    job('r2', 'sha2', 'check', [110], [21], 'failure'),
    job('r3', 'sha3', 'build', [190], [12]),
    job('r3', 'sha3', 'check', [210], [22]),
  ];
  let env: Env;
  beforeAll(async () => {
    env = await openEnv(reqOf(THREE));
  });

  test('one value per line per run; the run time is its latest point; revision', async () => {
    const r = await runReq(env);
    expect(r.runs.map((x) => [x.id, x.revision, x.time])).toEqual([
      ['r1', 'sha1', 10 * S],
      ['r2', 'sha2', 110 * S],
      ['r3', 'sha3', 210 * S],
    ]);
    expect(r.lines.map((l) => [l.label, l.points.map((p) => p?.value)])).toEqual([
      ['build', [10, 11, 12]],
      ['check', [20, 21, 22]],
    ]);
    expect(r.lines[0]?.unit).toBe('s');
    expect(r.queryId).toBe('a');
    expect(r.leftOut).toBe(0);
  });

  test('failedWhen marks a point', async () => {
    const r = await runReq(env, {}, { failedWhen: 'attributes["result"] == "failure"' });
    expect(r.lines.map((l) => l.points.map((p) => p?.failed))).toEqual([
      [false, false, false],
      [false, true, false],
    ]);
  });

  test('a run outside the window is dropped; the window echoes', async () => {
    const window = { start: 0, end: 125 * S };
    const r = await runReq(env, {}, { window });
    expect(r.runs.map((x) => x.id)).toEqual(['r1', 'r2']);
    expect(r.lines[0]?.points).toHaveLength(2);
    expect(r.window).toBe(window);
  });

  test("a run whose time is in the window keeps its points before the window's start", async () => {
    const r = await runReq(env, {}, { window: { start: 10 * S, end: 10 * S } });
    expect(r.runs.map((x) => x.id)).toEqual(['r1']);
    expect(r.lines.map((l) => l.points[0]?.value)).toEqual([10, 20]);
  });

  test('counter lines: rate, increase and sum per run, and a reset inside a run gives the note', async () => {
    const cnt = (run: string, at: number[], vs: number[]) =>
      otlp(
        metricsRequest(
          [
            sum(
              'cnt',
              pointsAt(sec(...at), (i) => ({ asDouble: vs[i] ?? 0 })),
              {
                monotonic: true,
                temporality: 'cumulative',
              },
            ),
          ],
          [attr('service.name', str('ci')), attr('cicd.pipeline.run.id', str(run))],
        ) as never,
      );
    const e3 = await openEnv([
      cnt('r1', [0, 10], [10, 30]),
      cnt('r2', [90, 110], [5, 55]),
      cnt('r3', [190, 200, 210], [100, 40, 70]),
    ]);
    const go = (show: string) =>
      e3.m.metricRunQuery({
        entry: e3.entry('cnt'),
        query: req('cnt', { show }),
        window: { start: 0, end: 1000 * S },
        runBy: RUN,
        failedWhen: null,
      });
    // r1: deltas 0 + 20 = 20 over 10 s; r2: 0 + 50 over 110 s; r3: 0 + 40 (reset, its own value) + 30 = 70 over 210 s
    const inc = await go('increase');
    expect(inc.lines.map((l) => l.points.map((p) => p?.value))).toEqual([[20, 50, 70]]);
    expect(inc.notes).toContain('1 counter reset in range');
    expect((await go('sum')).lines[0]?.points.map((p) => p?.value)).toEqual([20, 50, 70]);
    const rate = (await go('rate')).lines[0];
    expect(rate?.unit).toBe('1/s');
    expect(rate?.points.map((p) => p?.value)).toEqual([2, 50 / 110, 70 / 210]);
  });

  test('where narrows the series', async () => {
    const r = await runReq(env, { where: 'attributes["job"] == "check"' });
    expect(r.lines.map((l) => l.label)).toEqual(['check']);
  });

  test('a re-run combines, runs are ordered by time then id, a missing line is null, and a run-less series is left out', async () => {
    const e2 = await openEnv(
      reqOf([
        job('c', null, 'build', [0], [3]),
        job('c', null, 'check', [0], [30]),
        job('b', null, 'build', [50], [1]),
        job('a', null, 'build', [50], [2]),
        job('a', null, 'build', [40], [4]),
        job(null, null, 'build', [60], [99]),
      ]),
    );
    const r = await runReq(e2);
    expect(r.runs.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    // run a: points 2 and 4 combine
    expect(r.lines.map((l) => [l.label, l.points.map((p) => p?.value ?? null)])).toEqual([
      ['build', [3, 3, 1]],
      ['check', [30, null, null]],
    ]);
    expect(r.leftOut).toBe(1);
    expect(r.notes).toContain(`1 series has no value for ${RUN} and is left out`);
  });
});

describe('@perf the chart query', () => {
  // 1 000 series x 360 points in one partition. Median of 7 runs on the development machine: see the comment on the budget.
  test('@perf 1,000 series x 360 points, a by query', async () => {
    const dataPoints = Array.from({ length: 1000 }, (_, s) =>
      pointsAt(
        Array.from({ length: 360 }, (_, i) => i * 10_000),
        (i) => ({ asDouble: s + i }),
        [attr('series', str(`s${s}`)), attr('host', str(`h${s % 50}`))],
      ),
    ).flat();
    const env = await openEnv([otlp(metricsRequest([gauge('big', dataPoints)], resA) as never)]);
    // The coordinator caches by SQL text: each run moves the window's end by 17 s (cells read whole buckets, so a smaller step repeats the SQL) so none is a cache hit.
    let n = 0;
    const run = () =>
      chart(
        env,
        'big',
        { by: ['attributes["host"]'], show: 'avg' },
        { start: 0, end: ALL.end - ++n * 17 * S },
        {
          maxPoints: 600,
        },
      );
    const { result, ms } = await medianMsAsync(run);
    expect(result.series).toHaveLength(50);
    expect(result.widthNs).toBe(16.384 * S);
    // Median of 7 uncached runs on the development machine (Intel Core Ultra 7 265K, factor 1.00), over three
    // invocations: 231.4, 229.7 and 229.7 ms. The budget is twice the median.
    expect(ms).toBeLessThan(460 * perfFactor());
  }, 300_000);
});

describe('branch-review fixes', () => {
  test('a counter running total keeps the chart width: sum and increase agree when most series end before the window', async () => {
    const dead = Array.from({ length: 400 }, (_, i) =>
      pointsAt(sec(0, 10, 20, 30, 40, 50), (j) => ({ asDouble: j }), [attr('id', str(`d${i}`))]),
    ).flat();
    const long = pointsAt(
      Array.from({ length: 21 }, (_, i) => i * 10_000),
      (i) => ({ asDouble: i }),
      [attr('id', str('long'))],
    );
    const e = await openEnv([
      otlp(
        metricsRequest(
          [sum('many', [...dead, ...long], { monotonic: true, temporality: 'cumulative' })],
          resA,
        ) as never,
      ),
    ]);
    const w = { start: 100 * S, end: 200 * S };
    const a = await chart(e, 'many', { show: 'sum' }, w);
    const b = await chart(e, 'many', { show: 'increase' }, w);
    expect(a.widthNs).toBe(b.widthNs);
    // the points' interval is 10 s, wider than the 1 ms pick
    expect(a.widthNs).toBeGreaterThanOrEqual(10 * S);
    expect(vals(a).every((v) => v !== null)).toBe(true);
  });

  test('a query reads only the partitions that hold the metric', async () => {
    const A = otlp(
      metricsRequest(
        [
          gauge(
            'only1',
            pointsAt(sec(0, 5), () => ({ asDouble: 1 })),
          ),
        ],
        resA,
      ) as never,
    );
    const B = otlp(
      metricsRequest(
        [
          gauge(
            'other',
            pointsAt(sec(10), () => ({ asDouble: 1 })),
          ),
        ],
        resA,
      ) as never,
    );
    const issued: string[] = [];
    const e = await openEnv([A, B], (inner) => ({
      ...inner,
      query: (qq, signal) => {
        issued.push(String(qq));
        return inner.query(qq, signal);
      },
    }));
    const [p0, p1] = e.f.manifest.partitions.map((p) => p.files.points?.path ?? '');
    expect(p0).not.toBe('');
    await chart(e, 'only1', { show: 'avg' }, { start: 0, end: 20 * S }, { exemplars: true });
    const mine = issued.filter((sql) => sql.includes("'only1'"));
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const sql of mine) {
      expect(sql).toContain(p0);
      expect(sql).not.toContain(p1);
    }
  });

  test('a residual where sees the description of the series row', () => {
    const entry = {
      name: 'm',
      description: 'from the catalog',
      unit: '1',
      type: 'gauge',
      temporality: 'unspecified',
      monotonic: false,
    } as never;
    const row = {
      seriesId: 'x',
      description: 'from the row',
      attributes: new Map(),
      resource: { attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' },
      scope: { name: '', version: '', attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' },
      bounds: null,
      groups: [],
    };
    expect(seriesTarget(entry, row).point.description).toBe('from the row');
  });

  test('catalog attribute keys come from the JSON keys, including the {"$m"} form', () => {
    const def = {
      metric_name: ['m'],
      point_type: ['gauge'],
      metric_unit: ['1'],
      aggregation_temporality: [0],
      is_monotonic: [false],
    };
    const defs = tableFromArrays({
      ...def,
      description: [''],
      points: [2n],
      series: [2n],
      resets: [0n],
      out_of_order: [0n],
      no_value: [0n],
      scopes: [['s']],
    });
    const ids = tableFromArrays({
      metric_name: ['m', 'm'],
      point_type: ['gauge', 'gauge'],
      metric_unit: ['1', '1'],
      aggregation_temporality: [0, 0],
      is_monotonic: [false, false],
      attributes: ['{"a":"1","b":{"$i":"9"}}', '{"$m":[["$k","1"],["z",{"$d":"2"}]]}'],
      resource_attributes: ['{}', '{}'],
      resource_schema_url: ['', ''],
      resource_dropped_attributes_count: [0n, 0n],
      scope_name: ['s', 's'],
      scope_version: ['', ''],
      scope_attributes: ['{}', '{}'],
      scope_schema_url: ['', ''],
      scope_dropped_attributes_count: [0n, 0n],
    });
    const spark = tableFromArrays({ ...def, bucket: [0n], sum: [1], n: [1n] });
    const cat = catalogFrom(defs, ids, spark, { widthNs: 1e6, startNs: 0, endNs: 0 });
    expect(cat.entries[0]?.attributeKeys).toEqual(['$k', 'a', 'b', 'z']);
  });

  describe('notes and empty values on the chart path', () => {
    const X = otlp(
      metricsRequest(
        [
          sum(
            'dup',
            pointsAt(sec(0), () => ({ asDouble: 1 })),
            { monotonic: false, temporality: 'cumulative' },
          ),
          sum(
            'dup',
            pointsAt(sec(0), () => ({ asDouble: 1 })),
            {
              monotonic: false,
              temporality: 'cumulative',
              unit: 'ms',
            },
          ),
          gauge(
            'holes',
            pointsAt(sec(0, 5), (i) => (i === 0 ? {} : { asDouble: 2 })),
          ),
          gauge(
            'nul',
            pointsAt(sec(0), () => ({})),
          ),
        ],
        resA,
      ) as never,
    );
    let e: Env;
    beforeAll(async () => {
      e = await openEnv([X]);
    });
    const w = { start: 0, end: 9.9 * S };

    test('conflicting definitions give the note', async () => {
      const r = await chart(e, 'dup', { show: 'avg' }, w, { widthNs: 10 * S });
      expect(r.notes.some((n) => n.startsWith('dup has conflicting definitions'))).toBe(true);
    });

    test('points without a value give the note and are left out of the values', async () => {
      const r = await chart(e, 'holes', { show: 'avg' }, w, { widthNs: 10 * S });
      expect(r.notes).toContain('1 point had no value');
      expect(vals(r)).toEqual([2]);
    });

    test('a series whose points all lack a value charts as gaps', async () => {
      const r = await chart(e, 'nul', { show: 'avg' }, w, { widthNs: 10 * S });
      expect(r.series).toHaveLength(1);
      expect(vals(r).every((v) => v === null)).toBe(true);
    });
  });
});

describe('the statements sent for series scopes (characterization)', () => {
  const RUN = 'resource.attributes["cicd.pipeline.run.id"]';
  const G = otlp(
    metricsRequest(
      [
        gauge('rs', [
          ...pointsAt(sec(0), () => ({ asDouble: 1 }), [attr('k', str('abc'))]),
          ...pointsAt(sec(0), () => ({ asDouble: 2 }), [attr('k', str('ab'))]),
        ]),
      ],
      resA,
    ) as never,
  );
  const job = (run: string, at: number, result: string) =>
    otlp(
      metricsRequest(
        [
          histogram(
            'job.duration',
            pointsAt(
              sec(at),
              () => ({ count: '1', sum: 10, explicitBounds: [10, 100], bucketCounts: ['0', '1', '0'] }),
              [attr('job', str('build')), attr('result', str(result))],
            ),
            { temporality: 'delta', unit: 's' },
          ),
        ],
        [attr('service.name', str('ci')), attr('cicd.pipeline.run.id', str(run))],
      ) as never,
    );

  /** The statements the engine ran during `fn`, the temp table's counter masked. */
  async function sent(
    requests: readonly OtlpRequest[],
    fn: (env: Env) => Promise<unknown>,
  ): Promise<{ queries: string[]; execs: string[] }> {
    const queries: string[] = [];
    const env = await openEnv(requests, (inner) => ({
      ...inner,
      query: (qq, signal) => {
        queries.push(String(qq));
        return inner.query(qq, signal);
      },
    }));
    const before = env.db.connector.requests.length;
    queries.length = 0;
    await fn(env);
    const mask = (s: string): string => s.replace(/otel_residual_\d+/g, 'otel_residual_N');
    return {
      queries: queries.map(mask),
      execs: env.db.connector.requests
        .slice(before)
        .filter((r) => r.type === 'exec')
        .map((r) => mask(r.sql)),
    };
  }

  test('a residual where reads its series ids from the id table; the services of the series follow', async () => {
    const r = await sent([G], (env) =>
      chart(
        env,
        'rs',
        { where: 'Len(attributes["k"]) > 2', by: ['attributes["k"]'] },
        { start: 0, end: 9.9 * S },
        {
          widthNs: 10 * S,
        },
      ),
    );
    expect(r.execs.find((s) => s.startsWith('CREATE TEMP TABLE'))).toMatchInlineSnapshot(
      `"CREATE TEMP TABLE otel_residual_N AS SELECT * FROM read_csv('otel_residual_N.csv', header = true, columns = {'series_id': 'VARCHAR'})"`,
    );
    expect(r.queries.find((s) => s.includes('list(DISTINCT CASE WHEN json_type'))).toMatchInlineSnapshot(
      `"SELECT g0 AS "g0", list(DISTINCT CASE WHEN json_type(resource_attributes, '/service.name') = 'VARCHAR' THEN json_extract_string(resource_attributes, '/service.name') END) AS "services" FROM (SELECT series_id AS "series_id", any_value(metric_name) AS "metric_name", any_value(point_type) AS "point_type", any_value(metric_unit) AS "metric_unit", any_value(aggregation_temporality) AS "aggregation_temporality", any_value(is_monotonic) AS "is_monotonic", any_value(attributes) AS "attributes", any_value(resource_attributes) AS "resource_attributes", any_value(resource_schema_url) AS "resource_schema_url", any_value(resource_dropped_attributes_count) AS "resource_dropped_attributes_count", any_value(scope_name) AS "scope_name", any_value(scope_version) AS "scope_version", any_value(scope_attributes) AS "scope_attributes", any_value(scope_schema_url) AS "scope_schema_url", any_value(scope_dropped_attributes_count) AS "scope_dropped_attributes_count", any_value(explicit_bounds) AS "explicit_bounds", any_value(metric_description) AS "metric_description", any_value(CAST(list_extract(list_transform([CAST("attributes" AS JSON)], (b0) -> coalesce(json_extract(b0, '/k'), list_extract(list_transform(list_filter(from_json(json_extract(b0, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = 'k'), (x) -> json_extract(x, '/1')), 1))), 1) AS VARCHAR)) AS "g0" FROM "points" WHERE ((metric_name = 'rs') AND (point_type = 'gauge') AND metric_unit IS NOT DISTINCT FROM '1' AND aggregation_temporality IS NOT DISTINCT FROM 0 AND is_monotonic IS NOT DISTINCT FROM FALSE AND (("time_unix_nano" >= 1700000000000000000::BIGINT) AND ("time_unix_nano" <= 1700000009999999999::BIGINT)) AND series_id IN (SELECT "series_id" FROM "otel_residual_N")) GROUP BY series_id) AS "s" GROUP BY g0"`,
    );
  });

  test('failedWhen runs the cells again over the ids of the query series', async () => {
    const r = await sent([job('r1', 0, 'success'), job('r2', 10, 'failure')], (env) =>
      env.m.metricRunQuery({
        entry: env.entry('job.duration'),
        query: req('job.duration', { show: 'avg', by: ['attributes["job"]'] }),
        window: { start: 0, end: 1000 * S },
        runBy: RUN,
        failedWhen: 'attributes["result"] == "failure"',
      }),
    );
    const failed = r.queries.filter((s) =>
      s.includes('(SELECT series_id AS "series_id" FROM (SELECT series_id AS "series_id", any_value('),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchInlineSnapshot(
      `"SELECT g0 AS "g0", cell AS "cell", bounds AS "bounds", sum(dc) AS "count", sum(sm) AS "sum", min(mn) AS "min", max(mx) AS "max", coalesce(list(cnt ORDER BY idx) FILTER (WHERE side = 'e'), []) AS "counts" FROM (SELECT g0 AS "g0", cell AS "cell", bounds AS "bounds", side AS "side", idx AS "idx", sum(cnt) AS "cnt", sum(dc) AS "dc", sum(sm) AS "sm", min(mn) AS "mn", max(mx) AS "mx" FROM (SELECT g0 AS "g0", cell AS "cell", bounds AS "bounds", 'e' AS "side", CAST(e.idx AS INTEGER) AS "idx", CAST(e.cnt AS BIGINT) AS "cnt", CAST(NULL AS BIGINT) AS "dc", CAST(NULL AS DOUBLE) AS "sm", CAST(NULL AS DOUBLE) AS "mn", CAST(NULL AS DOUBLE) AS "mx" FROM (SELECT g0 AS "g0", cell AS "cell", bounds AS "bounds", unnest(list_transform(range(len(dbc)), j -> struct_pack(idx := j, cnt := dbc[j + 1]))) AS "e" FROM (SELECT g0 AS "g0", cell AS "cell", bounds AS "bounds", delta_count AS "delta_count", delta_value AS "delta_value", min AS "min", max AS "max", dbc AS "dbc" FROM (SELECT g0 AS "g0", CAST(list_extract(list_transform([CAST("resource_attributes" AS JSON)], (b0) -> coalesce(json_extract(b0, '/cicd.pipeline.run.id'), list_extract(list_transform(list_filter(from_json(json_extract(b0, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = 'cicd.pipeline.run.id'), (x) -> json_extract(x, '/1')), 1))), 1) AS VARCHAR) AS "cell", sid AS "sid", delta_count AS "delta_count", delta_value AS "delta_value", min AS "min", max AS "max", explicit_bounds AS "bounds", coalesce(delta_bucket_counts, [delta_count]) AS "dbc" FROM "points", (SELECT series_id AS "sid", any_value(g0) AS "g0" FROM (SELECT series_id AS "series_id", any_value(metric_name) AS "metric_name", any_value(point_type) AS "point_type", any_value(metric_unit) AS "metric_unit", any_value(aggregation_temporality) AS "aggregation_temporality", any_value(is_monotonic) AS "is_monotonic", any_value(attributes) AS "attributes", any_value(resource_attributes) AS "resource_attributes", any_value(resource_schema_url) AS "resource_schema_url", any_value(resource_dropped_attributes_count) AS "resource_dropped_attributes_count", any_value(scope_name) AS "scope_name", any_value(scope_version) AS "scope_version", any_value(scope_attributes) AS "scope_attributes", any_value(scope_schema_url) AS "scope_schema_url", any_value(scope_dropped_attributes_count) AS "scope_dropped_attributes_count", any_value(explicit_bounds) AS "explicit_bounds", any_value(metric_description) AS "metric_description", any_value(CAST(list_extract(list_transform([CAST("attributes" AS JSON)], (b0) -> coalesce(json_extract(b0, '/job'), list_extract(list_transform(list_filter(from_json(json_extract(b0, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = 'job'), (x) -> json_extract(x, '/1')), 1))), 1) AS VARCHAR)) AS "g0" FROM "points" WHERE ((metric_name = 'job.duration') AND (point_type = 'histogram') AND metric_unit IS NOT DISTINCT FROM 's' AND aggregation_temporality IS NOT DISTINCT FROM 1 AND is_monotonic IS NOT DISTINCT FROM FALSE AND coalesce(list_extract(list_transform([list_extract(list_transform([CAST("attributes" AS JSON)], (b0) -> coalesce(json_extract(b0, '/result'), list_extract(list_transform(list_filter(from_json(json_extract(b0, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = 'result'), (x) -> json_extract(x, '/1')), 1))), 1)], (v) -> ((json_type(v) = 'VARCHAR') AND (json_extract_string(v, '$') = 'failure'))), 1), FALSE) AND series_id IN (SELECT series_id AS "series_id" FROM (SELECT series_id AS "series_id", any_value(metric_name) AS "metric_name", any_value(point_type) AS "point_type", any_value(metric_unit) AS "metric_unit", any_value(aggregation_temporality) AS "aggregation_temporality", any_value(is_monotonic) AS "is_monotonic", any_value(attributes) AS "attributes", any_value(resource_attributes) AS "resource_attributes", any_value(resource_schema_url) AS "resource_schema_url", any_value(resource_dropped_attributes_count) AS "resource_dropped_attributes_count", any_value(scope_name) AS "scope_name", any_value(scope_version) AS "scope_version", any_value(scope_attributes) AS "scope_attributes", any_value(scope_schema_url) AS "scope_schema_url", any_value(scope_dropped_attributes_count) AS "scope_dropped_attributes_count", any_value(explicit_bounds) AS "explicit_bounds", any_value(metric_description) AS "metric_description", any_value(CAST(list_extract(list_transform([CAST("attributes" AS JSON)], (b0) -> coalesce(json_extract(b0, '/job'), list_extract(list_transform(list_filter(from_json(json_extract(b0, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = 'job'), (x) -> json_extract(x, '/1')), 1))), 1) AS VARCHAR)) AS "g0" FROM "points" WHERE ((metric_name = 'job.duration') AND (point_type = 'histogram') AND metric_unit IS NOT DISTINCT FROM 's' AND aggregation_temporality IS NOT DISTINCT FROM 1 AND is_monotonic IS NOT DISTINCT FROM FALSE) GROUP BY series_id) AS "s")) GROUP BY series_id) AS "k" GROUP BY series_id) AS "s" WHERE (series_id = sid AND (metric_name = 'job.duration') AND (point_type = 'histogram') AND metric_unit IS NOT DISTINCT FROM 's' AND aggregation_temporality IS NOT DISTINCT FROM 1 AND is_monotonic IS NOT DISTINCT FROM FALSE)) AS "p" WHERE delta_count IS NOT NULL) AS "r") AS "u" UNION ALL SELECT g0 AS "g0", cell AS "cell", bounds AS "bounds", 'x' AS "side", CAST(NULL AS INTEGER) AS "idx", CAST(NULL AS BIGINT) AS "cnt", delta_count AS "dc", delta_value AS "sm", min AS "mn", max AS "mx" FROM (SELECT g0 AS "g0", cell AS "cell", bounds AS "bounds", delta_count AS "delta_count", delta_value AS "delta_value", min AS "min", max AS "max", dbc AS "dbc" FROM (SELECT g0 AS "g0", CAST(list_extract(list_transform([CAST("resource_attributes" AS JSON)], (b0) -> coalesce(json_extract(b0, '/cicd.pipeline.run.id'), list_extract(list_transform(list_filter(from_json(json_extract(b0, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = 'cicd.pipeline.run.id'), (x) -> json_extract(x, '/1')), 1))), 1) AS VARCHAR) AS "cell", sid AS "sid", delta_count AS "delta_count", delta_value AS "delta_value", min AS "min", max AS "max", explicit_bounds AS "bounds", coalesce(delta_bucket_counts, [delta_count]) AS "dbc" FROM "points", (SELECT series_id AS "sid", any_value(g0) AS "g0" FROM (SELECT series_id AS "series_id", any_value(metric_name) AS "metric_name", any_value(point_type) AS "point_type", any_value(metric_unit) AS "metric_unit", any_value(aggregation_temporality) AS "aggregation_temporality", any_value(is_monotonic) AS "is_monotonic", any_value(attributes) AS "attributes", any_value(resource_attributes) AS "resource_attributes", any_value(resource_schema_url) AS "resource_schema_url", any_value(resource_dropped_attributes_count) AS "resource_dropped_attributes_count", any_value(scope_name) AS "scope_name", any_value(scope_version) AS "scope_version", any_value(scope_attributes) AS "scope_attributes", any_value(scope_schema_url) AS "scope_schema_url", any_value(scope_dropped_attributes_count) AS "scope_dropped_attributes_count", any_value(explicit_bounds) AS "explicit_bounds", any_value(metric_description) AS "metric_description", any_value(CAST(list_extract(list_transform([CAST("attributes" AS JSON)], (b0) -> coalesce(json_extract(b0, '/job'), list_extract(list_transform(list_filter(from_json(json_extract(b0, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = 'job'), (x) -> json_extract(x, '/1')), 1))), 1) AS VARCHAR)) AS "g0" FROM "points" WHERE ((metric_name = 'job.duration') AND (point_type = 'histogram') AND metric_unit IS NOT DISTINCT FROM 's' AND aggregation_temporality IS NOT DISTINCT FROM 1 AND is_monotonic IS NOT DISTINCT FROM FALSE AND coalesce(list_extract(list_transform([list_extract(list_transform([CAST("attributes" AS JSON)], (b0) -> coalesce(json_extract(b0, '/result'), list_extract(list_transform(list_filter(from_json(json_extract(b0, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = 'result'), (x) -> json_extract(x, '/1')), 1))), 1)], (v) -> ((json_type(v) = 'VARCHAR') AND (json_extract_string(v, '$') = 'failure'))), 1), FALSE) AND series_id IN (SELECT series_id AS "series_id" FROM (SELECT series_id AS "series_id", any_value(metric_name) AS "metric_name", any_value(point_type) AS "point_type", any_value(metric_unit) AS "metric_unit", any_value(aggregation_temporality) AS "aggregation_temporality", any_value(is_monotonic) AS "is_monotonic", any_value(attributes) AS "attributes", any_value(resource_attributes) AS "resource_attributes", any_value(resource_schema_url) AS "resource_schema_url", any_value(resource_dropped_attributes_count) AS "resource_dropped_attributes_count", any_value(scope_name) AS "scope_name", any_value(scope_version) AS "scope_version", any_value(scope_attributes) AS "scope_attributes", any_value(scope_schema_url) AS "scope_schema_url", any_value(scope_dropped_attributes_count) AS "scope_dropped_attributes_count", any_value(explicit_bounds) AS "explicit_bounds", any_value(metric_description) AS "metric_description", any_value(CAST(list_extract(list_transform([CAST("attributes" AS JSON)], (b0) -> coalesce(json_extract(b0, '/job'), list_extract(list_transform(list_filter(from_json(json_extract(b0, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = 'job'), (x) -> json_extract(x, '/1')), 1))), 1) AS VARCHAR)) AS "g0" FROM "points" WHERE ((metric_name = 'job.duration') AND (point_type = 'histogram') AND metric_unit IS NOT DISTINCT FROM 's' AND aggregation_temporality IS NOT DISTINCT FROM 1 AND is_monotonic IS NOT DISTINCT FROM FALSE) GROUP BY series_id) AS "s")) GROUP BY series_id) AS "k" GROUP BY series_id) AS "s" WHERE (series_id = sid AND (metric_name = 'job.duration') AND (point_type = 'histogram') AND metric_unit IS NOT DISTINCT FROM 's' AND aggregation_temporality IS NOT DISTINCT FROM 1 AND is_monotonic IS NOT DISTINCT FROM FALSE)) AS "p" WHERE delta_count IS NOT NULL) AS "r") AS "e" GROUP BY g0, cell, bounds, side, idx) AS "m" GROUP BY g0, cell, bounds ORDER BY g0, cell, bounds"`,
    );
  });
});
