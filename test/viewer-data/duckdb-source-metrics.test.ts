import { beforeAll, describe, expect, test } from 'vitest';
import { metricMethods } from '../../src/viewer/data/duckdb-metrics.js';
import type { MetricEntry } from '../../src/viewer/data/metric-catalog.js';
import type { MetricMethods } from '../../src/viewer/data/metric-results.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';
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
