import { describe, expect, test } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { openSession } from '../../src/writer/session.js';
import { attr, metricsRequest, T0 } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';

const OUT = 'r';
const cfg = (extra: NonNullable<ConfigInput['writer']> = {}) =>
  testConfig({ writer: { format: 'site', ...extra } });
const open = (w: TestWriter, mode: 'open' | 'append' | 'replace' = 'replace') =>
  openSession(w.deps, { out: OUT, config: cfg(), mode });

const T = (n: number): string => (BigInt(T0) + BigInt(n) * 1_000_000_000n).toString();
const cell = (r: object, k: string): unknown => Reflect.get(r, k);

const sum = (name: string, value: number, t: number, extra: object = {}, dp: object = {}) =>
  metricsRequestOf({
    name,
    unit: 'By',
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [{ asInt: String(value), startTimeUnixNano: T0, timeUnixNano: T(t), ...dp }],
      ...extra,
    },
  });
const metricsRequestOf = (metric: object) => otlp(metricsRequest([metric as never]));

async function points(w: TestWriter, n: number) {
  const bytes = await w.fs.readBytes(`${OUT}/data/partitions/${String(n).padStart(6, '0')}/points.parquet`);
  return decodeTable('points', bytes);
}

function manifestOf(w: TestWriter) {
  const text = w.fs.snapshot().get(`${OUT}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  return parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
}

describe('points table', () => {
  test('a gauge point is one row with its value and no deltas', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const res = await s.add(
      metricsRequestOf({
        name: 'temp',
        unit: 'Cel',
        description: 'd',
        gauge: {
          dataPoints: [
            {
              asDouble: 21.5,
              timeUnixNano: T(1),
              attributes: [attr('room', { stringValue: 'a' })],
              flags: 0,
            },
          ],
        },
      }),
      'm.json',
    );
    expect(res.accepted).toBe(1);
    await s.flush();
    const [row] = await points(w, 0);
    expect(row).toMatchObject({
      metric_name: 'temp',
      metric_unit: 'Cel',
      point_type: 'gauge',
      value_double: 21.5,
      time_unix_nano: BigInt(T(1)),
      flags: 0n,
      delta_value: null,
      delta_count: null,
      reset: false,
      out_of_order: false,
    });
    expect(String(cell(row ?? {}, 'series_id'))).toMatch(/^[0-9a-f]{32}$/);
    expect(manifestOf(w).totals.metrics).toBe(1);
    await s.close();
  });

  test('a cumulative counter 10, 15, 3 has deltas null..., 5 and a reset', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(sum('c', 10, 1), 'a.json');
    await s.add(sum('c', 15, 2), 'a.json');
    await s.add(sum('c', 3, 3), 'a.json');
    await s.flush();
    const rows = (await points(w, 0)).sort((a, b) =>
      Number(BigInt(cell(a, 'time_unix_nano') as bigint) - BigInt(cell(b, 'time_unix_nano') as bigint)),
    );
    expect(rows.map((r) => cell(r, 'delta_value'))).toEqual([10, 5, 3]);
    expect(rows.map((r) => cell(r, 'reset'))).toEqual([false, false, true]);
    expect(new Set(rows.map((r) => cell(r, 'series_id'))).size).toBe(1);
    await s.close();
  });

  test('an out-of-order point is a row flagged out_of_order', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(sum('c', 10, 5), 'a.json');
    await s.add(sum('c', 12, 2), 'a.json');
    await s.flush();
    const rows = await points(w, 0);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => cell(r, 'out_of_order') === true)).toHaveLength(1);
    await s.close();
  });

  test('a delta-temporality sum writes its own value as the delta (R39)', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(sum('c', 4, 1, { aggregationTemporality: 1 }), 'a.json');
    await s.flush();
    const [row] = await points(w, 0);
    expect(row).toMatchObject({ value_double: 4, delta_value: 4, delta_count: null, reset: false });
    await s.close();
  });

  test('a delta-temporality histogram writes its own count and sum as the deltas (R39)', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(
      metricsRequestOf({
        name: 'lat',
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [
            {
              startTimeUnixNano: T0,
              timeUnixNano: T(1),
              count: '3',
              sum: 10,
              bucketCounts: ['1', '1', '1'],
              explicitBounds: [1, 5],
            },
          ],
        },
      }),
      'a.json',
    );
    await s.flush();
    const [row] = await points(w, 0);
    expect(row).toMatchObject({ count: 3n, sum: 10, delta_count: 3n, delta_value: 10 });
    await s.close();
  });

  test('a delta up-down counter writes its own value as the delta; gauges and other non-monotonic sums stay null', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(sum('delta-updown', 4, 1, { aggregationTemporality: 1, isMonotonic: false }), 'a.json');
    await s.add(sum('cumulative-updown', 5, 1, { aggregationTemporality: 2, isMonotonic: false }), 'a.json');
    await s.add(sum('unspecified-updown', 6, 1, { aggregationTemporality: 0, isMonotonic: false }), 'a.json');
    await s.add(
      metricsRequestOf({
        name: 'g',
        gauge: { dataPoints: [{ asInt: '7', timeUnixNano: T(1) }] },
      }),
      'a.json',
    );
    await s.flush();
    const rows = await points(w, 0);
    const delta = (name: string) =>
      cell(rows.find((r) => cell(r, 'metric_name') === name) ?? {}, 'delta_value');
    expect(delta('delta-updown')).toBe(4);
    expect(delta('cumulative-updown')).toBeNull();
    expect(delta('unspecified-updown')).toBeNull();
    expect(delta('g')).toBeNull();
    expect(rows.every((r) => cell(r, 'delta_count') === null)).toBe(true);
    await s.close();
  });

  test('the report range of a point starts at its start time', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(sum('c', 1, 100), 'a.json'); // start T0, time T0 + 100 s
    await s.flush();
    const range = manifestOf(w).range;
    expect(BigInt(range?.start ?? 0)).toBe(BigInt(T0));
    expect(BigInt(range?.end ?? 0)).toBe(BigInt(T(100)));
    await s.close();
  });

  test('an explicit histogram keeps its bounds and counts as lists; cumulative gives delta count and sum', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const h = (count: number, sumV: number, counts: string[], t: number) =>
      metricsRequestOf({
        name: 'lat',
        histogram: {
          aggregationTemporality: 2,
          dataPoints: [
            {
              startTimeUnixNano: T0,
              timeUnixNano: T(t),
              count: String(count),
              sum: sumV,
              min: 1,
              max: 9,
              bucketCounts: counts,
              explicitBounds: [1, 5],
            },
          ],
        },
      });
    await s.add(h(3, 10, ['1', '1', '1'], 1), 'a.json');
    await s.add(h(5, 16, ['1', '2', '2'], 2), 'a.json');
    await s.flush();
    const rows = (await points(w, 0)).sort((a, b) => Number(cell(a, 'count')) - Number(cell(b, 'count')));
    expect(rows[1]).toMatchObject({
      point_type: 'histogram',
      count: 5n,
      sum: 16,
      explicit_bounds: [1, 5],
      bucket_counts: [1n, 2n, 2n],
      delta_count: 2n,
      delta_value: 6,
    });
    await s.close();
  });

  describe('per-bucket delta columns (D32)', () => {
    const DELTA_KEYS = [
      'delta_bucket_counts',
      'delta_scale',
      'delta_zero_count',
      'delta_positive_offset',
      'delta_positive_counts',
      'delta_negative_offset',
      'delta_negative_counts',
    ];
    const byTime = (rows: object[]) =>
      rows.sort((a, b) => Number(cell(a, 'time_unix_nano')) - Number(cell(b, 'time_unix_nano')));
    const hist = (counts: string[], count: number, t: number, start = T0) =>
      metricsRequestOf({
        name: 'lat',
        histogram: {
          aggregationTemporality: 2,
          dataPoints: [
            {
              startTimeUnixNano: start,
              timeUnixNano: T(t),
              count: String(count),
              sum: count,
              bucketCounts: counts,
              explicitBounds: [1, 5],
            },
          ],
        },
      });
    const exp = (scale: number, pos: { offset: number; bucketCounts: string[] }, count: number, t: number) =>
      metricsRequestOf({
        name: 'ex',
        exponentialHistogram: {
          aggregationTemporality: 2,
          dataPoints: [
            {
              startTimeUnixNano: T0,
              timeUnixNano: T(t),
              count: String(count),
              sum: count,
              scale,
              zeroCount: '0',
              positive: pos,
            },
          ],
        },
      });

    test('a cumulative explicit histogram writes the per-bucket delta; the exponential columns are null', async () => {
      const w = createTestWriter();
      const s = await open(w);
      await s.add(hist(['1', '2', '0'], 3, 1), 'a.json');
      await s.add(hist(['2', '5', '1'], 8, 2), 'a.json');
      await s.flush();
      const rows = byTime(await points(w, 0));
      expect(rows.map((r) => cell(r, 'delta_bucket_counts'))).toEqual([
        [1n, 2n, 0n],
        [1n, 3n, 1n],
      ]);
      for (const r of rows) expect(cell(r, 'delta_scale')).toBeNull();
      await s.close();
    });

    test('a cumulative exponential histogram writes its delta at the normalizer scale; delta_bucket_counts is null', async () => {
      const w = createTestWriter();
      const s = await open(w);
      await s.add(exp(1, { offset: 0, bucketCounts: ['1', '1'] }, 2, 1), 'a.json');
      await s.add(exp(2, { offset: 0, bucketCounts: ['1', '1', '1', '2'] }, 5, 2), 'a.json');
      await s.flush();
      const rows = byTime(await points(w, 0));
      expect(cell(rows[0] ?? {}, 'delta_scale')).toBe(1);
      expect(cell(rows[1] ?? {}, 'delta_scale')).toBe(1);
      expect(cell(rows[1] ?? {}, 'delta_positive_offset')).toBe(0);
      expect(cell(rows[1] ?? {}, 'delta_positive_counts')).toEqual([1n, 2n]);
      expect(cell(rows[1] ?? {}, 'delta_zero_count')).toBe(0n);
      for (const r of rows) expect(cell(r, 'delta_bucket_counts')).toBeNull();
      await s.close();
    });

    test('a reset point writes its own counts', async () => {
      const w = createTestWriter();
      const s = await open(w);
      await s.add(hist(['2', '5', '1'], 8, 1), 'a.json');
      await s.add(hist(['1', '0', '0'], 1, 2), 'a.json');
      await s.flush();
      const rows = byTime(await points(w, 0));
      expect(cell(rows[1] ?? {}, 'reset')).toBe(true);
      expect(cell(rows[1] ?? {}, 'delta_bucket_counts')).toEqual([1n, 0n, 0n]);
      await s.close();
    });

    test('gauges, summaries and out-of-order points write null for all seven', async () => {
      const w = createTestWriter();
      const s = await open(w);
      await s.add(
        metricsRequestOf({ name: 'g', gauge: { dataPoints: [{ asDouble: 1, timeUnixNano: T(1) }] } }),
        'a.json',
      );
      await s.add(
        metricsRequestOf({
          name: 'sm',
          summary: {
            dataPoints: [
              { startTimeUnixNano: T0, timeUnixNano: T(1), count: '1', sum: 1, quantileValues: [] },
            ],
          },
        }),
        'a.json',
      );
      await s.add(hist(['2', '5', '1'], 8, 5), 'a.json');
      await s.add(hist(['1', '1', '1'], 3, 2), 'a.json');
      await s.flush();
      const rows = await points(w, 0);
      const quiet = rows.filter((r) => cell(r, 'metric_name') !== 'lat' || cell(r, 'out_of_order') === true);
      expect(quiet).toHaveLength(3);
      for (const r of quiet) for (const k of DELTA_KEYS) expect(cell(r, k)).toBeNull();
      await s.close();
    });
  });

  test('an explicit histogram without bounds has an empty list, an exponential one without buckets has nulls', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(
      metricsRequestOf({
        name: 'h0',
        histogram: {
          aggregationTemporality: 1,
          dataPoints: [{ timeUnixNano: T(1), count: '1', sum: 1, bucketCounts: ['1'] }],
        },
      }),
      'a.json',
    );
    await s.add(
      metricsRequestOf({
        name: 'e0',
        exponentialHistogram: {
          aggregationTemporality: 1,
          dataPoints: [{ timeUnixNano: T(1), count: '0', sum: 0, scale: 0, zeroCount: '0' }],
        },
      }),
      'a.json',
    );
    await s.flush();
    const rows = await points(w, 0);
    const h0 = rows.find((r) => cell(r, 'metric_name') === 'h0');
    const e0 = rows.find((r) => cell(r, 'metric_name') === 'e0');
    expect(cell(h0 ?? {}, 'explicit_bounds')).toEqual([]);
    expect(cell(e0 ?? {}, 'positive_offset')).toBeNull();
    expect(cell(e0 ?? {}, 'positive_counts')).toBeNull();
    expect(cell(e0 ?? {}, 'negative_counts')).toBeNull();
    await s.close();
  });

  test('an exponential histogram keeps its offsets and counts', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(
      metricsRequestOf({
        name: 'ex',
        exponentialHistogram: {
          aggregationTemporality: 1,
          dataPoints: [
            {
              timeUnixNano: T(1),
              count: '6',
              sum: 12,
              scale: 2,
              zeroCount: '1',
              positive: { offset: -3, bucketCounts: ['2', '3'] },
              negative: { offset: 4, bucketCounts: ['0'] },
            },
          ],
        },
      }),
      'a.json',
    );
    await s.flush();
    const [row] = await points(w, 0);
    expect(row).toMatchObject({
      point_type: 'exp_histogram',
      scale: 2,
      zero_count: 1n,
      positive_offset: -3,
      positive_counts: [2n, 3n],
      negative_offset: 4,
      negative_counts: [0n],
    });
    await s.close();
  });

  test('a summary keeps its quantiles as json', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(
      metricsRequestOf({
        name: 'sm',
        summary: {
          dataPoints: [
            {
              timeUnixNano: T(1),
              count: '4',
              sum: 8,
              quantileValues: [{ quantile: 0.5, value: 2 }],
            },
          ],
        },
      }),
      'a.json',
    );
    await s.flush();
    const [row] = await points(w, 0);
    expect(row).toMatchObject({ point_type: 'summary', count: 4n, sum: 8 });
    expect(JSON.stringify(JSON.parse(String(cell(row ?? {}, 'quantiles'))))).toContain('0.5');
    await s.close();
  });

  test('exemplars are json with trace ids', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(
      metricsRequestOf({
        name: 'g',
        gauge: {
          dataPoints: [
            {
              asDouble: 1,
              timeUnixNano: T(1),
              exemplars: [
                { asDouble: 1, timeUnixNano: T(1), traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
              ],
            },
          ],
        },
      }),
      'a.json',
    );
    await s.flush();
    const [row] = await points(w, 0);
    expect(String(cell(row ?? {}, 'exemplars'))).toContain('a'.repeat(32));
    await s.close();
  });

  test('a count above 2^53 rejects its request, and flags above int32 are stored', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const big = metricsRequestOf({
      name: 'big',
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [
          { timeUnixNano: T(1), count: '9007199254740993', sum: 1, bucketCounts: ['9007199254740993'] },
        ],
      },
    });
    await expect(s.add(big, 'a.json')).rejects.toMatchObject({ code: 'invalid-otlp' });
    await s.add(
      metricsRequestOf({
        name: 'g',
        gauge: { dataPoints: [{ asDouble: 1, timeUnixNano: T(1), flags: 4294967294 }] },
      }),
      'a.json',
    );
    await s.flush();
    const rows = await points(w, 0);
    expect(rows).toHaveLength(1);
    expect(cell(rows[0] ?? {}, 'flags')).toBe(4294967294n);
    expect(manifestOf(w).totals.metrics).toBe(1);
    await s.close();
  });

  test('points of two series get different series ids; the id is stable across sessions', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(sum('c', 1, 1, {}, { attributes: [attr('k', { stringValue: 'a' })] }), 'a.json');
    await s.add(sum('c', 1, 1, {}, { attributes: [attr('k', { stringValue: 'b' })] }), 'a.json');
    await s.close();
    const a = await open(w, 'append');
    await a.add(sum('c', 1, 2, {}, { attributes: [attr('k', { stringValue: 'a' })] }), 'b.json');
    await a.close();
    const ids = [...(await points(w, 0)), ...(await points(w, 1))].map((r) => cell(r, 'series_id'));
    expect(new Set(ids).size).toBe(2);
    expect(ids[0] === ids[2] || ids[1] === ids[2]).toBe(true);
  });

  test('an append session continues the deltas from the saved stream state', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(sum('c', 10, 1), 'a.json');
    await s.close();
    const a = await open(w, 'append');
    await a.add(sum('c', 15, 2), 'b.json');
    await a.close();
    const [row] = await points(w, 1);
    expect(row).toMatchObject({ delta_value: 5, reset: false });
  });

  test('a failed cut keeps the points and a retry does not advance the streams twice', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(sum('c', 10, 1), 'a.json');
    await s.flush();
    await s.add(sum('c', 15, 2), 'a.json');
    w.fs.failNextWrite('data/partitions/000001/points.parquet');
    await expect(s.flush()).rejects.toBeDefined();
    await s.flush();
    await s.add(sum('c', 20, 3), 'a.json');
    await s.close();
    // The three flush partitions were compacted into partition 3, in time order.
    const rows = await points(w, 3);
    expect(rows.map((r) => cell(r, 'delta_value')).slice(1)).toEqual([5, 5]);
    expect(rows).toHaveLength(3);
    expect(manifestOf(w).totals.metrics).toBe(3);
  });

  test('a histogram series with other bounds is another series, not a reset', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const h = (bounds: number[], t: number) =>
      metricsRequestOf({
        name: 'lat',
        histogram: {
          aggregationTemporality: 2,
          dataPoints: [
            {
              startTimeUnixNano: T0,
              timeUnixNano: T(t),
              count: '2',
              sum: 3,
              bucketCounts: bounds.map(() => '1').concat('0'),
              explicitBounds: bounds,
            },
          ],
        },
      });
    await s.add(h([1, 5], 1), 'a.json');
    await s.add(h([1, 6], 2), 'a.json');
    await s.flush();
    const rows = await points(w, 0);
    expect(new Set(rows.map((r) => cell(r, 'series_id'))).size).toBe(2);
    expect(rows.map((r) => cell(r, 'reset'))).toEqual([false, false]);
    await s.close();
  });

  test('series_id of a known point is pinned', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(sum('requests', 1, 1, {}, { attributes: [attr('k', { stringValue: 'a' })] }), 'a.json');
    await s.flush();
    const [row] = await points(w, 0);
    expect(cell(row ?? {}, 'series_id')).toBe('7ab145ac3d2248e9d840b81f5b3284fc');
    await s.close();
  });

  test('the stream state in a checkpoint is frozen with the cut, not read at write time', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config: cfg({ chunkTargetBytes: 1 }), mode: 'replace' });
    const gate = w.fs.holdNextWrite('000000/points.parquet');
    await s.add(sum('c', 10, 1), 'a.json');
    await gate.reached;
    await s.add(sum('c', 15, 2), 'a.json');
    gate.release();
    await s.flush();
    const text = w.fs.snapshot().get(`${OUT}/data/state/session.0.json`);
    const streams = JSON.parse(text ?? '{}').metricStreams as { lasts: number[] };
    expect(streams.lasts).toEqual([10]);
    await s.close();
  });

  test('a rejected request leaves the streams untouched', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(sum('c', 10, 1), 'a.json');
    const mixed = otlp(
      metricsRequest([
        {
          name: 'c',
          unit: 'By',
          sum: {
            aggregationTemporality: 2,
            isMonotonic: true,
            dataPoints: [{ asInt: '50', startTimeUnixNano: T0, timeUnixNano: T(2) }],
          },
        },
        {
          name: 'bad',
          histogram: {
            aggregationTemporality: 1,
            dataPoints: [{ timeUnixNano: T(2), count: '7', sum: 1, bucketCounts: ['1'] }],
          },
        },
      ]),
    );
    await expect(s.add(mixed, 'a.json')).rejects.toMatchObject({ code: 'invalid-otlp' });
    await s.add(sum('c', 15, 3), 'a.json');
    await s.flush();
    const rows = (await points(w, 0)).sort(
      (a, b) => Number(cell(a, 'delta_value')) - Number(cell(b, 'delta_value')),
    );
    expect(rows.map((r) => cell(r, 'delta_value'))).toEqual([5, 10]);
    expect(manifestOf(w).totals.metrics).toBe(2);
    await s.close();
  });
});
