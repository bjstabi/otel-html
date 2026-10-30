import { OtelHtmlError } from '../model/errors.js';
import { REGISTRATION_GLOBAL } from './version.js';

/**
 * Data files are classic scripts (so they load over file://): `__OH__.push("<key>",<json>);\n`.
 * The JSON is made inert: `<` (so `</script>`, `<!--`, `<img` can never appear) and U+2028/U+2029
 * (line terminators in old JS parsers) are written as `\uXXXX` escapes, which JSON.parse and the JS
 * parser both decode back to the same string.
 */

const SUFFIX = ');\n';

export function bytesToBase64(b: Uint8Array): string {
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin);
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function base64ToBytes(s: string, path: string): Uint8Array {
  if (!BASE64.test(s)) {
    throw new OtelHtmlError('invalid-report', { path, expected: 'base64', actual: JSON.stringify(s) });
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function escapeHostile(json: string): string {
  return json.replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function replacer(key: string, value: unknown): unknown {
  switch (typeof value) {
    case 'bigint':
      return { $i: value.toString() };
    case 'number':
      if (!Number.isFinite(value)) {
        throw new OtelHtmlError('invalid-report', {
          path: key === '' ? '(root)' : key,
          expected: 'a finite number',
          actual: String(value),
        });
      }
      return value;
    case 'function':
    case 'symbol':
      throw new OtelHtmlError('invalid-report', {
        path: key === '' ? '(root)' : key,
        expected: 'a JSON-serializable value',
        actual: typeof value,
      });
    case 'object':
      return value instanceof Uint8Array ? { $b: bytesToBase64(value) } : value;
    default:
      return value;
  }
}

/**
 * Whether `JSON.stringify` writes `v` exactly as it does with `replacer`, which then has nothing to do: no bigint,
 * byte array, non-finite number, function, symbol or `toJSON` anywhere in it. Walking the value first is several
 * times cheaper than a replacer, which `JSON.stringify` calls back for every key; a value that is not plain is
 * written with the replacer, so its tags and errors are unchanged.
 */
const PLAIN_MAX_DEPTH = 64;

function isPlainJson(v: unknown, depth = 0): boolean {
  // Deeper than any payload: a cycle, which the replacer path then reports as `JSON.stringify` does (a TypeError).
  if (depth > PLAIN_MAX_DEPTH) return false;
  switch (typeof v) {
    case 'number':
      return Number.isFinite(v);
    case 'string':
    case 'boolean':
    case 'undefined':
      return true;
    case 'object': {
      if (v === null) return true;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) if (!isPlainJson(v[i], depth + 1)) return false;
        return true;
      }
      if (v instanceof Uint8Array || typeof Reflect.get(v, 'toJSON') === 'function') return false;
      const rec = v as Record<string, unknown>;
      // `for…in` visits every own enumerable key JSON.stringify writes (and any inherited one, which only makes the
      // check stricter) without allocating a key list.
      for (const k in rec) if (!isPlainJson(rec[k], depth + 1)) return false;
      return true;
    }
    default:
      return false;
  }
}

/** `JSON.stringify(v, replacer)`, without the replacer's cost when `v` is plain JSON. */
function stringify(v: unknown): string {
  return isPlainJson(v) ? JSON.stringify(v) : JSON.stringify(v, replacer);
}

export function wrapDataFile(key: string, payload: unknown): string {
  const json = stringify(payload);
  if (json === undefined) {
    throw new OtelHtmlError('invalid-report', {
      path: key,
      expected: 'a JSON-serializable payload',
      actual: 'undefined',
    });
  }
  return `${REGISTRATION_GLOBAL}.push(${escapeHostile(JSON.stringify(key))},${escapeHostile(json)}${SUFFIX}`;
}

/**
 * `wrapDataFile(key, { ...head, [listKey]: items })` in pieces, one per item, so a large file is never one string
 * (with `writePiecesAtomic`). `head` must not hold `listKey`.
 */
export function* wrapDataFilePieces(
  key: string,
  head: Record<string, unknown>,
  listKey: string,
  items: Iterable<unknown>,
): Generator<string, void, void> {
  const open = stringify(head);
  const fields = open === '{}' ? '{' : `${open.slice(0, -1)},`;
  yield `${REGISTRATION_GLOBAL}.push(${escapeHostile(JSON.stringify(key))},${escapeHostile(fields)}${escapeHostile(JSON.stringify(listKey))}:[`;
  let i = 0;
  for (const item of items) {
    const json = stringify(item);
    if (json === undefined) {
      throw new OtelHtmlError('invalid-report', {
        path: `${listKey}[${i}]`,
        expected: 'a JSON-serializable payload',
        actual: 'undefined',
      });
    }
    yield i === 0 ? escapeHostile(json) : `,${escapeHostile(json)}`;
    i++;
  }
  yield `]}${SUFFIX}`;
}

function excerpt(s: string): string {
  return JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}...` : s);
}

/**
 * Node-side reader: validates the exact prefix (global, `push`, key) and suffix, then parses the payload.
 * Returns the raw JSON (`{"$i"}` / `{"$b"}` tags intact; see `reviveDataJson`).
 */
export function unwrapDataFile(text: string, expectedKey: string): unknown {
  const prefix = `${REGISTRATION_GLOBAL}.push(${escapeHostile(JSON.stringify(expectedKey))},`;
  if (!text.startsWith(prefix)) {
    throw new OtelHtmlError('invalid-report', {
      path: 'prefix',
      expected: `text starting with ${prefix}`,
      actual: excerpt(text),
    });
  }
  if (!text.endsWith(SUFFIX) || text.length < prefix.length + SUFFIX.length) {
    throw new OtelHtmlError('invalid-report', {
      path: 'suffix',
      expected: JSON.stringify(SUFFIX),
      actual: excerpt(text.slice(-20)),
    });
  }
  const body = text.slice(prefix.length, text.length - SUFFIX.length);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new OtelHtmlError('invalid-report', {
      path: 'payload',
      expected: 'valid JSON',
      actual: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Turn `{"$i":"…"}` into bigint and `{"$b":"…"}` into Uint8Array, anywhere in a parsed payload. */
export function reviveDataJson(v: unknown, path = '(root)'): unknown {
  // Chunks hold millions of cells: walk without building a path per node, and only on a malformed tag walk
  // again with paths so the error names where it is.
  try {
    return reviveFast(v);
  } catch (e) {
    if (!(e instanceof OtelHtmlError)) throw e;
    return reviveWithPaths(v, path);
  }
}

function reviveFast(v: unknown): unknown {
  if (Array.isArray(v)) {
    const out = new Array<unknown>(v.length);
    for (let i = 0; i < v.length; i++) out[i] = reviveFast(v[i]);
    return out;
  }
  if (typeof v !== 'object' || v === null) return v;
  const keys = Object.keys(v);
  const rec = v as Record<string, unknown>;
  if (keys.length === 1 && (keys[0] === '$i' || keys[0] === '$b')) return reviveWithPaths(v, '');
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = reviveFast(rec[k]);
  return out;
}

function reviveWithPaths(v: unknown, path: string): unknown {
  if (Array.isArray(v)) return v.map((x, i) => reviveWithPaths(x, `${path}[${i}]`));
  if (typeof v !== 'object' || v === null) return v;
  const entries = Object.entries(v);
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only !== undefined && only[0] === '$i') {
    if (typeof only[1] !== 'string' || !/^-?[0-9]+$/.test(only[1])) {
      throw new OtelHtmlError('invalid-report', {
        path,
        expected: '{"$i": "<decimal integer>"}',
        actual: JSON.stringify(v),
      });
    }
    return BigInt(only[1]);
  }
  if (only !== undefined && only[0] === '$b') {
    if (typeof only[1] !== 'string') {
      throw new OtelHtmlError('invalid-report', {
        path,
        expected: '{"$b": "<base64>"}',
        actual: JSON.stringify(v),
      });
    }
    return base64ToBytes(only[1], path);
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of entries) out[k] = reviveWithPaths(x, path === '(root)' ? k : `${path}.${k}`);
  return out;
}
