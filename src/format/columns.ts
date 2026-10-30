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

/** A value whose encoding cannot fail: its child path is never read, so none is built for it. */
function isScalar(x: unknown): boolean {
  const t = typeof x;
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint';
}

function encodeJson(v: unknown, path: Path): JsonValue {
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
          if (typeof k !== 'string') throw bad(() => `${pathText(path)}.<map key>`, 'a string key', k);
          out.push([k, encodeJson(x, isScalar(x) ? path : () => `${pathText(path)}[${JSON.stringify(k)}]`)]);
        }
        return { $m: out };
      }
      if (Array.isArray(v))
        return v.map((x, i) => encodeJson(x, isScalar(x) ? path : () => `${pathText(path)}[${i}]`));
      const out: { [k: string]: JsonValue } = {};
      for (const [k, x] of Object.entries(v)) {
        if (k.startsWith('$'))
          throw bad(() => `${pathText(path)}.${k}`, 'a key not starting with "$" (reserved for tags)', k);
        if (x !== undefined) out[k] = encodeJson(x, isScalar(x) ? path : () => `${pathText(path)}.${k}`);
      }
      return out;
    }
    default:
      throw bad(path, 'a JSON-serializable value', typeof v);
  }
}

/**
 * `JSON.stringify(encodeJson(v))` of a flat plain object whose values are strings, booleans, null or finite numbers
 * other than -0, and whose keys do not start with "$" (a number point's JSON, nearly every metric cell): `encodeJson`
 * would copy it unchanged. Null for any other value, which `encodeJson` encodes.
 */
function flatJsonText(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Object.getPrototypeOf(v) !== Object.prototype) return null;
  const rec = v as Record<string, unknown>;
  for (const k in rec) {
    if (k.startsWith('$')) return null;
    const x = rec[k];
    switch (typeof x) {
      case 'string':
      case 'boolean':
        break;
      case 'number':
        if (!Number.isFinite(x) || Object.is(x, -0)) return null;
        break;
      case 'object':
        if (x !== null) return null;
        break;
      default:
        return null;
    }
  }
  return JSON.stringify(v);
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

function encodeAny(v: AnyValue, d: Intern, path: Path): JsonValue {
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
      return [2, v.values.map((x, i) => encodeAny(x, d, () => `${pathText(path)}[${i}]`))];
    case 'kvlist':
      return [3, encodeAttrs(v.values, d, path)];
    default:
      return assertNever(v, pathText(path));
  }
}

function encodeAttrs(a: Attributes, d: Intern, path: Path): JsonValue[] {
  // Sized up front: a chunk keeps one per row until it is encoded, and grown arrays carry spare capacity.
  const out: JsonValue[] = new Array(a.size * 2);
  let i = 0;
  for (const [k, v] of a) {
    // Only a nested value can fail (and then names `[key]` in its path); a string, bool, int, double, bytes or empty
    // value always encodes, so building a path for it would be wasted work per cell.
    const at =
      v.kind === 'array' || v.kind === 'kvlist' ? () => `${pathText(path)}[${JSON.stringify(k)}]` : path;
    out[i++] = d(k);
    out[i++] = encodeAny(v, d, at);
  }
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

function safeInt(v: unknown, path: Path): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw bad(path, 'a safe integer', v);
  return v;
}

function hexId(v: unknown, re: RegExp, what: string, path: Path): string {
  if (typeof v !== 'string' || !re.test(v)) throw bad(path, what, v);
  return v;
}

/**
 * Encodes a chunk's rows. The dictionary is ordered by use count (ties by first use, column by column, then the
 * tables) so the hottest strings get the shortest indexes; `ColumnEncoder` does the work, one row at a time.
 */
export function encodeColumns<R>(
  spec: ColumnSpec<R>,
  rows: readonly R[],
  resources: readonly ResourceRecord[],
  scopes: readonly ScopeRecord[],
): ColumnarPayload {
  const encoder = new ColumnEncoder(spec);
  for (const row of rows) encoder.push(row);
  return encoder.finish(resources, scopes);
}

/** A provisional dictionary id's final index (`remapAny` walks encoded AnyValues: bare numbers are dict ids). */
function remapAny(v: JsonValue, perm: Int32Array): JsonValue {
  if (typeof v === 'number') return perm[v] ?? -1;
  if (!Array.isArray(v)) return v; // bool, null, {"$i"}, {"$b"}
  const body = v[1] ?? null;
  if (v[0] === 2 && Array.isArray(body)) return [2, body.map((x) => remapAny(x, perm))];
  if (v[0] === 3 && Array.isArray(body)) return [3, remapAttrs(body, perm)];
  return v; // [0, int], [1, double]
}

function remapAttrs(a: JsonValue[], perm: Int32Array): JsonValue[] {
  const out: JsonValue[] = new Array(a.length);
  for (let i = 0; i < a.length; i += 2) {
    out[i] = perm[a[i] as number] ?? -1;
    out[i + 1] = remapAny(a[i + 1] ?? null, perm);
  }
  return out;
}

/**
 * Encodes rows as they arrive, strings against a provisional dictionary, so a buffered chunk holds compact cells
 * instead of row objects. `finish` orders the dictionary by use count, ties by first use column by column (all rows
 * of a column before the next column), then the tables, and remaps the cells to it.
 */
export class ColumnEncoder<R> {
  readonly #spec: ColumnSpec<R>;
  #n = 0;
  #cols: unknown[][];
  readonly #ids = new Map<string, number>();
  readonly #strings: string[] = [];
  readonly #uses: number[] = [];
  /** First use of each string, as (column, row, sequence within the cell). */
  readonly #firstCol: number[] = [];
  readonly #firstRow: number[] = [];
  readonly #firstSeq: number[] = [];
  // Per-row scratch, reused so a row costs no closures or arrays beyond its cells:
  /** (id, column, sequence) of each string the current row used, committed once the row encodes. */
  readonly #pending: number[] = [];
  #pendingLength = 0;
  #col = 0;
  #seq = 0;
  readonly #intern: Intern;
  readonly #path: () => string;

  constructor(spec: ColumnSpec<R>) {
    this.#spec = spec;
    this.#cols = spec.columns.map(() => []);
    this.#intern = (str) => {
      let id = this.#ids.get(str);
      if (id === undefined) {
        id = this.#strings.length;
        this.#ids.set(str, id);
        this.#strings.push(str);
        this.#uses.push(0);
        this.#firstCol.push(Number.POSITIVE_INFINITY);
        this.#firstRow.push(0);
        this.#firstSeq.push(0);
      }
      const k = this.#pendingLength;
      this.#pending[k] = id;
      this.#pending[k + 1] = this.#col;
      this.#pending[k + 2] = this.#seq++;
      this.#pendingLength = k + 3;
      return id;
    };
    // read only while a cell is being rejected, so the cursor is that cell's
    this.#path = () => `rows[${this.#n}].${this.#spec.columns[this.#col]?.name ?? ''}`;
  }

  get length(): number {
    return this.#n;
  }

  /** Encodes one row; an invalid cell throws (naming `rows[<index>]`) and leaves the encoder unchanged. */
  push(row: R): void {
    const columns = this.#spec.columns;
    const r = this.#n;
    this.#pendingLength = 0;
    try {
      for (this.#col = 0; this.#col < columns.length; this.#col++) {
        const col = columns[this.#col] as ColumnDef<R>;
        this.#seq = 0;
        (this.#cols[this.#col] as unknown[]).push(
          encodeCell(col, cellOf(row, col.name), this.#intern, this.#path),
        );
      }
    } catch (e) {
      for (const cells of this.#cols) cells.length = r; // drop the row's cells encoded before the failure
      throw e;
    }
    const pending = this.#pending;
    for (let k = 0; k < this.#pendingLength; k += 3) {
      const id = pending[k] as number;
      const c = pending[k + 1] as number;
      const q = pending[k + 2] as number;
      this.#uses[id] = (this.#uses[id] ?? 0) + 1;
      const fc = this.#firstCol[id] ?? Number.POSITIVE_INFINITY;
      // rows arrive in order, so an earlier first use in the same column is always in an earlier row
      if (c < fc || (c === fc && this.#firstRow[id] === r && q < (this.#firstSeq[id] ?? 0))) {
        this.#firstCol[id] = c;
        this.#firstRow[id] = r;
        this.#firstSeq[id] = q;
      }
    }
    this.#n++;
  }

  /** The payload of the rows pushed so far (the encoder is unchanged). */
  finish(resources: readonly ResourceRecord[], scopes: readonly ScopeRecord[]): ColumnarPayload {
    const columns = this.#spec.columns;
    const tables: Record<RefTarget, readonly unknown[]> = { resource: resources, scope: scopes };
    const used: Record<RefTarget, Map<number, number>> = { resource: new Map(), scope: new Map() };
    const refCols = new Map<number, number[]>();
    for (const [ci, col] of columns.entries()) {
      if (col.kind !== 'ref') continue;
      const target = refTarget(col.name);
      const table = tables[target];
      const map = used[target];
      const local: number[] = new Array(this.#n);
      for (const [i, ref] of (this.#cols[ci] as number[]).entries()) {
        if (ref < 0 || ref >= table.length) {
          throw bad(`rows[${i}].${col.name}`, `a ${target} ref in [0, ${table.length})`, ref);
        }
        let l = map.get(ref);
        if (l === undefined) {
          l = map.size;
          map.set(ref, l);
        }
        local[i] = l;
      }
      refCols.set(ci, local);
    }
    const pick = <T>(target: RefTarget, table: readonly T[]): T[] =>
      [...used[target].keys()].map((ref) => {
        const item = table[ref];
        if (item === undefined) throw bad(`${target}s[${ref}]`, 'an existing table entry', ref);
        return item;
      });
    const pickedResources = pick('resource', resources);
    const pickedScopes = pick('scope', scopes);

    // The tables' strings, counted after every column
    const strings = this.#strings.slice();
    const uses = this.#uses.slice();
    const firstCol = this.#firstCol.slice();
    const firstSeq = this.#firstSeq.slice();
    const firstRow = this.#firstRow.slice();
    const extra = new Map<string, number>();
    const idOf = (str: string): number | undefined => this.#ids.get(str) ?? extra.get(str);
    let seq = 0;
    const count: Intern = (str) => {
      let id = idOf(str);
      if (id === undefined) {
        id = strings.length;
        extra.set(str, id);
        strings.push(str);
        uses.push(0);
        firstCol.push(Number.POSITIVE_INFINITY);
        firstRow.push(0);
        firstSeq.push(0);
      }
      uses[id] = (uses[id] ?? 0) + 1;
      if ((firstCol[id] ?? 0) > columns.length) {
        firstCol[id] = columns.length;
        firstRow[id] = 0;
        firstSeq[id] = seq;
      }
      seq++;
      return 0;
    };
    for (const [i, r] of pickedResources.entries()) encodeResource(r, count, `resources[${i}]`);
    for (const [i, x] of pickedScopes.entries()) encodeScope(x, count, `scopes[${i}]`);

    const order: number[] = [];
    for (let id = 0; id < strings.length; id++) if ((uses[id] ?? 0) > 0) order.push(id);
    order.sort(
      (a, b) =>
        (uses[b] ?? 0) - (uses[a] ?? 0) ||
        (firstCol[a] ?? 0) - (firstCol[b] ?? 0) ||
        (firstRow[a] ?? 0) - (firstRow[b] ?? 0) ||
        (firstSeq[a] ?? 0) - (firstSeq[b] ?? 0),
    );
    const perm = new Int32Array(strings.length).fill(-1);
    order.forEach((id, i) => {
      perm[id] = i;
    });
    const dict = order.map((id) => strings[id] as string);
    const final: Intern = (str) => perm[idOf(str) ?? -1] ?? -1;

    let base = Number.POSITIVE_INFINITY;
    for (const [ci, col] of columns.entries()) {
      if (!isRelKind(col.kind)) continue;
      for (const t of this.#cols[ci] as (number | null)[]) if (t !== null && t < base) base = t;
    }
    if (!Number.isFinite(base)) base = 0;

    const cols: Record<string, unknown[]> = {};
    for (const [ci, col] of columns.entries()) {
      const cells = this.#cols[ci] as unknown[];
      switch (col.kind) {
        case 'traceId':
        case 'nullableTraceId':
        case 'dict':
        case 'json':
          cols[col.name] = cells.map((c) => (c === null ? null : (perm[c as number] ?? -1)));
          break;
        case 'anyvalue':
          cols[col.name] = cells.map((c) => remapAny(c as JsonValue, perm));
          break;
        case 'attrs':
          cols[col.name] = cells.map((c) => remapAttrs(c as JsonValue[], perm));
          break;
        case 'relnanos':
        case 'nullableRelnanos': {
          let prev = base;
          cols[col.name] = cells.map((c) => {
            if (c === null) return null;
            const t = c as number;
            const delta = t - prev;
            const out = Number.isSafeInteger(delta) ? delta : { $i: (BigInt(t) - BigInt(prev)).toString() };
            prev = t;
            return out;
          });
          break;
        }
        case 'ref':
          cols[col.name] = refCols.get(ci) ?? [];
          break;
        default:
          cols[col.name] = cells.slice();
      }
    }
    return {
      v: 1,
      n: this.#n,
      base,
      cols,
      resources: pickedResources.map((r, i) => encodeResource(r, final, `resources[${i}]`)),
      scopes: pickedScopes.map((x, i) => encodeScope(x, final, `scopes[${i}]`)),
      dict,
    };
  }
}

/** One cell as `push` buffers it: strings as provisional dictionary ids, `ref`s global, times absolute. */
function encodeCell<R>(col: ColumnDef<R>, v: unknown, d: Intern, path: () => string): unknown {
  switch (col.kind) {
    case 'traceId':
      return d(hexId(v, TRACE_ID_RE, '32 lowercase hex chars', path));
    case 'nullableTraceId':
      return v === null ? null : d(hexId(v, TRACE_ID_RE, '32 lowercase hex chars or null', path));
    case 'spanId':
      return hexId(v, SPAN_ID_RE, '16 lowercase hex chars', path);
    case 'nullableSpanId':
      return v === null ? null : hexId(v, SPAN_ID_RE, '16 lowercase hex chars or null', path);
    case 'dict':
      if (typeof v !== 'string') throw bad(path, 'a string', v);
      if (col.oneOf !== undefined && !col.oneOf.includes(v)) {
        throw bad(path, col.oneOf.map((x) => JSON.stringify(x)).join(' | '), v);
      }
      return d(v);
    case 'relnanos':
    case 'nullableRelnanos':
      return v === null && col.kind === 'nullableRelnanos' ? null : safeInt(v, path);
    case 'int':
      return safeInt(v, path);
    case 'bool':
      if (typeof v !== 'boolean') throw bad(path, 'a boolean', v);
      return v;
    case 'anyvalue':
      return encodeAny(v as AnyValue, d, path);
    case 'attrs':
      if (!(v instanceof Map)) throw bad(path, 'an attribute map', v);
      return encodeAttrs(v as Attributes, d, path);
    case 'json':
      return d(flatJsonText(v) ?? JSON.stringify(encodeJson(v, path)));
    case 'ref':
      return safeInt(v, path);
    default:
      return assertNever(col.kind, path());
  }
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
