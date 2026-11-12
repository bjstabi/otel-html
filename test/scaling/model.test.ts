import { describe, expect, test } from 'vitest';
import { REQUESTS_PER_OPEN, splitOpens } from '../../test-support/scaling/cost.js';
import type { ReadEvent } from '../../test-support/scaling/counting-engine.js';
import { BASE, CROSS, type Shape, stepsOf } from '../../test-support/scaling/generator.js';
import {
  countCalls,
  type EntryFit,
  fitEntry,
  fitModel,
  improvedFit,
  type Model,
  type PartitionShape,
  predict,
  predictPage,
} from '../../test-support/scaling/model.js';

const out = (rowGroups: number): PartitionShape => ({ rowGroups, inWindow: false, smallFiles: 0 });
const inside = (rowGroups: number): PartitionShape => ({ rowGroups, inWindow: true, smallFiles: 0 });

/** The shapes the harness measures: the three axes of both spacings' dense form, and the cross point. */
const SHAPES: readonly Shape[] = [
  ...stepsOf('retention', 'dense'),
  ...stepsOf('density', 'dense'),
  ...stepsOf('window', 'dense'),
  CROSS,
];

const serialOf = (m: Model, s: Shape): number =>
  m.a + s.outside * (m.r + m.rd * s.rowGroups) + s.inside * (m.w + m.wd * s.rowGroups);

describe('fitModel', () => {
  test('recovers a known model exactly', () => {
    const m = { a: 7, r: 1, rd: 0, w: 3, wd: 5 };
    expect(fitModel(SHAPES.map((shape) => ({ shape, serial: serialOf(m, shape) })))).toEqual(m);
  });

  test('recovers a model with every term set, and the one of a request that reads nothing', () => {
    const every = { a: 2, r: 0.5, rd: 1.25, w: 4, wd: 0.75 };
    expect(fitModel(SHAPES.map((shape) => ({ shape, serial: serialOf(every, shape) })))).toEqual(every);
    const none = { a: 0, r: 0, rd: 0, w: 0, wd: 0 };
    expect(fitModel(SHAPES.map((shape) => ({ shape, serial: 0 })))).toEqual(none);
  });

  test('the base shape alone cannot identify a model', () => {
    expect(() => fitModel([{ shape: BASE, serial: 3 }])).toThrow(/identif/);
  });
});

describe('predict', () => {
  test('sums partitions of different sizes', () => {
    expect(predict({ a: 2, r: 1, rd: 0, w: 0, wd: 4 }, [out(3), inside(2), inside(5)])).toBe(2 + 1 + 8 + 20);
  });
});

describe('predict on a shape larger than the fitted ones', () => {
  test('a partition never costs below zero', () => {
    expect(predict({ a: 1, r: 4, rd: -1, w: 0, wd: 0 }, [out(2), out(30)])).toBe(1 + 2 + 0);
  });
});

describe('fitModel is non-negative', () => {
  test('data that would pull a coefficient below zero gives zero, never a negative', () => {
    // the cost falls as the partitions inside the window grow: a plain fit would give w < 0
    const points = SHAPES.map((shape) => ({ shape, serial: 40 - 3 * shape.inside + shape.outside }));
    const m = fitModel(points);
    for (const v of Object.values(m)) expect(v).toBeGreaterThanOrEqual(0);
  });

  test('recovers a known non-negative model exactly', () => {
    const m = { a: 1, r: 0, rd: 2, w: 0.5, wd: 0 };
    expect(fitModel(SHAPES.map((shape) => ({ shape, serial: serialOf(m, shape) })))).toEqual(m);
  });

  test('a request without a window reads every partition alike: r = w and rd = wd', () => {
    const m = { a: 3, r: 2, rd: 0.5, w: 2, wd: 0.5 };
    const fitted = fitModel(
      SHAPES.map((shape) => ({ shape, serial: serialOf(m, shape) })),
      { windowless: true },
    );
    expect(fitted).toEqual(m);
    // data that disagrees between the two roles is averaged into one coefficient
    const skewed = fitModel(
      SHAPES.map((shape) => ({ shape, serial: serialOf({ a: 0, r: 1, rd: 0, w: 3, wd: 0 }, shape) })),
      { windowless: true },
    );
    expect(skewed.r).toBe(skewed.w);
    expect(skewed.rd).toBe(skewed.wd);
  });
});

const point = (shape: Shape, serial: number, spans: number) => ({
  shape,
  serial,
  parallel: 0,
  bytes: 0,
  opens: { spans: { count: spans, footer: spans } },
});

/** An entry that opens `perPartition` spans files per partition and reads `serial(shape)` data requests. */
const entry = (perPartition: number, data: Model, windowless = false): EntryFit =>
  fitEntry(
    SHAPES.map((shape) => point(shape, serialOf(data, shape), perPartition * (shape.outside + shape.inside))),
    windowless,
  );

const four = (rowGroups: number): PartitionShape[] => [
  { rowGroups, inWindow: false, smallFiles: 0 },
  { rowGroups, inWindow: false, smallFiles: 0 },
  { rowGroups, inWindow: true, smallFiles: 0 },
  { rowGroups, inWindow: true, smallFiles: 0 },
];

describe('predictPage', () => {
  const data = { a: 1, r: 2, rd: 0, w: 2, wd: 0 };

  test('a file two entries open is opened once', () => {
    const one = entry(1, data, true);
    const alone = predictPage([{ fit: one, times: 1, filesAxes: [] }], four(2));
    const both = predictPage(
      [
        { fit: one, times: 1, filesAxes: [] },
        { fit: entry(1, data, true), times: 1, filesAxes: [] },
      ],
      four(2),
    );
    // the second entry adds its data part (1 + 4 x 2 = 9) and no open: 4 files x (open + 1 footer read)
    expect(alone.serial).toBe(9 + 4 * (REQUESTS_PER_OPEN + 1));
    expect(both.serial).toBe(alone.serial + 9);
  });

  test('an entry asked for 3 distinct ids costs 3 data parts and opens its files once', () => {
    const byId = entry(1, data, true);
    const once = predictPage([{ fit: byId, times: 1, filesAxes: [] }], four(2));
    const thrice = predictPage([{ fit: byId, times: 3, filesAxes: [] }], four(2));
    expect(thrice.serial - once.serial).toBe(2 * 9);
  });

  test('countCalls counts a by-id call once per distinct id and a memoised call once', () => {
    const call = (method: string, idKey: string | null, id: string) => ({
      method,
      idKey,
      ids: [id],
      baseline: false,
    });
    const counted = countCalls([
      call('serviceShare', 'a', 'trace.share'),
      call('serviceShare', 'b', 'trace.share'),
      call('serviceShare', 'a', 'trace.share'),
      call('serviceShare', 'c', 'trace.share'),
      call('metricCatalog', null, 'metrics.catalog'),
      call('metricCatalog', null, 'metrics.catalog'),
      call('querySpans', null, 'spans.total.long'),
      call('querySpans', null, 'spans.total.long'),
    ]);
    expect(counted.get('trace.share|false')).toBe(3);
    expect(counted.get('metrics.catalog|false')).toBe(1);
    expect(counted.get('spans.total.long|false')).toBe(2);
  });
});

describe('improvedFit acts per axis', () => {
  const m = { a: 2, r: 3, rd: 1, w: 4, wd: 2 };
  const fit = entry(1, m);

  test('a retention line leaves w and wd unchanged and drops the outside partitions', () => {
    const after = improvedFit(fit, { retention: 'fixed' });
    expect(after.serial).toEqual({ ...m, r: 0, rd: 0 });
    expect(after.opens.spans?.ro).toBe(0);
    expect(after.opens.spans?.wi).toBe(fit.opens.spans?.wi);
  });

  test('a window line leaves r and rd unchanged', () => {
    const after = improvedFit(fit, { window: 'fixed' });
    expect(after.serial).toEqual({ ...m, w: 0, wd: 0 });
  });

  test('a density line takes the G terms of both roles: fixed and matched alike', () => {
    expect(improvedFit(fit, { density: 'fixed' }).serial).toEqual({ ...m, rd: 0, wd: 0 });
    expect(improvedFit(fit, { density: 'matched' }).serial).toEqual({ ...m, rd: 0, wd: 0 });
    expect(improvedFit(fit, { density: 'files' }).serial).toEqual({ ...m, rd: 0, wd: 0 });
  });

  test('matched on retention drops only that axis G term', () => {
    expect(improvedFit(fit, { retention: 'matched' }).serial).toEqual({ ...m, rd: 0 });
  });

  test('a scan changes nothing', () => {
    expect(improvedFit(fit, { retention: 'scan', window: 'scan', density: 'scan' })).toEqual(fit);
  });
});

describe('splitOpens', () => {
  const size = new Map([['p/spans.parquet', 100_000]]);
  const e = (kind: 'open' | 'read', offset: number, bytes: number): ReadEvent => ({
    path: 'p/spans.parquet',
    kind,
    offset,
    bytes,
  });

  test('the open and the reads that end at the file end are the open part; the rest is data', () => {
    const split = splitOpens(
      [e('open', 0, 0), e('read', 99_900, 100), e('read', 0, 16384), e('read', 16384, 16384)],
      size,
    );
    expect(split.serial).toBe(REQUESTS_PER_OPEN + 1);
    expect(split.files).toEqual([{ table: 'spans', footer: 1 }]);
  });

  test('an open with no footer read (cached) is the open alone', () => {
    const split = splitOpens([e('open', 0, 0), e('read', 0, 100)], size);
    expect(split.serial).toBe(REQUESTS_PER_OPEN);
    expect(split.files).toEqual([{ table: 'spans', footer: 0 }]);
  });
});
