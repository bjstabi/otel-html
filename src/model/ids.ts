import { bytesToHex } from './bytes.js';
import { OtelHtmlError } from './errors.js';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TraceId = Brand<string, 'TraceId'>;
export type SpanId = Brand<string, 'SpanId'>;
export type UnixNanos = Brand<bigint, 'UnixNanos'>;
export type RelNanos = Brand<number, 'RelNanos'>;

function parseHexId(hex: string, len: number, path: string): string {
  const lower = hex.toLowerCase();
  if (lower.length !== len || !/^[0-9a-f]+$/.test(lower) || /^0+$/.test(lower)) {
    throw new OtelHtmlError('invalid-otlp', {
      path,
      expected: `${len} hex chars, not all zero`,
      actual: JSON.stringify(hex),
    });
  }
  return lower;
}

/** An id from raw bytes: the length and the all-zero check run on the bytes, the hex is built once. */
function idFromBytes(b: Uint8Array, bytes: number, path: string): string {
  if (b.length !== bytes || b.every((x) => x === 0)) {
    throw new OtelHtmlError('invalid-otlp', {
      path,
      expected: `${bytes * 2} hex chars, not all zero`,
      actual: JSON.stringify(bytesToHex(b)),
    });
  }
  return bytesToHex(b);
}

export function parseTraceId(hex: string, path: string): TraceId {
  return parseHexId(hex, 32, path) as TraceId;
}

export function parseSpanId(hex: string, path: string): SpanId {
  return parseHexId(hex, 16, path) as SpanId;
}

export function traceIdFromBytes(b: Uint8Array, path: string): TraceId {
  return idFromBytes(b, 16, path) as TraceId;
}

export function spanIdFromBytes(b: Uint8Array, path: string): SpanId {
  return idFromBytes(b, 8, path) as SpanId;
}

export function parseUnixNanos(v: string | number | bigint, path: string): UnixNanos {
  const bad = (): OtelHtmlError =>
    new OtelHtmlError('invalid-otlp', {
      path,
      expected: 'non-negative integer nanoseconds',
      actual: typeof v === 'bigint' ? v.toString() : JSON.stringify(v),
    });
  let n: bigint;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw bad();
    n = BigInt(v);
  } else {
    if (!/^[0-9]+$/.test(v)) throw bad();
    n = BigInt(v);
  }
  if (n < 0n) throw bad();
  return n as UnixNanos;
}

export function toRelNanos(t: UnixNanos, epoch: UnixNanos, path: string): RelNanos {
  const d = t - epoch;
  if (d > BigInt(Number.MAX_SAFE_INTEGER) || d < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new OtelHtmlError('time-out-of-range', {
      path,
      expected: 'offset within 2^53 ns (~104 days) of trace epoch',
      actual: `${d} ns`,
    });
  }
  return Number(d) as RelNanos;
}

export function toUnixNanos(r: RelNanos, epoch: UnixNanos): UnixNanos {
  return (BigInt(r) + epoch) as UnixNanos;
}
