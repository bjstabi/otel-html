import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { SpanKind } from '../../src/model/records.js';
import { compileAny, compileCondition } from '../../src/ottl/compile.js';
import { ENUMS } from '../../src/ottl/contexts.js';
import { logTarget, spanTarget } from './fixtures.js';

function errorOf(f: () => unknown): OtelHtmlError {
  try {
    f();
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('compile-time failures', () => {
  test('unknown path names the column and path', () => {
    expect(() => compileCondition('span.nmae == "x"', 'span')).toThrowError(
      /col 1: expected a span path, got "span.nmae"/,
    );
    expect(() => compileCondition('name == "x" and bogus == 1', 'span')).toThrowError(
      /col 17: expected a span path/,
    );
  });
  test('arity', () => {
    expect(() => compileCondition('IsMatch(name)', 'span')).toThrowError(
      /IsMatch: expected 2 arguments, got 1/,
    );
    expect(() => compileCondition('IsRootSpan(1)', 'span')).toThrowError(
      /IsRootSpan: expected 0 arguments, got 1/,
    );
  });
  test('unknown converter / enum', () => {
    expect(() => compileCondition('Nope(1)', 'span')).toThrowError(
      /col 1: expected a known converter, got "Nope"/,
    );
    expect(() => compileCondition('status.code == STATUS_CODE_NOPE', 'span')).toThrowError(
      /expected a known enum, got "STATUS_CODE_NOPE"/,
    );
  });
  test('converter not available in context', () => {
    expect(() => compileCondition('IsRootSpan()', 'log_record')).toThrowError(/IsRootSpan.*log_record/);
  });
  test('keys on a non-map path', () => {
    expect(() => compileCondition('name["x"] == "y"', 'span')).toThrowError(/does not take keys/);
  });
  test('enum column is its own position', () => {
    expect(() => compileCondition('name == "x" and status.code == STATUS_CODE_NOPE', 'span')).toThrowError(
      /^col 32: expected a known enum/,
    );
  });
  test('boolean-expression error column', () => {
    expect(() => compileCondition('name == "x" and Len(name)', 'span')).toThrowError(
      /^col 17: expected a boolean expression/,
    );
  });
  test('non-boolean top-level expression', () => {
    expect(() => compileCondition('name', 'span')).toThrowError(/expected a boolean expression/);
    expect(() => compileCondition('Len(name)', 'span')).toThrowError(/expected a boolean expression/);
  });
  test('parse errors pass through', () => {
    expect(errorOf(() => compileCondition('name ==', 'span')).code).toBe('invalid-ottl');
  });
  test('regex errors at compile time with column', () => {
    const e = errorOf(() => compileCondition('name == "x" and IsMatch(name, "(")', 'span'));
    expect(e.code).toBe('invalid-ottl');
    expect(e.message).toMatch(/col 17: .*invalid regular expression/);
  });
  test('regex pattern must be a string literal', () => {
    expect(() => compileCondition('IsMatch(name, name)', 'span')).toThrowError(/string literal/);
  });
  test.each([
    '(a+)+$',
    '(a*)*',
    '(.*a){1,}b*(x+y)+',
    '(a|b+)*',
    '(a)\\1',
    '(?=a)a',
    '(?<!a)b',
    '[^](a+)+$',
    '[](a+)+$',
  ])('rejects backtracking-prone or non-RE2 regex %s', (p) => {
    expect(() => compileCondition(`IsMatch(name, ${JSON.stringify(p)})`, 'span')).toThrowError(
      /invalid-?|regular expression/i,
    );
  });
  test.each(['^GET /api/[a-z]+$', '(ab)+c', '(a+)?b', '(a|b){2,5}', '[(+*]+', '\\(a+\\)+', '(?i)get'])(
    'accepts %s',
    (p) => {
      expect(() => compileCondition(`IsMatch(name, ${JSON.stringify(p)})`, 'span')).not.toThrow();
    },
  );
  test('over-long regex', () => {
    expect(() => compileCondition(`IsMatch(name, "${'a'.repeat(2000)}")`, 'span')).toThrowError(/too long/);
  });
});

describe('hostile deep input', () => {
  test('deeply nested not/parens fails with invalid-ottl, not a stack overflow', () => {
    const n = 400;
    const src = `${'not ('.repeat(n)}IsRootSpan()${')'.repeat(n)}`;
    const e = errorOf(() => compileCondition(src, 'span'));
    expect(e.code).toBe('invalid-ottl');
    expect(e.message).toMatch(/nested too deeply/);
  });
  test('moderate nesting still works', () => {
    const src = `${'not ('.repeat(21)}IsRootSpan()${')'.repeat(21)}`;
    expect(compileCondition(src, 'span').test(spanTarget())).toBe(true);
  });
  test('long flat and/or and math chains evaluate without recursion limits', () => {
    const ands = Array.from({ length: 900 }, () => 'Len(name) > 1').join(' and ');
    expect(compileCondition(ands, 'span').test(spanTarget())).toBe(true);
    const sum = Array.from({ length: 900 }, () => '1').join(' + ');
    expect(compileCondition(`${sum} == 900`, 'span').test(spanTarget())).toBe(true);
    const ors = `${Array.from({ length: 900 }, () => 'false').join(' or ')} or true`;
    expect(compileCondition(ors, 'span').test(spanTarget())).toBe(true);
  });
});

describe('compileAny', () => {
  test('drops if any condition matches; empty never matches', () => {
    const t = spanTarget();
    expect(compileAny(['name == "x"', 'Len(name) > 3'], 'span').test(t)).toBe(true);
    expect(compileAny(['name == "x"', 'name == "y"'], 'span').test(t)).toBe(false);
    expect(compileAny([], 'span').test(t)).toBe(false);
  });
  test('error names the failing condition index', () => {
    expect(() => compileAny(['name == "x"', 'bogus == 1'], 'span')).toThrowError(
      /conditions\[1\] col 1: expected a span path/,
    );
  });
});

describe('contexts', () => {
  test('log_record paths', () => {
    const t = logTarget();
    const c = (s: string) => compileCondition(s, 'log_record').test(t);
    expect(c('severity_number >= SEVERITY_NUMBER_ERROR')).toBe(true);
    expect(c('log.severity_text == "ERROR"')).toBe(true);
    expect(c('IsMatch(body, "declined")')).toBe(true);
    expect(c('body.string == "payment declined"')).toBe(true);
    expect(c('attributes["code"] == 42')).toBe(true);
    expect(c('resource.attributes["service.name"] == "checkout"')).toBe(true);
    expect(c('trace_id.string == ""')).toBe(true);
  });
  test('enum table matches proto', () => {
    expect(ENUMS.get('SPAN_KIND_SERVER')).toBe(BigInt(SpanKind.SERVER));
    expect(ENUMS.get('SPAN_KIND_CONSUMER')).toBe(BigInt(SpanKind.CONSUMER));
    expect(ENUMS.get('STATUS_CODE_ERROR')).toBe(2n);
    expect(ENUMS.get('SEVERITY_NUMBER_FATAL4')).toBe(24n);
    expect(ENUMS.get('SEVERITY_NUMBER_TRACE')).toBe(1n);
  });
});
