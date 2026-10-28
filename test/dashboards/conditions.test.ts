import { describe, expect, it } from 'vitest';
import { andConditions, traceCondition } from '../../src/dashboards/conditions.js';
import { compileCondition } from '../../src/ottl/compile.js';
import { parseCondition } from '../../src/ottl/parse.js';

describe('andConditions', () => {
  it('drops nulls and returns a single part as is', () => {
    expect(andConditions(null, 'a == 1', null)).toBe('a == 1');
    expect(andConditions(null, null)).toBeNull();
    expect(andConditions()).toBeNull();
  });

  it('wraps each part in parentheses and the result parses', () => {
    const joined = andConditions('a == 1 or b == 2', 'c == 3');
    expect(joined).toBe('(a == 1 or b == 2) and (c == 3)');
    expect(() => parseCondition(joined ?? '')).not.toThrow();
  });
});

describe('traceCondition', () => {
  it('compiles for spans and log records', () => {
    const c = traceCondition('0af7651916cd43dd8448eb211c80319c');
    expect(c).toBe('trace_id.string == "0af7651916cd43dd8448eb211c80319c"');
    expect(() => compileCondition(c, 'span')).not.toThrow();
    expect(() => compileCondition(c, 'log_record')).not.toThrow();
  });
});
