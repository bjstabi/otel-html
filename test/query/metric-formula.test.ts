import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { formulaRefs, parseFormula } from '../../src/query/metric-formula.js';

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
