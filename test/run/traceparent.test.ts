import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseTraceparent } from '../../src/run/traceparent.js';

function usageOf(fn: () => unknown): OtelHtmlError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('did not throw');
}

describe('parseTraceparent', () => {
  test('parses the W3C form', () => {
    const p = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(Buffer.from(p.traceId).toString('hex')).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(Buffer.from(p.spanId).toString('hex')).toBe('b7ad6b7169203331');
    expect(p.flags).toBe(1);
  });
  test.each([
    ['01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', 'version'],
    ['00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01', 'uppercase'],
    ['00-00000000000000000000000000000000-b7ad6b7169203331-01', 'zero trace id'],
    ['00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01', 'zero span id'],
    ['00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331', 'missing flags'],
    ['', 'empty'],
  ])('%s is a usage error (%s)', (value) => {
    expect(() => parseTraceparent(value)).toThrow(OtelHtmlError);
    const e = usageOf(() => parseTraceparent(value));
    expect(e.code).toBe('usage');
    expect(e.hint).toContain('00-<32 hex trace id>');
  });

  test('the error names the source it was given', () => {
    expect(usageOf(() => parseTraceparent('nope')).message).toContain(
      'TRACEPARENT is not a W3C traceparent: nope',
    );
    expect(usageOf(() => parseTraceparent('nope', '--traceparent')).message).toContain(
      '--traceparent is not a W3C traceparent: nope',
    );
  });
});
