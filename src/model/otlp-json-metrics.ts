import type { AnyValue, Attributes } from './anyvalue.js';
import { metricRecords, type NormalizeContext, rel, relOrNull } from './normalize.js';
import type { OtlpRequest } from './otlp-json.js';
import type { MetricPointRecord, ResourceRef, ScopeRef } from './records.js';
import { UnsafeNumber } from './unsafe-number.js';

/**
 * Metrics read straight from OTLP JSON, without building protobuf-es messages: the common shape (gauges and sums
 * of number points with inline attribute values, canonical camelCase field names) costs no message tree, no
 * per-point `toJson` and no copy of the input, which matters at hundreds of thousands of points per second.
 *
 * `plainMetrics` accepts a request only when every field is one protobuf-es `fromJson` reads without error and
 * this module reads to the same value; anything else (another point kind, exemplars, snake_case names, enum
 * numbers outside the declared values, strings for 32-bit or float fields, nulls, unknown fields, ...) returns
 * null and the request goes through protobuf-es, so its records and its rejections stay exactly those of that
 * path. `plainMetricRecords` then yields records equal to `metricRecords` on the decoded request.
 */
export interface PlainMetrics {
  /** The request's resource entries, checked by `plainMetrics`. */
  readonly items: readonly unknown[];
  /** The earliest non-zero point time, as `earliestTimestamp` finds it. */
  readonly earliest: bigint | null;
}

type JsonObject = Readonly<Record<string, unknown>>;

const UINT64_MAX = (1n << 64n) - 1n;
const INT64_MAX = (1n << 63n) - 1n;
const INT64_MIN = -(1n << 63n);
const UINT32_MAX = 4_294_967_295;
/** AnyValue nesting accepted here; protobuf-es's recursion limit (100 messages) is far beyond it. */
const MAX_VALUE_DEPTH = 16;
/** Decimal strings short enough to be int64 without a range check, already in `String(bigint)` form. */
const CANONICAL_INT64 = /^(?:0|-?[1-9][0-9]{0,17})$/;
const DIGITS = /^[0-9]{1,20}$/;
const SIGNED_DIGITS = /^-?[0-9]{1,20}$/;

/** OTLP JSON enum values of `AggregationTemporality`, by number and by name. */
const TEMPORALITY: ReadonlyMap<unknown, MetricPointRecord['temporality']> = new Map<
  unknown,
  MetricPointRecord['temporality']
>([
  [0, 'unspecified'],
  [1, 'delta'],
  [2, 'cumulative'],
  ['AGGREGATION_TEMPORALITY_UNSPECIFIED', 'unspecified'],
  ['AGGREGATION_TEMPORALITY_DELTA', 'delta'],
  ['AGGREGATION_TEMPORALITY_CUMULATIVE', 'cumulative'],
]);

const hasOwnEnumerable = Object.prototype.propertyIsEnumerable;

/** `o[key]` when it is an own enumerable property (what protobuf-es reads), else undefined. */
function field(o: JsonObject, key: string): unknown {
  return hasOwnEnumerable.call(o, key) ? o[key] : undefined;
}

/** An object protobuf-es reads as a message (the same test `convertValue` applies). */
function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof UnsafeNumber);
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.isWellFormed();
}

function isUint32(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= UINT32_MAX;
}

/** A 64-bit integer field's value, or null when protobuf-es would reject it or this module does not read it. */
function int64(v: unknown, unsigned: boolean): bigint | null {
  const s = v instanceof UnsafeNumber ? v.source : v;
  if (typeof s === 'number') {
    if (!Number.isSafeInteger(s) || (unsigned && s < 0)) return null;
    return BigInt(s);
  }
  if (typeof s !== 'string' || !(unsigned ? DIGITS : SIGNED_DIGITS).test(s)) return null;
  const n = BigInt(s);
  if (unsigned ? n > UINT64_MAX : n > INT64_MAX || n < INT64_MIN) return null;
  return n;
}

/** A double field's value, or null (strings such as "NaN" are left to protobuf-es). */
function double(v: unknown): number | null {
  if (v instanceof UnsafeNumber) return v.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// -- checking --------------------------------------------------------------------------------------

/** What a check found so far: the earliest non-zero point time. */
interface Seen {
  earliest: bigint | null;
}

function checkList(v: unknown, item: (x: unknown) => boolean): boolean {
  if (!Array.isArray(v)) return false;
  for (const x of v) if (!item(x)) return false;
  return true;
}

function checkAnyValue(v: unknown, depth: number): boolean {
  if (!isObject(v) || depth > MAX_VALUE_DEPTH) return false;
  let set = 0;
  for (const k of Object.keys(v)) {
    const x = v[k];
    let ok: boolean;
    switch (k) {
      case 'stringValue':
        ok = isString(x);
        break;
      case 'boolValue':
        ok = typeof x === 'boolean';
        break;
      case 'intValue':
        ok = int64(x, false) !== null;
        break;
      case 'doubleValue':
        ok = double(x) !== null;
        break;
      case 'arrayValue':
        ok = checkValues(x, (vs) => checkList(vs, (e) => checkAnyValue(e, depth + 1)));
        break;
      case 'kvlistValue':
        ok = checkValues(x, (kvs) => checkKeyValues(kvs, depth + 1));
        break;
      default:
        return false;
    }
    if (!ok || ++set > 1) return false;
  }
  return true;
}

/** An `ArrayValue` or `KeyValueList`: an object whose only field is `values`. */
function checkValues(v: unknown, values: (x: unknown) => boolean): boolean {
  if (!isObject(v)) return false;
  for (const k of Object.keys(v)) if (k !== 'values' || !values(v[k])) return false;
  return true;
}

function checkKeyValues(v: unknown, depth: number): boolean {
  return checkList(v, (kv) => {
    if (!isObject(kv)) return false;
    for (const k of Object.keys(kv)) {
      const x = kv[k];
      if (k === 'key' ? !isString(x) : k !== 'value' || !checkAnyValue(x, depth)) return false;
    }
    return true;
  });
}

const checkAttributes = (v: unknown): boolean => checkKeyValues(v, 0);

function checkPoint(dp: unknown, seen: Seen): boolean {
  if (!isObject(dp)) return false;
  let values = 0;
  for (const k of Object.keys(dp)) {
    const x = dp[k];
    switch (k) {
      case 'attributes':
        if (!checkAttributes(x)) return false;
        break;
      case 'startTimeUnixNano':
        if (int64(x, true) === null) return false;
        break;
      case 'timeUnixNano': {
        const t = int64(x, true);
        if (t === null) return false;
        if (t !== 0n && (seen.earliest === null || t < seen.earliest)) seen.earliest = t;
        break;
      }
      case 'asDouble':
        if (double(x) === null || ++values > 1) return false;
        break;
      case 'asInt':
        if (int64(x, false) === null || ++values > 1) return false;
        break;
      case 'exemplars':
        // Exemplars need protobuf-es's reading of their ids and values; only an empty list stays here.
        if (!Array.isArray(x) || x.length > 0) return false;
        break;
      case 'flags':
        if (!isUint32(x)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function checkData(v: unknown, sum: boolean, seen: Seen): boolean {
  if (!isObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    switch (k) {
      case 'dataPoints':
        if (!checkList(x, (dp) => checkPoint(dp, seen))) return false;
        break;
      case 'aggregationTemporality':
        if (!sum || !TEMPORALITY.has(x)) return false;
        break;
      case 'isMonotonic':
        if (!sum || typeof x !== 'boolean') return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function checkMetric(m: unknown, seen: Seen): boolean {
  if (!isObject(m)) return false;
  let data = 0;
  for (const k of Object.keys(m)) {
    const x = m[k];
    switch (k) {
      case 'name':
      case 'description':
      case 'unit':
        if (!isString(x)) return false;
        break;
      case 'gauge':
      case 'sum':
        if (!checkData(x, k === 'sum', seen) || ++data > 1) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/** A `Resource` (`scope` false) or an `InstrumentationScope` (`scope` true). */
function checkEntity(v: unknown, scope: boolean): boolean {
  if (!isObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    switch (k) {
      case 'attributes':
        if (!checkAttributes(x)) return false;
        break;
      case 'droppedAttributesCount':
        if (!isUint32(x)) return false;
        break;
      case 'name':
      case 'version':
        if (!scope || !isString(x)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function checkScopeMetrics(v: unknown, seen: Seen): boolean {
  if (!isObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    switch (k) {
      case 'scope':
        if (!checkEntity(x, true)) return false;
        break;
      case 'metrics':
        if (!checkList(x, (m) => checkMetric(m, seen))) return false;
        break;
      case 'schemaUrl':
        if (!isString(x)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function checkResourceMetrics(v: unknown, seen: Seen): boolean {
  if (!isObject(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    switch (k) {
      case 'resource':
        if (!checkEntity(x, false)) return false;
        break;
      case 'scopeMetrics':
        if (!checkList(x, (sm) => checkScopeMetrics(sm, seen))) return false;
        break;
      case 'schemaUrl':
        if (!isString(x)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * The resource entries `items` (parsed OTLP JSON, as `requestOf` receives them) when this module reads all of
 * them, else null. Builds nothing but the result.
 */
export function plainMetrics(items: readonly unknown[]): PlainMetrics | null {
  const seen: Seen = { earliest: null };
  for (const item of items) if (!checkResourceMetrics(item, seen)) return null;
  return { items, earliest: seen.earliest };
}

// -- reading (of checked input only) ---------------------------------------------------------------

const EMPTY_VALUE: AnyValue = { kind: 'empty' };

/** A checked list (every element is an object), or none. */
function list(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

const NO_FIELDS: JsonObject = {};

/** A checked list element. */
function at(items: readonly unknown[], i: number): JsonObject {
  const v = items[i];
  return isObject(v) ? v : NO_FIELDS;
}

function text(o: JsonObject, key: string): string {
  const v = field(o, key);
  return typeof v === 'string' ? v : '';
}

function count(o: JsonObject, key: string): number {
  const v = field(o, key);
  return typeof v === 'number' ? v : 0;
}

function anyValue(v: JsonObject): AnyValue {
  let x = field(v, 'stringValue');
  if (typeof x === 'string') return { kind: 'string', value: x };
  x = field(v, 'intValue');
  if (x !== undefined) return { kind: 'int', value: int64(x, false) ?? 0n };
  x = field(v, 'doubleValue');
  if (x !== undefined) return { kind: 'double', value: double(x) ?? 0 };
  x = field(v, 'boolValue');
  if (typeof x === 'boolean') return { kind: 'bool', value: x };
  x = field(v, 'arrayValue');
  if (isObject(x))
    return {
      kind: 'array',
      values: list(field(x, 'values')).map((e) => (isObject(e) ? anyValue(e) : EMPTY_VALUE)),
    };
  x = field(v, 'kvlistValue');
  if (isObject(x)) return { kind: 'kvlist', values: attributes(field(x, 'values')) };
  return EMPTY_VALUE;
}

function attributes(v: unknown): Attributes {
  const out = new Map<string, AnyValue>();
  if (!Array.isArray(v)) return out;
  for (const kv of v) {
    if (!isObject(kv)) continue;
    const value = field(kv, 'value');
    out.set(text(kv, 'key'), isObject(value) ? anyValue(value) : EMPTY_VALUE);
  }
  return out;
}

/** The point JSON `pointJson` gives for a number point without exemplars: its value, as protobuf-es writes it. */
function numberPoint(dp: JsonObject): unknown {
  const d = field(dp, 'asDouble');
  if (d !== undefined) return { asDouble: double(d) };
  const i = field(dp, 'asInt');
  if (i === undefined) return {};
  if (typeof i === 'string' && CANONICAL_INT64.test(i)) return { asInt: i };
  return { asInt: String(int64(i, false) ?? 0n) };
}

function time(dp: JsonObject, key: string): bigint {
  const v = field(dp, key);
  return v === undefined ? 0n : (int64(v, true) ?? 0n);
}

/** `metricRecords` for a request `plainMetrics` accepted: equal records, equal errors (same paths). */
export function* plainMetricRecords(
  plain: PlainMetrics,
  ctx: NormalizeContext,
  source: string,
  first = 0,
): Generator<MetricPointRecord, void, void> {
  const items = plain.items;
  for (let ri = 0; ri < items.length; ri++) {
    const rm = at(items, ri);
    const rp = `resourceMetrics[${first + ri}]`;
    const res = field(rm, 'resource');
    const resource = ctx.resources.intern({
      attributes: attributes(isObject(res) ? field(res, 'attributes') : undefined),
      droppedAttributesCount: isObject(res) ? count(res, 'droppedAttributesCount') : 0,
      schemaUrl: text(rm, 'schemaUrl'),
    }) as ResourceRef;
    const scopeMetrics = list(field(rm, 'scopeMetrics'));
    for (let si = 0; si < scopeMetrics.length; si++) {
      const sm = at(scopeMetrics, si);
      const sp = `${rp}.scopeMetrics[${si}]`;
      const sc = field(sm, 'scope');
      const s = isObject(sc) ? sc : NO_FIELDS;
      const scope = ctx.scopes.intern({
        name: text(s, 'name'),
        version: text(s, 'version'),
        attributes: attributes(field(s, 'attributes')),
        droppedAttributesCount: count(s, 'droppedAttributesCount'),
        schemaUrl: text(sm, 'schemaUrl'),
      }) as ScopeRef;
      const metrics = list(field(sm, 'metrics'));
      for (let mi = 0; mi < metrics.length; mi++) {
        const m = at(metrics, mi);
        const gauge = field(m, 'gauge');
        const sum = field(m, 'sum');
        const data = isObject(gauge) ? gauge : isObject(sum) ? sum : null;
        if (data === null) continue;
        const kind = data === gauge ? 'gauge' : 'sum';
        const name = text(m, 'name');
        const description = text(m, 'description');
        const unit = text(m, 'unit');
        const temporality =
          kind === 'sum'
            ? (TEMPORALITY.get(field(data, 'aggregationTemporality')) ?? 'unspecified')
            : 'unspecified';
        const monotonic = kind === 'sum' && field(data, 'isMonotonic') === true;
        const points = list(field(data, 'dataPoints'));
        // Path builders made once per metric and read only for an error, as in `metricRecords`.
        let di = 0;
        const p = (): string => `${source}: ${sp}.metrics[${mi}].${kind}.dataPoints[${di}]`;
        const startPath = (): string => `${p()}.startTimeUnixNano`;
        const timePath = (): string => `${p()}.timeUnixNano`;
        for (; di < points.length; di++) {
          const dp = at(points, di);
          yield {
            name,
            description,
            unit,
            type: kind,
            temporality,
            monotonic,
            start: relOrNull(time(dp, 'startTimeUnixNano'), ctx, startPath),
            time: rel(time(dp, 'timeUnixNano'), ctx, timePath),
            attributes: attributes(field(dp, 'attributes')),
            flags: count(dp, 'flags'),
            point: numberPoint(dp),
            resource,
            scope,
          };
        }
      }
    }
  }
}

type MetricsRequest = Extract<OtlpRequest, { readonly signal: 'metrics' }>;

/** The records of a metrics request, read without protobuf-es messages when `requestOf` found it plain. */
export function metricPointsOf(
  input: MetricsRequest,
  ctx: NormalizeContext,
  source: string,
): Iterable<MetricPointRecord> {
  const first = input.first ?? 0;
  return input.plain === undefined
    ? metricRecords(input.request, ctx, source, first)
    : plainMetricRecords(input.plain, ctx, source, first);
}
