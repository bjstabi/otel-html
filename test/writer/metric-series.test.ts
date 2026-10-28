import { describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import {
  LEVEL0_WIDTH_NS,
  type LevelFile,
  metricExemplarKey,
  metricLevelKey,
  metricSegmentKey,
  parseExemplarFile,
  parseLevelFile,
  parseSegmentFile,
  type SegmentFile,
  type StoredExemplar,
} from '../../src/format/metric-files.js';
import type { RelNanos } from '../../src/model/ids.js';
import type {
  MetricPointRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
} from '../../src/model/records.js';
import type { BucketAgg } from '../../src/rollups/metric-agg.js';
import { MetricCatalog } from '../../src/rollups/metric-catalog.js';
import { MetricSeriesWriter } from '../../src/writer/metric-series-writer.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

const OUT = 'r';
const S = 1_000_000_000;
const rel = (n: number): RelNanos => n as RelNanos;
const counter = (delta: number): BucketAgg => ({ k: 'counter', delta, resets: 0 });
const resource: ResourceRecord = { attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' };
const scope: ScopeRecord = {
  name: 'lib',
  version: '',
  attributes: new Map(),
  droppedAttributesCount: 0,
  schemaUrl: '',
};

function pt(name: string, host: string): MetricPointRecord {
  return {
    name,
    description: '',
    unit: '1',
    type: 'sum',
    temporality: 'delta',
    monotonic: true,
    start: null,
    time: rel(0),
    attributes: new Map([['host', { kind: 'string', value: host }]]),
    flags: 0,
    point: { asInt: '1' },
    resource: 0 as ResourceRef,
    scope: 0 as ScopeRef,
  };
}

function setup(
  fs = createMemoryFileSystem(),
  listed: readonly string[] = [],
  next = new Map<number, number>(),
) {
  const catalog = new MetricCatalog({ seriesCap: 10 });
  const writer = new MetricSeriesWriter(fs, OUT, { exemplars: 2 }, next, listed);
  const series = (name: string, host: string) => {
    const p = pt(name, host);
    const def = catalog.defOf(p);
    return { def, series: catalog.seriesOf(def, p, resource, scope) };
  };
  return { fs, catalog, writer, series };
}

function read<T>(
  fs: ReturnType<typeof createMemoryFileSystem>,
  key: string,
  parse: (x: unknown, p: string) => T,
): T {
  const text = fs.snapshot().get(`${OUT}/data/${key}.js`);
  if (text === undefined) throw new Error(`missing ${key}`);
  return parse(reviveDataJson(unwrapDataFile(text, key)), key);
}

const ex = (series: number, time: number, value: number, traced = false): StoredExemplar => ({
  series,
  time,
  value,
  traceId: traced ? '5b8efff798038103d269b633813fc60c' : null,
  spanId: null,
  attributes: new Map(),
});

describe('MetricSeriesWriter', () => {
  test('flush writes series.js for new series and one level-0 segment per metric', async () => {
    const { fs, catalog, writer, series } = setup();
    const a = series('a', 'h1');
    const b = series('b', 'h1');
    writer.add(a.def, a.series, rel(0), counter(1), []);
    writer.add(a.def, a.series, rel(0.5 * S), counter(2), []); // same 1.024 s bucket
    writer.add(a.def, a.series, rel(3 * S), counter(4), []);
    writer.add(b.def, b.series, rel(1 * S), counter(8), []);
    const paths = await writer.flush(catalog);
    expect(paths.sort()).toEqual([
      'data/metrics/000000/seg-000000.js',
      'data/metrics/000000/series.js',
      'data/metrics/000001/seg-000000.js',
      'data/metrics/000001/series.js',
    ]);
    const seg = read<SegmentFile>(fs, metricSegmentKey(0, 0), parseSegmentFile);
    expect(seg).toEqual({
      metric: 0,
      widthNs: LEVEL0_WIDTH_NS,
      series: [{ id: 0, t: [0, 2], a: [counter(3), counter(4)] }],
      exemplars: [],
    });
    // Nothing new: nothing written
    expect(await writer.flush(catalog)).toEqual([]);
    writer.add(a.def, a.series, rel(5 * S), counter(1), []);
    expect(await writer.flush(catalog)).toEqual(['data/metrics/000000/seg-000001.js']);
    expect(writer.listed()).toContain('data/metrics/000000/seg-000001.js');
  });

  test('keeps at most `exemplars` per series per 65.536 s bucket, preferring traced ones', async () => {
    const { fs, catalog, writer, series } = setup();
    const a = series('a', 'h1');
    writer.add(a.def, a.series, rel(0), counter(1), [ex(0, 1, 5), ex(0, 2, 1), ex(0, 3, 9, true)]);
    writer.add(a.def, a.series, rel(70 * S), counter(1), [ex(0, 70 * S, 3)]);
    await writer.flush(catalog);
    const seg = read<SegmentFile>(fs, metricSegmentKey(0, 0), parseSegmentFile);
    expect(seg.exemplars.map((e) => e.value)).toEqual([5, 9, 3]);
  });

  test('compact merges segments into levels and ex.js, and prune drops the segments', async () => {
    const { fs, catalog, writer, series } = setup();
    const a = series('a', 'h1');
    writer.add(a.def, a.series, rel(0), counter(1), [ex(0, 0, 1)]);
    await writer.flush(catalog);
    writer.add(a.def, a.series, rel(0.2 * S), counter(2), []);
    writer.add(a.def, a.series, rel(2100 * S), counter(3), [ex(0, 2100 * S, 3)]);
    await writer.flush(catalog);
    const listed = await writer.compact(catalog);
    expect(listed).toEqual([
      'data/metrics/000000/ex.js',
      'data/metrics/000000/l0.js',
      'data/metrics/000000/l1.js',
      'data/metrics/000000/series.js',
    ]);
    const l0 = read<LevelFile>(fs, metricLevelKey(0, 0), parseLevelFile);
    expect(l0.series).toEqual([{ id: 0, t: [0, 2050], a: [counter(3), counter(3)] }]);
    const l1 = read<LevelFile>(fs, metricLevelKey(0, 1), parseLevelFile);
    expect(l1).toMatchObject({ level: 1, widthNs: LEVEL0_WIDTH_NS * 8 });
    expect(l1.series).toEqual([{ id: 0, t: [0, 256], a: [counter(3), counter(3)] }]);
    const exf = read(fs, metricExemplarKey(0), parseExemplarFile);
    expect(exf.exemplars.map((e) => e.value)).toEqual([1, 3]);
    expect(fs.snapshot().has('r/data/metrics/000000/seg-000000.js')).toBe(true);
    await writer.prune();
    const left = [...fs.snapshot().keys()].filter((k) => k.startsWith('r/data/metrics/')).sort();
    expect(left).toEqual(listed.map((p) => `r/${p}`));
  });

  test('a writer reopened on compacted files demotes them to a segment at its first flush', async () => {
    const first = setup();
    const a = first.series('a', 'h1');
    first.writer.add(a.def, a.series, rel(0), counter(1), [ex(0, 0, 1)]);
    await first.writer.flush(first.catalog);
    const listed = await first.writer.compact(first.catalog);
    await first.writer.prune();

    const next = new Map([[0, 1]]);
    const writer = new MetricSeriesWriter(first.fs, OUT, { exemplars: 2 }, next, listed);
    writer.add(a.def, a.series, rel(1.5 * S), counter(5), []);
    const paths = await writer.flush(first.catalog);
    expect(paths.sort()).toEqual(['data/metrics/000000/seg-000001.js', 'data/metrics/000000/seg-000002.js']);
    expect(writer.listed()).toEqual([
      'data/metrics/000000/seg-000001.js',
      'data/metrics/000000/seg-000002.js',
      'data/metrics/000000/series.js',
    ]);
    const demoted = read<SegmentFile>(first.fs, metricSegmentKey(0, 1), parseSegmentFile);
    expect(demoted.series).toEqual([{ id: 0, t: [0], a: [counter(1)] }]);
    expect(demoted.exemplars.map((e) => e.value)).toEqual([1]);
    await writer.compact(first.catalog);
    const l0 = read<LevelFile>(first.fs, metricLevelKey(0, 0), parseLevelFile);
    expect(l0.series).toEqual([{ id: 0, t: [0, 1], a: [counter(1), counter(5)] }]);
  });

  test('buffers spill to segments once the bucket budget is reached', async () => {
    const fs = createMemoryFileSystem();
    const catalog = new MetricCatalog({ seriesCap: 10 });
    const writer = new MetricSeriesWriter(fs, OUT, { exemplars: 2, maxBufferedBuckets: 3 }, new Map(), []);
    const p = pt('a', 'h');
    const def = catalog.defOf(p);
    const series = catalog.seriesOf(def, p, resource, scope);
    writer.add(def, series, rel(0), counter(1), []);
    writer.add(def, series, rel(2 * S), counter(1), []);
    expect(writer.full()).toBe(false);
    writer.add(def, series, rel(4 * S), counter(1), []);
    expect(writer.full()).toBe(true);
    await writer.flush(catalog);
    expect(writer.full()).toBe(false);
  });

  test('spill writes the largest buffers first, down to half the budget', async () => {
    const { fs, catalog, series } = setup();
    const writer = new MetricSeriesWriter(fs, OUT, { exemplars: 2, maxBufferedBuckets: 6 }, new Map(), []);
    const a = series('a', 'h');
    const b = series('b', 'h');
    for (let i = 0; i < 4; i++) writer.add(a.def, a.series, rel(i * 2 * S), counter(1), []);
    for (let i = 0; i < 2; i++) writer.add(b.def, b.series, rel(i * 2 * S), counter(1), []);
    expect(writer.full()).toBe(true);
    await writer.spill(catalog);
    expect(writer.full()).toBe(false);
    const segs = writer.listed().filter((p) => p.includes('/seg-'));
    expect(segs).toEqual(['data/metrics/000000/seg-000000.js']); // only `a`, the larger one
    expect((await writer.flush(catalog)).filter((p) => p.includes('/seg-'))).toEqual([
      'data/metrics/000000/seg-000000.js',
      'data/metrics/000001/seg-000000.js',
    ]);
  });

  test('columnar buffers merge like mergeAgg, and keep older points apart until written', async () => {
    const { fs, catalog, writer } = setup();
    const g = catalog.defOf({ ...pt('g', 'h'), type: 'gauge', temporality: 'unspecified', monotonic: false });
    const gs = catalog.seriesOf(
      g,
      { ...pt('g', 'h'), type: 'gauge', temporality: 'unspecified', monotonic: false },
      resource,
      scope,
    );
    const num = (v: number, t: number): BucketAgg => ({
      k: 'number',
      count: 1,
      sum: v,
      min: v,
      max: v,
      last: v,
      lastTime: t,
    });
    writer.add(g, gs, rel(0.1 * S), num(5, 1), []);
    writer.add(g, gs, rel(0.2 * S), num(2, 2), []);
    writer.add(g, gs, rel(3 * S), num(9, 3), []);
    writer.add(g, gs, rel(0.3 * S), num(1, 0), []); // older than the series' latest bucket
    await writer.flush(catalog);
    const seg = read<SegmentFile>(fs, metricSegmentKey(0, 0), parseSegmentFile);
    expect(seg.series).toEqual([
      {
        id: 0,
        t: [0, 2],
        a: [
          { k: 'number', count: 3, sum: 8, min: 1, max: 5, last: 2, lastTime: 2 },
          { k: 'number', count: 1, sum: 9, min: 9, max: 9, last: 9, lastTime: 3 },
        ],
      },
    ]);
  });
});
