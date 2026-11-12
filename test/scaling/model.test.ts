import { describe, expect, test } from 'vitest';
import {
  BASE,
  CROSS,
  PAGE_CROSS,
  pageShapes,
  type Shape,
  stepsOf,
} from '../../test-support/scaling/generator.js';
import {
  countCalls,
  type EntryFit,
  filesParallel,
  fitEntry,
  fitModel,
  fitPage,
  improvedFit,
  type Model,
  type PageEntry,
  type PartitionShape,
  predict,
  predictPage,
  scaledPage,
  splitWindow,
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

/** The first partition (outside, or inside with no outside) holds `bigRowGroups` groups when the shape has them. */
const serialOf = (m: Model, s: Shape): number =>
  m.a +
  s.outside * (m.r + m.rd * s.rowGroups) +
  s.inside * (m.w + m.wd * s.rowGroups) +
  (s.bigRowGroups === undefined ? 0 : (s.bigRowGroups - s.rowGroups) * (s.outside > 0 ? m.rd : m.wd));

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

const point = (shape: Shape, model: Model) => ({
  shape,
  serial: serialOf(model, shape),
  parallel: 0,
  bytes: 0,
});

/** An entry whose cost on every shape follows `model`. */
const entry = (model: Model, windowless = false): EntryFit =>
  fitEntry(
    SHAPES.map((shape) => point(shape, model)),
    windowless,
  );

describe('a page is fitted from its own measurements', () => {
  test('fitPage recovers a known non-negative model from page points', () => {
    // a page reads every partition alike (its window spans the report): a + P (p + pd G)
    const known = { a: 6, r: 1.5, rd: 0.25, w: 1.5, wd: 0.25 };
    const page = fitPage(
      SHAPES.map((shape) => ({
        shape,
        serial: serialOf(known, shape),
        parallel: 2 * serialOf(known, shape),
        bytes: 1000 + shape.outside + shape.inside,
      })),
    );
    expect(page.serial).toEqual(known);
    expect(page.parallel).toEqual({ a: 12, r: 3, rd: 0.5, w: 3, wd: 0.5 });
    expect(page.bytes).toEqual({ a: 1000, r: 1, rd: 0, w: 1, wd: 0 });
  });

  test('a page that grows faster than linearly in the row groups gets a non-negative G squared term', () => {
    // per partition p + pd G + q G^2: the large partitions of the page shapes carry the curvature
    const shapes = pageShapes('dense');
    const cost = (s: Shape): number => {
      const groups = [
        s.bigRowGroups ?? s.rowGroups,
        ...Array.from({ length: s.outside + s.inside - 1 }, () => s.rowGroups),
      ];
      return 3 + groups.reduce((n, g) => n + 4 + 0.5 * g + 0.125 * g * g, 0);
    };
    const page = fitPage(shapes.map((shape) => ({ shape, serial: cost(shape), parallel: 0, bytes: 0 })));
    expect(page.serial).toEqual({ a: 3, r: 4, rd: 0.5, w: 4, wd: 0.5, q: 0.125 });
    const cap = predictPage(page, [inside(22), inside(2)]).serial;
    expect(cap).toBeCloseTo(3 + (4 + 11 + 0.125 * 484) + (4 + 1 + 0.5), 6);
  });

  test('a page that is linear gets no G squared term, and a concave one cannot get a negative one', () => {
    const linear = fitPage(
      pageShapes('dense').map((shape) => ({
        shape,
        serial: 5 + (shape.outside + shape.inside) * 3,
        parallel: 0,
        bytes: 0,
      })),
    );
    expect(linear.serial).not.toHaveProperty('q');
    const concave = fitPage(
      pageShapes('dense').map((shape) => ({
        shape,
        serial: 10 * Math.sqrt(shape.rowGroups) * (shape.outside + shape.inside),
        parallel: 0,
        bytes: 0,
      })),
    );
    expect(concave.serial.q ?? 0).toBeGreaterThanOrEqual(0);
  });

  test('a page fit is the same without the cross: three terms are identified by the axes alone', () => {
    const known = { a: 4, r: 2, rd: 1, w: 2, wd: 1 };
    const axes = SHAPES.filter((s) => s !== CROSS);
    const page = fitPage(
      axes.map((shape) => ({ shape, serial: serialOf(known, shape), parallel: 0, bytes: 0 })),
    );
    expect(page.serial).toEqual(known);
  });
});

describe('the page fit measures density on production-size row groups', () => {
  test.each(['dense', 'sparse'] as const)(
    '%s: 50,000-row groups, 1 to 4 per partition, and the cross apart',
    (spacing) => {
      const shapes = pageShapes(spacing);
      expect(shapes.every((s) => s.rowGroupRows === 50_000 && s.spacing === spacing)).toBe(true);
      const base = shapes.filter((s) => s.outside === 1 && s.inside === 1 && s.bigRowGroups === undefined);
      expect(base.map((s) => s.rowGroups).sort()).toEqual([1, 2, 3, 4]);
      expect(new Set(shapes.map((s) => s.outside + s.inside)).size).toBeGreaterThanOrEqual(3);
      expect(shapes).not.toContainEqual(PAGE_CROSS(spacing));
      expect(PAGE_CROSS(spacing).rowGroupRows).toBe(50_000);
    },
  );

  test.each(['dense', 'sparse'] as const)(
    '%s: a page shape has a partition of at least 22 groups',
    (spacing) => {
      const biggest = Math.max(...pageShapes(spacing).map((s) => s.bigRowGroups ?? s.rowGroups));
      expect(biggest).toBeGreaterThanOrEqual(22);
      expect(pageShapes(spacing).filter((s) => s.bigRowGroups !== undefined).length).toBeGreaterThanOrEqual(
        3,
      );
    },
  );

  test('the shapes identify a page fit without the cross', () => {
    const known = { a: 3, r: 2, rd: 1, w: 2, wd: 1 };
    const points = pageShapes('dense').map((shape) => ({
      shape,
      serial: serialOf(known, shape),
      parallel: 0,
      bytes: 0,
    }));
    expect(fitPage(points).serial).toEqual(known);
  });
});

describe('predictPage', () => {
  test('is the fitted models summed over the partitions of the shape', () => {
    const page = fitPage(SHAPES.map((shape) => point(shape, { a: 3, r: 2, rd: 1, w: 2, wd: 1 })));
    const cost = predictPage(page, [out(2), out(2), inside(2), inside(2)]);
    expect(cost.serial).toBe(3 + 4 * (2 + 1 * 2));
    expect(cost.parallel).toBe(0);
  });
});

describe('countCalls', () => {
  test('counts a by-id call once per distinct id and a memoised call once', () => {
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

describe('filesParallel', () => {
  const small = (inWindow: boolean): PartitionShape => ({ rowGroups: 2, inWindow, smallFiles: 3 });
  const partitions = [small(false), small(true), small(true)];

  test('a retention line covers the partitions outside the window', () => {
    expect(filesParallel([{ times: 1, axes: ['retention'], windowless: false }], partitions)).toBe(3);
  });

  test('a windowless entry carries no window: its retention line covers every partition', () => {
    expect(filesParallel([{ times: 1, axes: ['retention'], windowless: true }], partitions)).toBe(9);
    // with no window every partition is inside it, and the windowed entry has nothing outside
    expect(
      filesParallel([{ times: 1, axes: ['retention'], windowless: false }], [small(true), small(true)]),
    ).toBe(0);
    expect(
      filesParallel([{ times: 1, axes: ['retention'], windowless: true }], [small(true), small(true)]),
    ).toBe(6);
  });

  test('window and density lines, weighted by the calls', () => {
    expect(filesParallel([{ times: 2, axes: ['window'], windowless: false }], partitions)).toBe(2 * 6);
    expect(filesParallel([{ times: 1, axes: ['density'], windowless: true }], partitions)).toBe(9);
    expect(filesParallel([{ times: 1, axes: [], windowless: false }], partitions)).toBe(0);
  });
});

describe('--after scales a page by its entries shares', () => {
  const page = { a: 5, r: 4, rd: 0, w: 2, wd: 3 };
  const models = (m: Model) => ({ serial: m, parallel: { ...m, a: 0, r: 0, rd: 0, w: 0, wd: 0 }, bytes: m });
  const e = (m: Model, reached: Parameters<typeof improvedFit>[1], times = 1): PageEntry => {
    const before = entry(m);
    return { before, after: improvedFit(before, reached), times };
  };

  test('a retention line on an entry carrying half the page r halves r and leaves w and wd', () => {
    const entries = [
      e({ a: 1, r: 2, rd: 0, w: 1, wd: 1 }, { retention: 'fixed' }),
      e({ a: 1, r: 2, rd: 0, w: 1, wd: 2 }, {}),
    ];
    const after = scaledPage(models(page), entries);
    expect(after.serial).toEqual({ a: 5, r: 2, rd: 0, w: 2, wd: 3 });
  });

  test('an entry called twice weighs twice, and without a line nothing changes', () => {
    const lined = e({ a: 0, r: 1, rd: 0, w: 0, wd: 0 }, { retention: 'fixed' }, 1);
    const plain = e({ a: 0, r: 1, rd: 0, w: 0, wd: 0 }, {}, 2);
    expect(scaledPage(models(page), [lined, plain]).serial.r).toBeCloseTo((4 * 2) / 3, 9);
    expect(scaledPage(models(page), [plain]).serial).toEqual(page);
  });

  test('the G squared term follows the density share: a retention line leaves it, a density line zeroes it', () => {
    const withQ = { ...models({ ...page, q: 0.5 }), parallel: models(page).parallel };
    const entries = (reached: Parameters<typeof improvedFit>[1]): PageEntry[] => [
      e({ a: 0, r: 1, rd: 1, w: 1, wd: 1 }, reached),
    ];
    expect(scaledPage(withQ, entries({ retention: 'fixed' })).serial.q).toBe(0.5);
    expect(scaledPage(withQ, entries({ density: 'fixed' })).serial.q).toBe(0);
    expect(scaledPage(withQ, entries({ density: 'matched' })).serial.q).toBe(0);
    expect(scaledPage(models(page), entries({ density: 'fixed' })).serial).not.toHaveProperty('q');
  });

  test('a term no entry carries stays as measured', () => {
    const none = e({ a: 1, r: 0, rd: 0, w: 1, wd: 0 }, { retention: 'fixed' });
    expect(scaledPage(models(page), [none]).serial).toEqual(page);
  });

  test('a density line takes the G terms of both roles; matched keeps the part without G', () => {
    const d = e({ a: 0, r: 1, rd: 1, w: 1, wd: 1 }, { density: 'fixed' });
    expect(scaledPage(models(page), [d]).serial).toEqual({ a: 5, r: 4, rd: 0, w: 2, wd: 0 });
    const m = e({ a: 0, r: 1, rd: 1, w: 1, wd: 1 }, { retention: 'matched' });
    expect(scaledPage(models(page), [m]).serial).toEqual({ a: 5, r: 4, rd: 0, w: 2, wd: 3 });
  });
});

describe('splitWindow', () => {
  test('gives the outside partitions the entries own ratio of outside to inside cost, at most 1', () => {
    const page = fitPage(SHAPES.map((shape) => point(shape, { a: 0, r: 4, rd: 0, w: 4, wd: 0 })));
    const windowed = entry({ a: 0, r: 1, rd: 0, w: 4, wd: 0 });
    const all = splitWindow({ serial: page.serial, parallel: page.parallel, bytes: page.bytes }, [
      { before: windowed, after: windowed, times: 1 },
    ]);
    expect(all.serial.r).toBe(1);
    expect(all.serial.w).toBe(4);
    const same = entry({ a: 0, r: 4, rd: 0, w: 1, wd: 0 });
    expect(splitWindow(page, [{ before: same, after: same, times: 1 }]).serial.r).toBe(4);
  });
});

describe('improvedFit acts per axis', () => {
  const m = { a: 2, r: 3, rd: 1, w: 4, wd: 2 };
  const fit = entry(m);

  test('a retention line leaves w and wd unchanged and drops the outside partitions', () => {
    const after = improvedFit(fit, { retention: 'fixed' });
    expect(after.serial).toEqual({ ...m, r: 0, rd: 0 });
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
