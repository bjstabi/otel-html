import { z } from 'zod';
import type { AnyValue, Attributes } from '../model/anyvalue.js';
import { bytesToBase64 } from '../model/bytes.js';
import { assertNever, OtelHtmlError } from '../model/errors.js';
import type { SpanId, TraceId } from '../model/ids.js';
import type { ResourceRecord, ScopeRecord } from '../model/records.js';
import { base64ToBytes } from './data-file.js';
import { parseWith } from './validate.js';

/**
 * Columnar chunk codec. A chunk is `n` rows of one record type, stored column by column:
 *
 * - `dict`: one string table per chunk, ordered by use count so hot entries get short indexes. Names,
 *   attribute keys, string values, trace ids, and the serialized form of every `json` cell live here.
 * - `relnanos`: delta-encoded against the previous cell of the same column (the first against `base`).
 * - `ref`: resource/scope references, renumbered per chunk to index `resources`/`scopes`.
 * - Values JSON cannot carry exactly are tagged: `{"$i":"<decimal>"}` (int64 beyond 2^53) and
 *   `{"$b":"<base64>"}` (bytes). The encoded payload is plain JSON, so it survives `JSON.stringify`.
 */

type ColumnKind =
  | 'traceId'
  | 'spanId'
  | 'nullableSpanId'
  | 'nullableTraceId'
  | 'dict'
  | 'relnanos'
  | 'nullableRelnanos'
  | 'int'
  | 'bool'
  | 'anyvalue'
  | 'attrs'
  | 'json'
  | 'ref';

interface ColumnDef<R> {
  readonly name: keyof R & string;
  readonly kind: ColumnKind;
  /** `dict` columns only: the closed set of allowed values (enum-like string unions). */
  readonly oneOf?: readonly string[];
}

export interface ColumnSpec<R> {
  readonly columns: readonly ColumnDef<R>[];
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface ColumnarPayload {
  v: 1;
  n: number;
  dict: string[];
  base: number;
  cols: Record<string, unknown[]>;
  /** Resource/scope tables in their encoded (JSON) form. */
  resources: JsonValue[];
  scopes: JsonValue[];
}

export interface DecodedColumns<R> {
  rows: R[];
  resources: ResourceRecord[];
  scopes: ScopeRecord[];
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function withPathPrefix(e: OtelHtmlError, prefix: string): OtelHtmlError {
  return new OtelHtmlError(e.code, {
    path: `${prefix}${e.path ?? ''}`,
    ...(e.expected === undefined ? {} : { expected: e.expected }),
    ...(e.actual === undefined ? {} : { actual: e.actual }),
    ...(e.hint === undefined ? {} : { hint: e.hint }),
  });
}

/** A field path, or a function building it: the encode passes build paths only for errors. */
type Path = string | (() => string);
const pathText = (p: Path): string => (typeof p === 'string' ? p : p());

function bad(path: Path, expected: string, actual: unknown): OtelHtmlError {
  const shown = actual === undefined ? 'nothing (missing)' : (JSON.stringify(actual) ?? String(actual));
  return new OtelHtmlError('invalid-report', {
    path: pathText(path),
    expected,
    actual: shown.length > 80 ? `${shown.slice(0, 77)}...` : shown,
  });
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const INT_TAG_RE = /^-?[0-9]+$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Tag payload keys, declared so they can be read by name under noPropertyAccessFromIndexSignature. */
interface Tagged {
  readonly $i?: unknown;
  readonly $b?: unknown;
  readonly $d?: unknown;
  readonly $m?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `{"$i": "..."}` -> bigint, or null when `v` is not an int tag. */
function intTag(v: unknown, path: string): bigint | null {
  if (!isRecord(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== '$i') return null;
  const s = (v as Tagged).$i;
  if (typeof s !== 'string' || !INT_TAG_RE.test(s)) throw bad(path, '{"$i": "<decimal integer>"}', v);
  return BigInt(s);
}

function bytesTag(v: unknown, path: string): Uint8Array | null {
  if (!isRecord(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== '$b') return null;
  const s = (v as Tagged).$b;
  if (typeof s !== 'string') throw bad(path, '{"$b": "<base64>"}', v);
  return base64ToBytes(s, path);
}

function jsonToDouble(v: unknown, path: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v === '-0') return -0;
  if (v === 'NaN') return Number.NaN;
  if (v === 'Infinity') return Number.POSITIVE_INFINITY;
  if (v === '-Infinity') return Number.NEGATIVE_INFINITY;
  throw bad(path, 'a finite number or "-0" | "NaN" | "Infinity" | "-Infinity"', v);
}

function decodeJson(v: unknown, path: string): unknown {
  if (typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) return v.map((x, i) => decodeJson(x, `${path}[${i}]`));
  const big = intTag(v, path);
  if (big !== null) return big;
  const bytes = bytesTag(v, path);
  if (bytes !== null) return bytes;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec);
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only === '$d') return jsonToDouble((rec as Tagged).$d, path);
  if (only === '$m') {
    const entries = (rec as Tagged).$m;
    if (!Array.isArray(entries)) throw bad(path, '{"$m": [[key, value], ...]}', v);
    const map = new Map<string, unknown>();
    for (const [i, e] of entries.entries()) {
      if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') {
        throw bad(`${path}.$m[${i}]`, '[string key, value]', e);
      }
      map.set(e[0], decodeJson(e[1], `${path}.$m[${i}]`));
    }
    return map;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(rec)) out[k] = decodeJson(x, `${path}.${k}`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// AnyValue and attributes (dictionary-coded)
// ---------------------------------------------------------------------------------------------
// string -> dict index (a bare number); bool -> bool; empty -> null; int -> [0, n] (or {"$i"} beyond
// 2^53); double -> [1, x]; array -> [2, [...]]; kvlist -> [3, [k, v, k, v, ...]]; bytes -> {"$b"}.

function dictString(dict: readonly string[], idx: unknown, path: string): string {
  const s = typeof idx === 'number' && Number.isInteger(idx) ? dict[idx] : undefined;
  if (s === undefined) throw bad(path, `a dictionary index in [0, ${dict.length})`, idx);
  return s;
}

function decodeAny(v: unknown, dict: readonly string[], path: string): AnyValue {
  if (typeof v === 'number') return { kind: 'string', value: dictString(dict, v, path) };
  if (typeof v === 'boolean') return { kind: 'bool', value: v };
  if (v === null) return { kind: 'empty' };
  const big = intTag(v, path);
  if (big !== null) {
    if (big < INT64_MIN || big > INT64_MAX) throw bad(path, 'an int64', v);
    return { kind: 'int', value: big };
  }
  const bytes = bytesTag(v, path);
  if (bytes !== null) return { kind: 'bytes', value: bytes };
  if (Array.isArray(v) && v.length === 2) {
    const [tag, body] = v;
    switch (tag) {
      case 0:
        if (typeof body === 'number' && Number.isSafeInteger(body))
          return { kind: 'int', value: BigInt(body) };
        throw bad(`${path}[1]`, 'a safe integer', body);
      case 1:
        return { kind: 'double', value: jsonToDouble(body, `${path}[1]`) };
      case 2:
        if (!Array.isArray(body)) throw bad(`${path}[1]`, 'an array of values', body);
        return { kind: 'array', values: body.map((x, i) => decodeAny(x, dict, `${path}[1][${i}]`)) };
      case 3:
        return { kind: 'kvlist', values: decodeAttrs(body, dict, `${path}[1]`) };
      default:
        break;
    }
  }
  throw bad(path, 'an encoded AnyValue', v);
}

function decodeAttrs(v: unknown, dict: readonly string[], path: string): Attributes {
  if (!Array.isArray(v) || v.length % 2 !== 0) throw bad(path, 'a flat [key, value, ...] list', v);
  const out = new Map<string, AnyValue>();
  for (let i = 0; i < v.length; i += 2) {
    out.set(dictString(dict, v[i], `${path}[${i}]`), decodeAny(v[i + 1], dict, `${path}[${i + 1}]`));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Self-contained JSON of AnyValues (format 4's attribute columns)
// ---------------------------------------------------------------------------------------------
// No dictionary. string/bool as is, empty -> null, array -> array, bytes -> {"$b"}. A plain number is an int iff it is
// integral: an int within +-(2^53-1) is a plain number, beyond that {"$i": "<decimal>"}; a double is a plain number
// only when finite, not -0 and not whole, else {"$d": "<text>"} ("2", "-0", "NaN", "Infinity"), so ints and doubles never
// share a spelling and SQL json_extract sees ordinary numbers. A kvlist or attribute set is an object keyed by name; a
// set with a key starting with "$" (or "__proto__") cannot be an object without a key being mistaken for a tag, so it
// takes the {"$m": [[key, value], ...]} form instead. `anyValueFromJson` / `attributesFromJson` are the inverse.

const SAFE_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** A double in format-4 JSON: a plain number only when it cannot be mistaken for an int. */
function doubleToTagged(x: number): JsonValue {
  return Number.isFinite(x) && !Number.isInteger(x) ? x : { $d: Object.is(x, -0) ? '-0' : String(x) };
}

function anyToJson(v: AnyValue): JsonValue {
  switch (v.kind) {
    case 'string':
    case 'bool':
      return v.value;
    case 'empty':
      return null;
    case 'int':
      return v.value >= SAFE_MIN && v.value <= SAFE_MAX ? Number(v.value) : { $i: v.value.toString() };
    case 'double':
      return doubleToTagged(v.value);
    case 'bytes':
      return { $b: bytesToBase64(v.value) };
    case 'array':
      return v.values.map(anyToJson);
    case 'kvlist':
      return attributesToJsonValue(v.values);
    default:
      return assertNever(v, '');
  }
}

export function attributesToJsonValue(a: Attributes): JsonValue {
  let ambiguous = false;
  for (const k of a.keys()) {
    if (k.startsWith('$') || k === '__proto__') {
      ambiguous = true;
      break;
    }
  }
  if (ambiguous) return { $m: [...a].map(([k, x]): JsonValue => [k, anyToJson(x)]) };
  const out: { [k: string]: JsonValue } = {};
  for (const [k, x] of a) out[k] = anyToJson(x);
  return out;
}

/** An attribute set as JSON text: an object keyed by attribute key, values tagged as above. */
export function attributesToJson(a: Attributes): string {
  return JSON.stringify(attributesToJsonValue(a));
}

/** One AnyValue as JSON text, tagged as `attributesToJson`. */
export function anyValueJson(v: AnyValue): string {
  return JSON.stringify(anyToJson(v));
}

/**
 * The JSON text of a value whose numbers are all doubles (a point's exemplars and quantiles, which the model keeps as
 * protobuf JSON: int64 as decimal strings, non-finite doubles as "NaN" | "Infinity" | "-Infinity" strings): each number
 * is tagged as a double is, so a whole-numbered or negative-zero value keeps its type, and other values pass through.
 */
export function doublesJson(v: unknown): string {
  const walk = (x: unknown): JsonValue => {
    if (typeof x === 'number') return doubleToTagged(x);
    if (Array.isArray(x)) return x.map(walk);
    if (typeof x === 'object' && x !== null) {
      const entries = Object.entries(x).filter(([, y]) => y !== undefined);
      if (entries.some(([k]) => k.startsWith('$') || k === '__proto__')) {
        return { $m: entries.map(([k, y]): JsonValue => [k, walk(y)]) };
      }
      const out: { [k: string]: JsonValue } = {};
      for (const [k, y] of entries) out[k] = walk(y);
      return out;
    }
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return x;
    throw bad('', 'a JSON value', typeof x);
  };
  return JSON.stringify(walk(v));
}

const DOUBLE_TEXT_RE = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

function taggedDouble(text: unknown, path: string): number {
  if (typeof text === 'string' && DOUBLE_TEXT_RE.test(text) && Number.isFinite(Number(text)))
    return Number(text);
  return jsonToDouble(text, path); // "-0" | "NaN" | "Infinity" | "-Infinity" (or throws)
}

function anyFromJsonValue(v: unknown, path: string): AnyValue {
  switch (typeof v) {
    case 'string':
      return { kind: 'string', value: v };
    case 'boolean':
      return { kind: 'bool', value: v };
    case 'number':
      if (Number.isInteger(v)) {
        if (!Number.isSafeInteger(v)) throw bad(path, 'an integer within +-(2^53-1), else {"$i"}', v);
        return { kind: 'int', value: BigInt(v) };
      }
      if (!Number.isFinite(v)) throw bad(path, 'a finite number', v);
      return { kind: 'double', value: v };
    case 'object':
      break;
    default:
      throw bad(path, 'a tagged AnyValue', v);
  }
  if (v === null) return { kind: 'empty' };
  if (Array.isArray(v))
    return { kind: 'array', values: v.map((x, i) => anyFromJsonValue(x, `${path}[${i}]`)) };
  const big = intTag(v, path);
  if (big !== null) {
    if (big < INT64_MIN || big > INT64_MAX) throw bad(path, 'an int64', v);
    return { kind: 'int', value: big };
  }
  const bytes = bytesTag(v, path);
  if (bytes !== null) return { kind: 'bytes', value: bytes };
  return objectFromJson(v, path, true);
}

/** An attribute object or `{"$m"}` form. `asValue`: wrap it as a kvlist AnyValue, else the Attributes. */
function objectFromJson(v: object, path: string, asValue: true): AnyValue;
function objectFromJson(v: object, path: string, asValue: false): Attributes;
function objectFromJson(v: object, path: string, asValue: boolean): AnyValue | Attributes {
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec);
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only === '$d') {
    if (!asValue) throw bad(path, 'an attribute set', v);
    return { kind: 'double', value: taggedDouble((rec as Tagged).$d, path) };
  }
  const out = new Map<string, AnyValue>();
  if (only === '$m') {
    const entries = (rec as Tagged).$m;
    if (!Array.isArray(entries)) throw bad(path, '{"$m": [[key, value], ...]}', v);
    for (const [i, e] of entries.entries()) {
      if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') {
        throw bad(`${path}.$m[${i}]`, '[string key, value]', e);
      }
      out.set(e[0], anyFromJsonValue(e[1], `${path}.$m[${i}]`));
    }
  } else {
    for (const [k, x] of Object.entries(rec)) {
      if (k.startsWith('$')) throw bad(`${path}.${k}`, 'a key not starting with "$" (tags only)', k);
      out.set(k, anyFromJsonValue(x, `${path}.${k}`));
    }
  }
  return asValue ? { kind: 'kvlist', values: out } : out;
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw bad('', 'JSON text', text);
  }
}

/** Inverse of `anyValueJson`. Throws `invalid-report` on malformed or mis-tagged JSON. */
export function anyValueFromJson(text: string): AnyValue {
  return anyFromJsonValue(parseText(text), '');
}

/** Inverse of `attributesToJson`. Throws `invalid-report` on malformed or mis-tagged JSON. */
export function attributesFromJson(text: string): Attributes {
  const v = parseText(text);
  if (!isRecord(v)) throw bad('', 'an attribute object', v);
  return objectFromJson(v, '', false);
}

function count(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw bad(path, 'a non-negative integer', v);
  return v;
}

interface TableEntryWire {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly attributes?: unknown;
  readonly droppedAttributesCount?: unknown;
  readonly schemaUrl?: unknown;
}

function entryRecord(v: unknown, path: string): TableEntryWire {
  if (!isRecord(v)) throw bad(path, 'an object', v);
  return v;
}

function decodeResource(v: unknown, dict: readonly string[], path: string): ResourceRecord {
  const r = entryRecord(v, path);
  return {
    attributes: decodeAttrs(r.attributes, dict, `${path}.attributes`),
    droppedAttributesCount: count(r.droppedAttributesCount, `${path}.droppedAttributesCount`),
    schemaUrl: dictString(dict, r.schemaUrl, `${path}.schemaUrl`),
  };
}

function decodeScope(v: unknown, dict: readonly string[], path: string): ScopeRecord {
  const r = entryRecord(v, path);
  return {
    name: dictString(dict, r.name, `${path}.name`),
    version: dictString(dict, r.version, `${path}.version`),
    attributes: decodeAttrs(r.attributes, dict, `${path}.attributes`),
    droppedAttributesCount: count(r.droppedAttributesCount, `${path}.droppedAttributesCount`),
    schemaUrl: dictString(dict, r.schemaUrl, `${path}.schemaUrl`),
  };
}

// ---------------------------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------------------------

type RefTarget = 'resource' | 'scope';

function refTarget(name: string): RefTarget {
  if (name === 'resource' || name === 'scope') return name;
  throw bad(`spec.${name}`, 'a "ref" column named "resource" or "scope"', name);
}

function safeInt(v: unknown, path: Path): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw bad(path, 'a safe integer', v);
  return v;
}

function hexId(v: unknown, re: RegExp, what: string, path: Path): string {
  if (typeof v !== 'string' || !re.test(v)) throw bad(path, what, v);
  return v;
}

// ---------------------------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------------------------

const PayloadSchema: z.ZodType<ColumnarPayload> = z.strictObject({
  v: z.literal(1),
  n: z.number().int().nonnegative(),
  dict: z.array(z.string()),
  base: z.number().int(),
  cols: z.record(z.string(), z.array(z.unknown())),
  resources: z.array(z.custom<JsonValue>(() => true)),
  scopes: z.array(z.custom<JsonValue>(() => true)),
});

interface DecodeContext {
  readonly dict: readonly string[];
  readonly resources: readonly ResourceRecord[];
  readonly scopes: readonly ScopeRecord[];
  prev: number;
}

function decodeCell(
  def: { readonly name: string; readonly kind: ColumnKind; readonly oneOf?: readonly string[] | undefined },
  cell: unknown,
  path: string,
  ctx: DecodeContext,
): unknown {
  switch (def.kind) {
    case 'traceId':
      return hexId(dictString(ctx.dict, cell, path), TRACE_ID_RE, '32 lowercase hex chars', path) as TraceId;
    case 'nullableTraceId':
      return cell === null
        ? null
        : (hexId(dictString(ctx.dict, cell, path), TRACE_ID_RE, '32 lowercase hex chars', path) as TraceId);
    case 'spanId':
      return hexId(cell, SPAN_ID_RE, '16 lowercase hex chars', path) as SpanId;
    case 'nullableSpanId':
      return cell === null
        ? null
        : (hexId(cell, SPAN_ID_RE, '16 lowercase hex chars or null', path) as SpanId);
    case 'dict': {
      const s = dictString(ctx.dict, cell, path);
      if (def.oneOf !== undefined && !def.oneOf.includes(s)) {
        throw bad(path, def.oneOf.map((x) => JSON.stringify(x)).join(' | '), s);
      }
      return s;
    }
    case 'relnanos':
    case 'nullableRelnanos': {
      if (cell === null && def.kind === 'nullableRelnanos') return null;
      const big = intTag(cell, path);
      const t =
        big !== null
          ? Number(BigInt(ctx.prev) + big)
          : typeof cell === 'number' && Number.isSafeInteger(cell)
            ? ctx.prev + cell
            : Number.NaN;
      if (!Number.isSafeInteger(t)) throw bad(path, 'a time delta landing on a safe integer', cell);
      ctx.prev = t;
      return t;
    }
    case 'int':
      return safeInt(cell, path);
    case 'bool':
      if (typeof cell !== 'boolean') throw bad(path, 'a boolean', cell);
      return cell;
    case 'anyvalue':
      return decodeAny(cell, ctx.dict, path);
    case 'attrs':
      return decodeAttrs(cell, ctx.dict, path);
    case 'json': {
      const text = dictString(ctx.dict, cell, path);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw bad(path, 'a dictionary entry holding valid JSON', text);
      }
      return decodeJson(parsed, path);
    }
    case 'ref': {
      const target = refTarget(def.name);
      const len = target === 'resource' ? ctx.resources.length : ctx.scopes.length;
      if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell >= len) {
        throw bad(path, `a ${target} ref in [0, ${len})`, cell);
      }
      return cell;
    }
    default:
      return assertNever(def.kind, path);
  }
}

export function decodeColumns<R>(spec: ColumnSpec<R>, payload: unknown): DecodedColumns<R> {
  const p = parseWith(PayloadSchema, payload, '');
  const resources = p.resources.map((r, i) => decodeResource(r, p.dict, `resources[${i}]`));
  const scopes = p.scopes.map((s, i) => decodeScope(s, p.dict, `scopes[${i}]`));
  const decoded = spec.columns.map((col) => {
    const cells = p.cols[col.name];
    if (cells === undefined) throw bad(`cols.${col.name}`, 'a column array', undefined);
    if (cells.length !== p.n) throw bad(`cols.${col.name}`, `${p.n} cells (n)`, `${cells.length} cells`);
    const ctx: DecodeContext = { dict: p.dict, resources, scopes, prev: p.base };
    // Cells decode against an empty path; only a failing cell pays for building its `cols.<name>[i]` prefix.
    const values = cells.map((c, i) => {
      try {
        return decodeCell(col, c, '', ctx);
      } catch (e) {
        throw e instanceof OtelHtmlError ? withPathPrefix(e, `cols.${col.name}[${i}]`) : e;
      }
    });
    return { name: col.name, values };
  });
  const rows: R[] = [];
  for (let i = 0; i < p.n; i++) {
    const row: Record<string, unknown> = {};
    for (const { name, values } of decoded) row[name] = values[i];
    rows.push(row as R);
  }
  return { rows, resources, scopes };
}
