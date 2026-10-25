import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseCondition, printCondition } from '../../src/ottl/parse.js';

function roundTrip(src: string) {
  const e = parseCondition(src);
  expect(parseCondition(printCondition(e))).toEqual(e);
  return e;
}

function errorOf(src: string): OtelHtmlError {
  try {
    parseCondition(src);
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error(`expected ${src} to fail`);
}

describe('parseCondition', () => {
  test.each([
    ['span.attributes["http.route"] == "/api/cart" and not IsMatch(span.name, "^GET")', 'and'],
    ['status.code == STATUS_CODE_ERROR or attributes["retry"] == true', 'or'],
    ['span.end_time_unix_nano - span.start_time_unix_nano > 250000000', 'cmp'],
    ['resource.attributes["service.name"] != nil', 'cmp'],
    ['IsRootSpan()', 'value'],
  ])('parses %s', (src, top) => {
    const e = parseCondition(src);
    expect(e.type).toBe(top);
    expect(parseCondition(printCondition(e))).toEqual(e); // print is a fixpoint
  });

  test('string escapes', () => {
    const e = roundTrip('name == "a\\"b\\\\c\\n\\t\\u00e9"');
    expect(e).toMatchObject({ type: 'cmp', right: { type: 'literal', value: 'a"b\\c\n\té' } });
  });

  test('nested paths with int and string keys', () => {
    const e = roundTrip('attributes["a"][2]["b.c"] == 1');
    expect(e).toMatchObject({
      type: 'cmp',
      left: { type: 'path', segments: ['attributes'], keys: ['a', 2, 'b.c'] },
    });
    const p = roundTrip('resource.attributes["x"] == "y"');
    expect(p).toMatchObject({ left: { segments: ['resource', 'attributes'], keys: ['x'], from: 0 } });
  });

  test('precedence: not > and > or', () => {
    const e = roundTrip('a == 1 or not b == 2 and c == 3');
    expect(e.type).toBe('or');
    if (e.type !== 'or') throw new Error('unreachable');
    expect(e.right.type).toBe('and');
    if (e.right.type !== 'and') throw new Error('unreachable');
    expect(e.right.left.type).toBe('not');
  });

  test('parentheses override precedence', () => {
    const e = roundTrip('(a == 1 or b == 2) and c == 3');
    expect(e.type).toBe('and');
  });

  test('math precedence and left associativity', () => {
    const e = roundTrip('a + b * c - d > 0');
    expect(e).toMatchObject({
      type: 'cmp',
      left: {
        type: 'math',
        op: '-',
        left: { type: 'math', op: '+', right: { type: 'math', op: '*' } },
        right: { type: 'path' },
      },
    });
    const r = roundTrip('(a + b) * c > 0');
    expect(r).toMatchObject({ left: { type: 'math', op: '*', left: { type: 'math', op: '+' } } });
    const l = roundTrip('a - b - c > 0');
    expect(l).toMatchObject({ left: { op: '-', left: { op: '-' } } });
  });

  test('enums, nil, booleans', () => {
    expect(roundTrip('kind == SPAN_KIND_SERVER')).toMatchObject({
      right: { type: 'enum', name: 'SPAN_KIND_SERVER' },
    });
    expect(roundTrip('x == nil')).toMatchObject({ right: { type: 'literal', value: null } });
    expect(roundTrip('x == false')).toMatchObject({ right: { type: 'literal', value: false } });
  });

  test('ints are bigint, floats are numbers, negatives fold', () => {
    expect(roundTrip('x > 9007199254740993')).toMatchObject({ right: { value: 9007199254740993n } });
    expect(roundTrip('x > 1.5')).toMatchObject({ right: { value: 1.5 } });
    expect(roundTrip('x > 2.0')).toMatchObject({ right: { value: 2 } });
    expect(roundTrip('x > -3')).toMatchObject({ right: { value: -3n } });
    expect(roundTrip('x > -0.25')).toMatchObject({ right: { value: -0.25 } });
    expect(roundTrip('x - -1 > 0')).toMatchObject({ left: { type: 'math', right: { value: -1n } } });
  });

  test('converter calls with nested args', () => {
    const e = roundTrip('IsMatch(attributes["a"], Concat("x", name)) and Len(name) > 3');
    expect(e.type).toBe('and');
  });

  test('identifiers that start with a keyword are paths', () => {
    expect(roundTrip('android == order and note != nilly')).toMatchObject({ type: 'and' });
    expect(roundTrip('not_found == true_value')).toMatchObject({ left: { segments: ['not_found'] } });
  });

  test('comparison operators', () => {
    for (const op of ['==', '!=', '<', '<=', '>', '>=']) {
      expect(roundTrip(`a ${op} 1`)).toMatchObject({ type: 'cmp', op });
    }
  });

  test('print preserves grouping when needed', () => {
    expect(printCondition(parseCondition('(a + b) * c > 0'))).toBe('(a + b) * c > 0');
    expect(printCondition(parseCondition('(a == 1 or b == 2) and c == 3'))).toBe(
      '(a == 1 or b == 2) and c == 3',
    );
  });
});

describe('parseCondition errors', () => {
  test('reports the column of a syntax error', () => {
    expect(() => parseCondition('name == "a" and')).toThrowError(
      /col 16: expected expression, got end of input/,
    );
  });

  test('error has code invalid-ottl and path', () => {
    const e = errorOf('name == ');
    expect(e.code).toBe('invalid-ottl');
    expect(e.path).toBe('col 9');
  });

  test('unbalanced open paren', () => {
    expect(errorOf('(a == 1').message).toMatch(/col 8: expected '\)', got end of input/);
  });

  test('unexpected close paren', () => {
    expect(errorOf('a == 1)').message).toMatch(/col 7: expected end of input, got '\)'/);
  });

  test('unterminated string', () => {
    expect(errorOf('name == "abc').message).toMatch(/col 9: expected closing '"', got end of input/);
  });

  test('unexpected character', () => {
    expect(errorOf('a == @').message).toMatch(/col 6: expected expression, got '@'/);
  });

  test('empty input', () => {
    expect(errorOf('').message).toMatch(/col 1: expected expression, got end of input/);
  });

  test('bad escape', () => {
    expect(errorOf('a == "\\q"').message).toMatch(/col 7: expected valid escape/);
  });

  test('operand kinds are validated', () => {
    expect(errorOf('(a == 1) == true').message).toMatch(/col 1: expected value, got comparison/);
    expect(errorOf('a and 1 + 2').message).toMatch(/expected boolean expression/);
    expect(errorOf('a == 1 == 2').message).toMatch(/col 8: expected operator or end of input, got '=='/);
  });

  test('lowercase enum-like and bad enum', () => {
    expect(errorOf('a == Foo').message).toMatch(/col 6: expected enum/);
  });

  test('hostile input stays bounded', () => {
    const deep = `${'('.repeat(5000)}a${')'.repeat(5000)}`;
    expect(() => parseCondition(deep)).toThrowError(OtelHtmlError);
    const longAnd = Array.from({ length: 500 }, () => 'a == 1').join(' and ');
    expect(() => parseCondition(longAnd)).not.toThrow();
    const tooLong = Array.from({ length: 1001 }, () => 'a == 1').join(' or ');
    expect(() => parseCondition(tooLong)).toThrowError(/at most 1000 chained operands/);
    expect(() => parseCondition('"'.repeat(100000))).toThrowError(OtelHtmlError);
  });
});
