import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { evaluateFormula, formulaRefs, parseFormula } from '../../src/viewer/data/metric-formula.js';
import type { MetricQueryResult, SeriesPoints } from '../../src/viewer/data/metric-query.js';

const W = 10e9;
const series = (key: string, label: string, vals: (number | null)[], unit = 'By'): SeriesPoints => ({
  key,
  label,
  group: { service: label },
  unit,
  points: vals.map((v, i) => [i * W, v]),
  resourceService: label,
});
const result = (queryId: string, s: SeriesPoints[], widthNs = W): MetricQueryResult => ({
  queryId,
  widthNs,
  series: s,
  exemplars: [],
  heat: null,
  distribution: null,
  notes: [],
});

describe('parseFormula', () => {
  test('precedence and parentheses', () => {
    expect(parseFormula('a + b * 2')).toEqual({
      type: 'bin',
      op: '+',
      left: { type: 'ref', id: 'a' },
      right: { type: 'bin', op: '*', left: { type: 'ref', id: 'b' }, right: { type: 'num', value: 2 } },
    });
    expect(parseFormula('(a + b) / 2.5')).toMatchObject({ op: '/', left: { op: '+' } });
    expect(formulaRefs(parseFormula('a / (c - a)'))).toEqual(['a', 'c']);
  });

  test('a bad expression fails with usage at its column', () => {
    const run = () => parseFormula('a + * b');
    expect(run).toThrow(OtelHtmlError);
    try {
      run();
    } catch (e) {
      expect(e instanceof OtelHtmlError && e.code).toBe('usage');
      expect(e instanceof OtelHtmlError && e.path).toBe('col 5');
    }
    expect(() => parseFormula('a +')).toThrow(/col 4/);
    expect(() => parseFormula('(a')).toThrow(/col 3/);
    expect(() => parseFormula('a $ b')).toThrow(/col 3/);
    expect(() => parseFormula('ab')).toThrow(/col 2/);
  });
});

describe('evaluateFormula', () => {
  test('a / c aligns on group and time; a missing group and division by zero give null', () => {
    const a = result('a', [series('x', 'x', [10, 20, 30]), series('y', 'y', [1, 2, 3])]);
    const c = result('c', [series('x', 'x', [2, 0, null])]);
    const r = evaluateFormula(
      parseFormula('a / c'),
      new Map([
        ['a', a],
        ['c', c],
      ]),
      'f1',
    );
    expect(r.queryId).toBe('f1');
    expect(r.widthNs).toBe(W);
    const byKey = new Map(r.series.map((s) => [s.key, s.points.map(([, v]) => v)]));
    expect(byKey.get('x')).toEqual([5, null, null]);
    expect(byKey.get('y')).toEqual([null, null, null]);
  });

  test('numbers and units', () => {
    const a = result('a', [series('x', 'x', [10, 20])]);
    const r = evaluateFormula(parseFormula('a * 2 + a'), new Map([['a', a]]), 'f');
    expect(r.series[0]?.points).toEqual([
      [0, 30],
      [W, 60],
    ]);
    expect(r.series[0]?.unit).toBe('By');
    expect(r.series[0]?.label).toBe('x');
  });

  test('operands must share a width and exist', () => {
    const a = result('a', [series('x', 'x', [1])]);
    const b = result('b', [series('x', 'x', [1])], 2 * W);
    const both = new Map([
      ['a', a],
      ['b', b],
    ]);
    expect(() => evaluateFormula(parseFormula('a + b'), both, 'f')).toThrow(/width/);
    expect(() => evaluateFormula(parseFormula('a + z'), both, 'f')).toThrow(/z/);
  });
});
