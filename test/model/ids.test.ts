import { expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import {
  parseSpanId,
  parseTraceId,
  parseUnixNanos,
  spanIdFromBytes,
  toRelNanos,
  toUnixNanos,
  traceIdFromBytes,
} from '../../src/model/ids.js';

test('trace ids normalize case and reject bad input', () => {
  expect(parseTraceId('5B8EFFF798038103D269B633813FC60C', 'x')).toBe('5b8efff798038103d269b633813fc60c');
  expect(() =>
    parseTraceId('00000000000000000000000000000000', 'resourceSpans[0].scopeSpans[0].spans[3].traceId'),
  ).toThrowError(
    'resourceSpans[0].scopeSpans[0].spans[3].traceId: expected 32 hex chars, not all zero, got "00000000000000000000000000000000"',
  );
  expect(() => parseSpanId('abc', 'p')).toThrowError(/expected 16 hex chars/);
});

test('ids from bytes', () => {
  const t = Uint8Array.from([
    0x5b, 0x8e, 0xff, 0xf7, 0x98, 0x03, 0x81, 0x03, 0xd2, 0x69, 0xb6, 0x33, 0x81, 0x3f, 0xc6, 0x0c,
  ]);
  expect(traceIdFromBytes(t, 'p')).toBe('5b8efff798038103d269b633813fc60c');
  expect(spanIdFromBytes(Uint8Array.from([0xee, 0xe1, 0x9b, 0x7e, 0xc3, 0xc1, 0xb1, 0x74]), 'p')).toBe(
    'eee19b7ec3c1b174',
  );
  expect(() => spanIdFromBytes(new Uint8Array(3), 'p')).toThrowError(OtelHtmlError);
  expect(() => spanIdFromBytes(new Uint8Array(8), 'p')).toThrowError(/not all zero/);
});

test('RelNanos round-trips and fails beyond 2^53', () => {
  const epoch = parseUnixNanos('1700000000000000000', 'e');
  const t = parseUnixNanos('1700000000123456789', 't');
  expect(toRelNanos(t, epoch, 't')).toBe(123456789);
  expect(toUnixNanos(toRelNanos(t, epoch, 't'), epoch)).toBe(t);
  expect(() => toRelNanos((epoch + 2n ** 53n) as typeof epoch, epoch, 'span.start')).toThrowError(
    OtelHtmlError,
  );
});

test('parseUnixNanos accepts string, number and bigint and rejects junk', () => {
  expect(parseUnixNanos(5n, 'p')).toBe(5n);
  expect(parseUnixNanos(5, 'p')).toBe(5n);
  expect(parseUnixNanos('5', 'p')).toBe(5n);
  expect(() => parseUnixNanos('-1', 'p')).toThrowError(OtelHtmlError);
  expect(() => parseUnixNanos('1.5', 'p')).toThrowError(OtelHtmlError);
  expect(() => parseUnixNanos(1.5, 'p')).toThrowError(OtelHtmlError);
  expect(() => parseUnixNanos('abc', 'p')).toThrowError(OtelHtmlError);
});
