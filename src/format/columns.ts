import { z } from 'zod';
import type { AnyValue, Attributes } from '../model/anyvalue.js';
import { assertNever, OtelHtmlError } from '../model/errors.js';
import type { SpanId, TraceId } from '../model/ids.js';
import type { ResourceRecord, ScopeRecord } from '../model/records.js';
import { base64ToBytes, bytesToBase64 } from './data-file.js';
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

export type ColumnKind =
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

export interface ColumnDef<R> {
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

function bad(path: string, expected: string, actual: unknown): OtelHtmlError {
  const shown = actual === undefined ? 'nothing (missing)' : (JSON.stringify(actual) ?? String(actual));
  return new OtelHtmlError('invalid-report', {
    path,
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

function doubleToJson(x: number): JsonValue {
  if (Number.isFinite(x) && !Object.is(x, -0)) return x;
  return Object.is(x, -0) ? '-0' : String(x);
}

function jsonToDouble(v: unknown, path: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v === '-0') return -0;
  if (v === 'NaN') return Number.NaN;
  if (v === 'Infinity') return Number.POSITIVE_INFINITY;
  if (v === '-Infinity') return Number.NEGATIVE_INFINITY;
  throw bad(path, 'a finite number or "-0" | "NaN" | "Infinity" | "-Infinity"', v);
}

/** Interning function: encode passes call it; pass 1 counts, pass 2 returns the final index. */
type Intern = (s: string) => number;

// ---------------------------------------------------------------------------------------------
// Generic JSON (events, links, status, metric points)
// ---------------------------------------------------------------------------------------------
// Plain JSON stays as is. Anything JSON cannot carry exactly is tagged: bigint -> {"$i"}, Uint8Array ->
// {"$b"}, Map -> {"$m": [[k, v], ...]}, non-finite/-0 numbers -> {"$d": "<text>"}.

function encodeJson(v: unknown, path: string): JsonValue {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) && !Object.is(v, -0) ? v : { $d: Object.is(v, -0) ? '-0' : String(v) };
    case 'bigint':
      return { $i: v.toString() };
    case 'object': {
      if (v === null) return null;
      if (v instanceof Uint8Array) return { $b: bytesToBase64(v) };
      if (v instanceof Map) {
        const out: JsonValue[] = [];
        for (const [k, x] of v) {
          if (typeof k !== 'string') throw bad(`${path}.<map key>`, 'a string key', k);
          out.push([k, encodeJson(x, `${path}[${JSON.stringify(k)}]`)]);
        }
        return { $m: out };
      }
      if (Array.isArray(v)) return v.map((x, i) => encodeJson(x, `${path}[${i}]`));
      const out: { [k: string]: JsonValue } = {};
      for (const [k, x] of Object.entries(v)) {
        if (k.startsWith('$'))
          throw bad(`${path}.${k}`, 'a key not starting with "$" (reserved for tags)', k);
        if (x !== undefined) out[k] = encodeJson(x, `${path}.${k}`);
      }
      return out;
    }
    default:
      throw bad(path, 'a JSON-serializable value', typeof v);
  }
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

function encodeAny(v: AnyValue, d: Intern, path: string): JsonValue {
  switch (v.kind) {
    case 'string':
      return d(v.value);
    case 'bool':
      return v.value;
    case 'empty':
      return null;
    case 'int':
      return v.value >= BigInt(Number.MIN_SAFE_INTEGER) && v.value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? [0, Number(v.value)]
        : { $i: v.value.toString() };
    case 'double':
      return [1, doubleToJson(v.value)];
    case 'bytes':
      return { $b: bytesToBase64(v.value) };
    case 'array':
      return [2, v.values.map((x, i) => encodeAny(x, d, `${path}[${i}]`))];
    case 'kvlist':
      return [3, encodeAttrs(v.values, d, path)];
    default:
      return assertNever(v, path);
  }
}

function encodeAttrs(a: Attributes, d: Intern, path: string): JsonValue[] {
  const out: JsonValue[] = [];
  for (const [k, v] of a) out.push(d(k), encodeAny(v, d, `${path}[${JSON.stringify(k)}]`));
  return out;
}

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
// Resource / scope tables
// ---------------------------------------------------------------------------------------------

function encodeResource(r: ResourceRecord, d: Intern, path: string): JsonValue {
  return {
    attributes: encodeAttrs(r.attributes, d, `${path}.attributes`),
    droppedAttributesCount: r.droppedAttributesCount,
    schemaUrl: d(r.schemaUrl),
  };
}

function encodeScope(s: ScopeRecord, d: Intern, path: string): JsonValue {
  return {
    name: d(s.name),
    version: d(s.version),
    attributes: encodeAttrs(s.attributes, d, `${path}.attributes`),
    droppedAttributesCount: s.droppedAttributesCount,
    schemaUrl: d(s.schemaUrl),
  };
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

function isRelKind(k: ColumnKind): boolean {
  return k === 'relnanos' || k === 'nullableRelnanos';
}

function cellOf(row: unknown, name: string): unknown {
  return (row as Record<string, unknown>)[name];
}

function safeInt(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw bad(path, 'a safe integer', v);
  return v;
}

function hexId(v: unknown, re: RegExp, what: string, path: string): string {
  if (typeof v !== 'string' || !re.test(v)) throw bad(path, what, v);
  return v;
}

type PassResult = Omit<ColumnarPayload, 'dict'>;

function encodePass<R>(
  spec: ColumnSpec<R>,
  rows: readonly R[],
  resources: readonly ResourceRecord[],
  scopes: readonly ScopeRecord[],
  d: Intern,
): PassResult {
  // base for delta-encoded times: the smallest time anywhere in the chunk
  let base = Number.POSITIVE_INFINITY;
  for (const col of spec.columns) {
    if (!isRelKind(col.kind)) continue;
    for (const [i, row] of rows.entries()) {
      const v = cellOf(row, col.name);
      if (v === null && col.kind === 'nullableRelnanos') continue;
      base = Math.min(base, safeInt(v, `rows[${i}].${col.name}`));
    }
  }
  if (!Number.isFinite(base)) base = 0;

  const used: Record<RefTarget, Map<number, number>> = { resource: new Map(), scope: new Map() };
  const tables: Record<RefTarget, readonly unknown[]> = { resource: resources, scope: scopes };
  const cols: Record<string, unknown[]> = {};
  for (const col of spec.columns) {
    const out: unknown[] = [];
    let prev = base;
    for (const [i, row] of rows.entries()) {
      const path = `rows[${i}].${col.name}`;
      const v = cellOf(row, col.name);
      switch (col.kind) {
        case 'traceId':
          out.push(d(hexId(v, TRACE_ID_RE, '32 lowercase hex chars', path)));
          break;
        case 'nullableTraceId':
          out.push(v === null ? null : d(hexId(v, TRACE_ID_RE, '32 lowercase hex chars or null', path)));
          break;
        case 'spanId':
          out.push(hexId(v, SPAN_ID_RE, '16 lowercase hex chars', path));
          break;
        case 'nullableSpanId':
          out.push(v === null ? null : hexId(v, SPAN_ID_RE, '16 lowercase hex chars or null', path));
          break;
        case 'dict': {
          if (typeof v !== 'string') throw bad(path, 'a string', v);
          if (col.oneOf !== undefined && !col.oneOf.includes(v)) {
            throw bad(path, col.oneOf.map((x) => JSON.stringify(x)).join(' | '), v);
          }
          out.push(d(v));
          break;
        }
        case 'relnanos':
        case 'nullableRelnanos': {
          if (v === null && col.kind === 'nullableRelnanos') {
            out.push(null);
            break;
          }
          const t = safeInt(v, path);
          const delta = t - prev;
          out.push(Number.isSafeInteger(delta) ? delta : { $i: (BigInt(t) - BigInt(prev)).toString() });
          prev = t;
          break;
        }
        case 'int':
          out.push(safeInt(v, path));
          break;
        case 'bool':
          if (typeof v !== 'boolean') throw bad(path, 'a boolean', v);
          out.push(v);
          break;
        case 'anyvalue':
          out.push(encodeAny(v as AnyValue, d, path));
          break;
        case 'attrs':
          if (!(v instanceof Map)) throw bad(path, 'an attribute map', v);
          out.push(encodeAttrs(v as Attributes, d, path));
          break;
        case 'json':
          out.push(d(JSON.stringify(encodeJson(v, path))));
          break;
        case 'ref': {
          const target = refTarget(col.name);
          const ref = safeInt(v, path);
          const table = tables[target];
          if (ref < 0 || ref >= table.length) throw bad(path, `a ${target} ref in [0, ${table.length})`, ref);
          const map = used[target];
          let local = map.get(ref);
          if (local === undefined) {
            local = map.size;
            map.set(ref, local);
          }
          out.push(local);
          break;
        }
        default:
          return assertNever(col.kind, path);
      }
    }
    cols[col.name] = out;
  }

  const pick = <T>(target: RefTarget, table: readonly T[]): T[] =>
    [...used[target].keys()].map((ref) => {
      const item = table[ref];
      if (item === undefined) throw bad(`${target}s[${ref}]`, 'an existing table entry', ref);
      return item;
    });
  return {
    v: 1,
    n: rows.length,
    base,
    cols,
    resources: pick('resource', resources).map((r, i) => encodeResource(r, d, `resources[${i}]`)),
    scopes: pick('scope', scopes).map((s, i) => encodeScope(s, d, `scopes[${i}]`)),
  };
}

export function encodeColumns<R>(
  spec: ColumnSpec<R>,
  rows: readonly R[],
  resources: readonly ResourceRecord[],
  scopes: readonly ScopeRecord[],
): ColumnarPayload {
  // Pass 1 counts uses; the dictionary is then ordered by use count (ties by first use) so the hottest
  // strings get the shortest indexes. Pass 2 encodes against the final order.
  const counts = new Map<string, number>();
  encodePass(spec, rows, resources, scopes, (s) => {
    counts.set(s, (counts.get(s) ?? 0) + 1);
    return 0;
  });
  const dict = [...counts.keys()]
    .map((s, first) => ({ s, first, uses: counts.get(s) ?? 0 }))
    .sort((a, b) => b.uses - a.uses || a.first - b.first)
    .map((e) => e.s);
  const index = new Map(dict.map((s, i) => [s, i] as const));
  const out = encodePass(spec, rows, resources, scopes, (s) => {
    const i = index.get(s);
    if (i === undefined) throw new Error(`invariant violated: string missing from dictionary: ${s}`);
    return i;
  });
  return { ...out, dict };
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
