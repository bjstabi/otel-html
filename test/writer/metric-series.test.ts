import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import {
  GAP_SAMPLE,
  LEVEL0_WIDTH_NS,
  type LevelFile,
  levelWidthNs,
  metricExemplarKey,
  metricLevelExemplarKey,
  metricLevelKey,
  metricSegmentKey,
  metricSeriesKey,
  parseExemplarFile,
  parseLevelFile,
  parseSegmentFile,
  parseSeriesFile,
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
import type { FileSystem } from '../../src/writer/ports.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

const OUT = 'r';
const S = 1_000_000_000;
const rel = (n: number): RelNanos => n as RelNanos;
const counter = (delta: number): BucketAgg => ({ k: 'counter', delta, resets: 0 });
/** A delta histogram of one point with 15 bounds, its bounds array its own (as a parsed point's is). */
const hist16 = (): BucketAgg => ({
  k: 'hist',
  count: 16,
  sum: 16,
  min: null,
  max: null,
  bounds: [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000],
  counts: Array.from({ length: 16 }, () => 1),
});
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

  test("compact records each series' point gaps in series.js (format 2)", async () => {
    const { fs, catalog, writer, series } = setup();
    const a = series('a', 'h1');
    const b = series('a', 'h2');
    series('a', 'h3'); // a series with no points
    // `a` every 10 s (level-0 gaps of 9 or 10 buckets), then one long gap past the sample; `b` once.
    for (let i = 0; i < GAP_SAMPLE + 2; i++) writer.add(a.def, a.series, rel(i * 10 * S), counter(1), []);
    writer.add(a.def, a.series, rel(100_000 * S), counter(1), []);
    writer.add(b.def, b.series, rel(0), counter(1), []);
    await writer.flush(catalog);
    expect(read(fs, metricSeriesKey(0), parseSeriesFile).gaps).toBeUndefined();
    await writer.compact(catalog);
    const file = read(fs, metricSeriesKey(0), parseSeriesFile);
    expect(file.series).toHaveLength(3);
    expect(file.gaps).toEqual([
      { n: GAP_SAMPLE, median: 10 },
      { n: 0, median: 0 },
      { n: 0, median: 0 },
    ]);
  });

  test("levels above ex.js's get their own ex<k>.js, capped per series per level-k bucket", async () => {
    const { fs, catalog, writer, series } = setup();
    const a = series('a', 'h1');
    // A point and an exemplar every 60 s for ~3 days: levels 0-3, level 3 being 524.288 s wide.
    const points = 4500;
    for (let i = 0; i < points; i++)
      writer.add(a.def, a.series, rel(i * 60 * S), counter(1), [ex(0, i * 60 * S, i)]);
    await writer.flush(catalog);
    const listed = await writer.compact(catalog);
    expect(listed).toEqual([
      'data/metrics/000000/ex.js',
      'data/metrics/000000/ex3.js',
      'data/metrics/000000/l0.js',
      'data/metrics/000000/l1.js',
      'data/metrics/000000/l2.js',
      'data/metrics/000000/l3.js',
      'data/metrics/000000/series.js',
    ]);
    const base = read(fs, metricExemplarKey(0), parseExemplarFile).exemplars;
    const l3 = read(fs, metricLevelExemplarKey(0, 3), parseExemplarFile).exemplars;
    expect(base).toHaveLength(points);
    const perBucket = new Map<number, number>();
    for (const e of l3) {
      const b = Math.floor(e.time / levelWidthNs(3));
      perBucket.set(b, (perBucket.get(b) ?? 0) + 1);
    }
    expect(Math.max(...perBucket.values())).toBe(2);
    expect(l3.length).toBeLessThanOrEqual(2 * perBucket.size);
    expect(l3.length).toBeLessThan(base.length / 4);
    // Reopened, the writer demotes ex3.js with the levels: the manifest never names a file being rewritten.
    const reopened = new MetricSeriesWriter(fs, OUT, { exemplars: 2 }, new Map([[0, 1]]), listed);
    await reopened.flush(catalog);
    expect(reopened.listed()).toEqual(['data/metrics/000000/seg-000001.js', 'data/metrics/000000/series.js']);
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
    const writer = new MetricSeriesWriter(fs, OUT, { exemplars: 2, bufferBudget: 3 }, new Map(), []);
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

  test('histogram buckets weigh their size in the budget, not one bucket each', async () => {
    const fs = createMemoryFileSystem();
    const catalog = new MetricCatalog({ seriesCap: 10 });
    // A 16-bucket histogram bucket weighs 8 units (about 40 bytes each): 3 fit in 30, the 4th fills it.
    const writer = new MetricSeriesWriter(fs, OUT, { exemplars: 2, bufferBudget: 30 }, new Map(), []);
    const p = pt('h', 'h');
    const def = catalog.defOf(p);
    const series = catalog.seriesOf(def, p, resource, scope);
    for (let i = 0; i < 3; i++) writer.add(def, series, rel(i * 2 * S), hist16(), []);
    expect(writer.full()).toBe(false);
    writer.add(def, series, rel(6 * 2 * S), hist16(), []);
    expect(writer.full()).toBe(true);
  });

  // 500k buckets and a forced GC per measurement take ~2 s locally and over 5 s on CI runners; the assertion is on
  // heap, not time.
  test('a histogram-heavy buffer spills at a bounded heap (default budget)', {
    timeout: 60_000,
  }, async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const live = (): number => {
      gc();
      return process.memoryUsage().heapUsed;
    };
    // Segment writes are dropped, so the heap holds only the buffer.
    const sink: FileSystem = { ...createMemoryFileSystem(), writeTextAtomic: async () => {} };
    const catalog = new MetricCatalog({ seriesCap: 1000 });
    const writer = new MetricSeriesWriter(sink, OUT, { exemplars: 2 }, new Map(), []);
    const all = Array.from({ length: 1000 }, (_, j) => {
      const p = pt('h', `host-${j}`);
      const def = catalog.defOf(p);
      return { def, series: catalog.seriesOf(def, p, resource, scope) };
    });
    const base = live();
    let peak = 0;
    // 500k histogram buckets (1,000 series × 500 s), each with its own bounds array as the normalizer makes them.
    for (let t = 0; t < 500; t++) {
      for (const { def, series } of all) writer.add(def, series, rel(t * 2 * S), hist16(), []);
      if (writer.full() || t % 50 === 49) peak = Math.max(peak, live() - base);
      if (writer.full()) await writer.spill(catalog);
    }
    // Held to here, so the buffer is live at every measurement.
    await writer.flush(catalog);
    expect(peak).toBeLessThan(100 * 1024 * 1024);
  });

  test('spill writes the largest buffers first, down to half the budget', async () => {
    const { fs, catalog, series } = setup();
    const writer = new MetricSeriesWriter(fs, OUT, { exemplars: 2, bufferBudget: 6 }, new Map(), []);
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
