import { describe, expect, test } from 'vitest';
import { BASE, CROSS, type Shape, stepsOf } from '../../test-support/scaling/generator.js';
import { fitModel, type Model, type PartitionShape, predict } from '../../test-support/scaling/model.js';

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
