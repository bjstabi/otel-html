import { expect, test } from 'vitest';
import { assertNever, invariant, OtelHtmlError } from '../../src/model/errors.js';

test('error carries code and hint', () => {
  const e = new OtelHtmlError('report-locked', {
    path: 'out/data/state/lock',
    hint: 'use `otel-html merge`',
  });
  expect(e.code).toBe('report-locked');
  expect(e.message).toContain('hint: use `otel-html merge`');
});

test('message format', () => {
  const e = new OtelHtmlError('invalid-otlp', { path: 'a.b', expected: 'string', actual: '3', hint: 'h' });
  expect(e.message).toBe('a.b: expected string, got 3\n  hint: h');
  expect(e.path).toBe('a.b');
  expect(e.expected).toBe('string');
  expect(e.actual).toBe('3');
  expect(e.name).toBe('OtelHtmlError');
  expect(new OtelHtmlError('usage', { message: 'custom' }).message).toBe('custom');
});

test('invariant and assertNever', () => {
  expect(() => invariant(false, 'boom')).toThrowError('boom');
  expect(() => invariant(1, 'boom')).not.toThrow();
  expect(() => assertNever('x' as never, 'p.kind')).toThrowError(OtelHtmlError);
});
