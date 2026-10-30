import { z } from 'zod';
import type { AnyValue, Attributes } from '../model/anyvalue.js';
import { OtelHtmlError } from '../model/errors.js';

// ---------------------------------------------------------------------------------------------
// Lossless JSON for attributes (strings and bools are bare, everything else is tagged): the encoding of series,
// exemplar and catalog attributes in the metric files
// ---------------------------------------------------------------------------------------------

export type JsonAny = null | boolean | number | string | JsonAny[] | { [k: string]: JsonAny };

function bytesToBase64(b: Uint8Array): string {
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function encodeValue(v: AnyValue): JsonAny {
  switch (v.kind) {
    case 'string':
    case 'bool':
      return v.value;
    case 'empty':
      return null;
    case 'int':
      return { i: v.value.toString() };
    case 'double':
      return { d: Number.isFinite(v.value) && !Object.is(v.value, -0) ? v.value : String(v.value) };
    case 'bytes':
      return { b: bytesToBase64(v.value) };
    case 'array':
      return { a: v.values.map(encodeValue) };
    case 'kvlist':
      return { m: encodeAttributes(v.values) };
  }
}

export function encodeAttributes(a: Attributes): JsonAny[] {
  return [...a].map(([k, v]) => [k, encodeValue(v)]);
}

const SPECIAL_DOUBLES: ReadonlyMap<string, number> = new Map([
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['0', -0],
]);
const INT64 = /^-?\d{1,19}$/;

export const JsonAnySchema: z.ZodType<JsonAny> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonAnySchema),
    z.record(z.string(), JsonAnySchema),
  ]),
);

function invalid(path: string, expected: string, actual: unknown): OtelHtmlError {
  return new OtelHtmlError('invalid-report', {
    path,
    expected,
    actual: JSON.stringify(actual) ?? 'undefined',
  });
}

function decodeValue(v: JsonAny, path: string): AnyValue {
  if (v === null) return { kind: 'empty' };
  if (typeof v === 'string') return { kind: 'string', value: v };
  if (typeof v === 'boolean') return { kind: 'bool', value: v };
  const tags = typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
  const tag = tags[0];
  const body = tag === undefined || Array.isArray(v) || typeof v !== 'object' ? undefined : v[tag];
  if (tags.length === 1 && body !== undefined) {
    switch (tag) {
      case 'i':
        if (typeof body === 'string' && INT64.test(body)) return { kind: 'int', value: BigInt(body) };
        break;
      case 'd': {
        if (typeof body === 'number') return { kind: 'double', value: body };
        const special = typeof body === 'string' ? SPECIAL_DOUBLES.get(body) : undefined;
        if (special !== undefined) return { kind: 'double', value: special };
        break;
      }
      case 'b':
        if (typeof body === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(body)) {
          return { kind: 'bytes', value: Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) };
        }
        break;
      case 'a':
        if (Array.isArray(body)) {
          return { kind: 'array', values: body.map((x, i) => decodeValue(x, `${path}.a[${i}]`)) };
        }
        break;
      case 'm':
        return { kind: 'kvlist', values: decodeAttributes(body, `${path}.m`) };
      default:
        break;
    }
  }
  throw invalid(path, 'an encoded attribute value', v);
}

export function decodeAttributes(v: JsonAny, path: string): Attributes {
  if (!Array.isArray(v)) throw invalid(path, 'a list of [key, value] pairs', v);
  const out = new Map<string, AnyValue>();
  v.forEach((e, i) => {
    const k = Array.isArray(e) ? e[0] : undefined;
    const x = Array.isArray(e) ? e[1] : undefined;
    if (!Array.isArray(e) || e.length !== 2 || typeof k !== 'string' || x === undefined) {
      throw invalid(`${path}[${i}]`, '[key, value]', e);
    }
    out.set(k, decodeValue(x, `${path}[${i}][1]`));
  });
  return out;
}
