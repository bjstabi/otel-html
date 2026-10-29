import { z } from 'zod';
import { parseWith } from '../format/validate.js';
import type { AnyValue, Attributes } from '../model/anyvalue.js';
import { OtelHtmlError } from '../model/errors.js';
import type { RelNanos } from '../model/ids.js';
import { canonicalAttributesKey, Interner } from '../model/interner.js';
import type { MetricPointRecord, ResourceRecord, ScopeRecord } from '../model/records.js';
import type { BucketAgg } from './metric-agg.js';
import type { Normalized } from './metric-streams.js';
import { type SerializedValueBuckets, ValueBuckets } from './value-buckets.js';

export interface MetricDef {
  id: number;
  name: string;
  description: string;
  unit: string;
  type: MetricPointRecord['type'];
  temporality: MetricPointRecord['temporality'];
  monotonic: boolean;
}

/** One time series of a metric. IDs are per metric; the `other` series is where over-cap series fold. */
export interface SeriesDef {
  id: number;
  resource: number;
  scope: number;
  attributes: Attributes;
  bounds: number[] | null;
  other: boolean;
}

/** The series a point belongs to, from `seriesOf`. */
export interface SeriesRef {
  id: number;
  /** The metric's `other` series, where over-cap series fold. */
  other: boolean;
  isNew: boolean;
  /** A folded point's own series identity, so cumulative streams of folded series stay apart. */
  foldKey: string | null;
}

export interface MetricEntry extends MetricDef {
  conflicting: boolean;
  scopes: string[];
  attributeKeys: string[];
  resources: number[];
  series: number;
  folded: number;
  /**
   * Folded series whose cumulative stream state was dropped (bounded per metric): each one's next point started a new
   * baseline, so one change was not counted.
   */
  foldedEvicted: number;
  resets: number;
  outOfOrder: number;
  noValue: number;
  points: number;
  spark: ValueBuckets;
}

// ---------------------------------------------------------------------------------------------
// Lossless JSON for attributes (strings and bools are bare, everything else is tagged)
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

// ---------------------------------------------------------------------------------------------
// Serialized form
// ---------------------------------------------------------------------------------------------

type SerializedResource = { attributes: JsonAny[]; droppedAttributesCount: number; schemaUrl: string };
type SerializedScope = SerializedResource & { name: string; version: string };
type SerializedMetric = {
  id: number;
  name: string;
  description: string;
  unit: string;
  type: MetricPointRecord['type'];
  temporality: MetricPointRecord['temporality'];
  monotonic: boolean;
  scopes: string[];
  attributeKeys: string[];
  resources: number[];
  folded: number;
  foldedEvicted: number;
  resets: number;
  outOfOrder: number;
  noValue: number;
  points: number;
  spark: SerializedValueBuckets;
  /** Series count; the definitions live in the metric's `series.js` (see `restoreSeries`). */
  series: number;
};
export type SerializedMetricCatalog = {
  resources: SerializedResource[];
  scopes: SerializedScope[];
  metrics: SerializedMetric[];
};

const nonNegInt = z.number().int().nonnegative();
const sortedUnique = (a: readonly (string | number)[]): boolean =>
  a.every((x, i) => i === 0 || (a[i - 1] ?? x) < x);

const ResourceSchema: z.ZodType<SerializedResource> = z.strictObject({
  attributes: z.array(JsonAnySchema),
  droppedAttributesCount: nonNegInt,
  schemaUrl: z.string(),
});
const ScopeSchema: z.ZodType<SerializedScope> = z.strictObject({
  name: z.string(),
  version: z.string(),
  attributes: z.array(JsonAnySchema),
  droppedAttributesCount: nonNegInt,
  schemaUrl: z.string(),
});
const MetricSchema: z.ZodType<SerializedMetric> = z.strictObject({
  id: nonNegInt,
  name: z.string(),
  description: z.string(),
  unit: z.string(),
  type: z.enum(['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary']),
  temporality: z.enum(['unspecified', 'delta', 'cumulative']),
  monotonic: z.boolean(),
  scopes: z.array(z.string()).refine(sortedUnique, 'sorted and unique'),
  attributeKeys: z.array(z.string()).refine(sortedUnique, 'sorted and unique'),
  resources: z.array(nonNegInt).refine(sortedUnique, 'sorted and unique'),
  folded: nonNegInt,
  foldedEvicted: nonNegInt,
  resets: nonNegInt,
  outOfOrder: nonNegInt,
  noValue: nonNegInt,
  points: nonNegInt,
  spark: z.custom<SerializedValueBuckets>(() => true),
  series: nonNegInt,
});
const CatalogSchema: z.ZodType<SerializedMetricCatalog> = z.strictObject({
  resources: z.array(ResourceSchema),
  scopes: z.array(ScopeSchema),
  metrics: z.array(MetricSchema),
});

// ---------------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------------

const resourceKey = (r: ResourceRecord): string =>
  `${JSON.stringify(r.schemaUrl)}|${r.droppedAttributesCount}|${canonicalAttributesKey(r.attributes)}`;
const scopeKey = (s: ScopeRecord): string =>
  `${JSON.stringify([s.name, s.version, s.schemaUrl])}|${s.droppedAttributesCount}|${canonicalAttributesKey(s.attributes)}`;

const defKey = (d: Omit<MetricDef, 'id' | 'description'>): string =>
  JSON.stringify([d.name, d.unit, d.type, d.temporality, d.monotonic]);

/** Attributes with keys sorted at every level, so equal attribute sets encode equally. */
function sortedAttributes(a: Attributes): Attributes {
  const keys = [...a.keys()].sort();
  return new Map(keys.map((k) => [k, sortedValue(a.get(k) ?? { kind: 'empty' })]));
}

function sortedValue(v: AnyValue): AnyValue {
  if (v.kind === 'kvlist') return { kind: 'kvlist', values: sortedAttributes(v.values) };
  if (v.kind === 'array') return { kind: 'array', values: v.values.map(sortedValue) };
  return v;
}

/**
 * `JSON.stringify(encodeAttributes(...))` of the attributes with sorted keys: canonical, and decodable back into
 * the attributes. Points of one series repeat it for every point, so plain string attributes in key order (the
 * usual case) are written directly.
 */
function canonicalAttributesJson(a: Attributes): string {
  let out = '[';
  let prev = '';
  for (const [k, v] of a) {
    if (k < prev || (v.kind !== 'string' && v.kind !== 'bool')) {
      return JSON.stringify(encodeAttributes(sortedAttributes(a)));
    }
    out += `${out.length > 1 ? ',' : ''}${keyPrefix(k)}${JSON.stringify(v.value)}]`;
    prev = k;
  }
  return `${out}]`;
}

/** `["<key>",` per attribute key: keys repeat on every point of every series. */
const KEY_PREFIXES = new Map<string, string>();
const MAX_KEY_PREFIXES = 4096;
function keyPrefix(k: string): string {
  let p = KEY_PREFIXES.get(k);
  if (p === undefined) {
    p = `[${JSON.stringify(k)},`;
    if (KEY_PREFIXES.size < MAX_KEY_PREFIXES) KEY_PREFIXES.set(k, p);
  }
  return p;
}

/**
 * A series' identity, which is also all a series costs in memory (one string per series, the map key):
 * `resource|scope|bounds|attributes JSON`, decoded by `seriesFromKey`. Bounds JSON holds no "|".
 */
const seriesKey = (
  resource: number,
  scope: number,
  attributes: Attributes,
  bounds: number[] | null,
): string =>
  `${resource}|${scope}|${bounds === null ? '-' : JSON.stringify(bounds)}|${canonicalAttributesJson(attributes)}`;

function seriesFromKey(id: number, key: string): SeriesDef {
  const a = key.indexOf('|');
  const b = key.indexOf('|', a + 1);
  const c = key.indexOf('|', b + 1);
  const bounds = key.slice(b + 1, c);
  return {
    id,
    resource: Number(key.slice(0, a)),
    scope: Number(key.slice(a + 1, b)),
    attributes: decodeAttributes(JSON.parse(key.slice(c + 1)) as JsonAny, `series[${id}].attributes`),
    bounds: bounds === '-' ? null : (JSON.parse(bounds) as number[]),
    other: false,
  };
}

const otherSeries = (id: number): SeriesDef => ({
  id,
  resource: -1,
  scope: -1,
  attributes: new Map(),
  bounds: null,
  other: true,
});

function insertSorted<T extends string | number>(arr: T[], x: T): void {
  if (arr.includes(x)) return;
  arr.push(x);
  arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Explicit bucket bounds of a histogram point; `null` for every other type. */
function boundsOf(p: MetricPointRecord): number[] | null {
  if (p.type !== 'histogram') return null;
  const raw: unknown =
    typeof p.point === 'object' && p.point !== null ? Reflect.get(p.point, 'explicitBounds') : [];
  if (!Array.isArray(raw)) return [];
  // Non-finite bounds are malformed points that the stream normalizer rejects; they never name a series.
  return raw.map((b: unknown) => Number(b)).filter((b) => Number.isFinite(b));
}

interface Slot {
  readonly entry: MetricEntry;
  /** Series keys by id (`seriesKey`); the `other` series has none. */
  readonly series: (string | null)[];
  readonly byKey: Map<string, number>;
  readonly scopeNames: Set<string>;
  readonly keys: Set<string>;
  readonly resourceIds: Set<number>;
  other: number | null;
  /** False after `from` until `restoreSeries` brings back the series definitions. */
  restored: boolean;
}

function sparkValue(a: BucketAgg): number {
  switch (a.k) {
    case 'counter':
      return a.delta;
    case 'number':
      return a.last;
    case 'hist':
    case 'exp':
    case 'summary':
      return a.count;
  }
}

/**
 * Every metric definition seen in a report, with its series (interned per metric, capped), the
 * report-wide resources and scopes they refer to, and a sparkline of the metric's natural value.
 */
export class MetricCatalog {
  readonly #seriesCap: number;
  readonly #resources = new Interner<ResourceRecord>(resourceKey);
  readonly #scopes = new Interner<ScopeRecord>(scopeKey);
  readonly #slots: Slot[] = [];
  readonly #defIds = new Map<string, number>();
  /** Definitions by name, so the per-point lookup in `defOf` builds no key. */
  readonly #byName = new Map<string, MetricEntry[]>();
  /** Interned refs by record identity: the session hands the same record objects for every point. */
  readonly #resourceRefs = new WeakMap<ResourceRecord, number>();
  readonly #scopeRefs = new WeakMap<ScopeRecord, number>();
  readonly #dirty = new Set<number>();

  constructor(opts: { seriesCap: number }) {
    if (!Number.isInteger(opts.seriesCap) || opts.seriesCap < 1) {
      throw new RangeError(`seriesCap must be an integer >= 1, got ${opts.seriesCap}`);
    }
    this.#seriesCap = opts.seriesCap;
  }

  /** Interns the definition `(name, unit, type, temporality, monotonic)`; the first description wins. */
  defOf(p: MetricPointRecord): MetricDef {
    for (const e of this.#byName.get(p.name) ?? []) {
      if (
        e.unit === p.unit &&
        e.type === p.type &&
        e.temporality === p.temporality &&
        e.monotonic === p.monotonic
      )
        return e;
    }
    const key = defKey(p);
    const known = this.#defIds.get(key);
    if (known !== undefined) return this.#slot(known).entry;
    const id = this.#slots.length;
    const entry: MetricEntry = {
      id,
      name: p.name,
      description: p.description,
      unit: p.unit,
      type: p.type,
      temporality: p.temporality,
      monotonic: p.monotonic,
      conflicting: false,
      scopes: [],
      attributeKeys: [],
      resources: [],
      series: 0,
      folded: 0,
      foldedEvicted: 0,
      resets: 0,
      outOfOrder: 0,
      noValue: 0,
      points: 0,
      spark: new ValueBuckets(),
    };
    this.#addSlot(entry);
    this.#markConflicts(p.name);
    return entry;
  }

  /**
   * Interns the series of `p`; beyond the cap, new series fold into the metric's single `other` series. A folded
   * point also gets `foldKey`, its own series identity, so cumulative streams of folded series stay apart.
   */
  seriesOf(def: MetricDef, p: MetricPointRecord, resource: ResourceRecord, scope: ScopeRecord): SeriesRef {
    const slot = this.#restoredSlot(def.id);
    const r = this.#resourceRef(resource);
    const s = this.#scopeRef(scope);
    const bounds = boundsOf(p);
    const key = seriesKey(r, s, p.attributes, bounds);
    const known = slot.byKey.get(key);
    // A known series' resource, scope and attribute keys were noted when it was added (or restored with the entry).
    if (known !== undefined) return { id: known, other: false, isNew: false, foldKey: null };
    const real = slot.series.length - (slot.other === null ? 0 : 1);
    if (real >= this.#seriesCap) {
      slot.entry.folded++;
      if (slot.other !== null) return { id: slot.other, other: true, isNew: false, foldKey: key };
      const id = this.#push(slot, null);
      slot.other = id;
      return { id, other: true, isNew: true, foldKey: key };
    }
    const id = this.#push(slot, key);
    slot.byKey.set(key, id);
    this.#noteSeries(slot, r, scope.name, p.attributes);
    return { id, other: false, isNew: true, foldKey: null };
  }

  /** Counts one point: every point counts, resets and skips are tallied, and a value feeds the sparkline. */
  note(defId: number, n: Normalized, t: RelNanos): void {
    const e = this.#slot(defId).entry;
    e.points++;
    if (n.kind === 'skip') {
      if (n.reason === 'out-of-order') e.outOfOrder++;
      else e.noValue++;
      return;
    }
    if (n.reset) e.resets++;
    if (n.evicted === true) e.foldedEvicted++;
    const v = sparkValue(n.agg);
    if (Number.isFinite(v)) e.spark.add(t, v);
  }

  entries(): readonly MetricEntry[] {
    return this.#slots.map((s) => s.entry);
  }
  resources(): readonly ResourceRecord[] {
    return this.#resources.entries();
  }
  scopes(): readonly ScopeRecord[] {
    return this.#scopes.entries();
  }
  /** The metric's series definitions, decoded from their keys (for writing `series.js`). */
  seriesDefs(defId: number): readonly SeriesDef[] {
    return this.#restoredSlot(defId).series.map((key, id) =>
      key === null ? otherSeries(id) : seriesFromKey(id, key),
    );
  }
  /** Metrics whose series list changed since the last `clearDirty`. */
  dirtyMetrics(): number[] {
    return [...this.#dirty].sort((a, b) => a - b);
  }
  clearDirty(): void {
    this.#dirty.clear();
  }

  #resourceRef(resource: ResourceRecord): number {
    let r = this.#resourceRefs.get(resource);
    if (r === undefined) {
      r = this.#resources.intern(resource);
      this.#resourceRefs.set(resource, r);
    }
    return r;
  }

  #scopeRef(scope: ScopeRecord): number {
    let s = this.#scopeRefs.get(scope);
    if (s === undefined) {
      s = this.#scopes.intern(scope);
      this.#scopeRefs.set(scope, s);
    }
    return s;
  }

  #restoredSlot(id: number): Slot {
    const slot = this.#slot(id);
    if (!slot.restored) throw new Error(`invariant violated: series of metric ${id} not restored`);
    return slot;
  }

  #slot(id: number): Slot {
    const s = this.#slots[id];
    if (s === undefined) throw new RangeError(`unknown metric id ${id}`);
    return s;
  }

  #addSlot(entry: MetricEntry): Slot {
    const slot: Slot = {
      entry,
      series: [],
      byKey: new Map(),
      scopeNames: new Set(),
      keys: new Set(),
      resourceIds: new Set(),
      other: null,
      restored: true,
    };
    this.#slots.push(slot);
    this.#defIds.set(defKey(entry), entry.id);
    const named = this.#byName.get(entry.name);
    if (named === undefined) this.#byName.set(entry.name, [entry]);
    else named.push(entry);
    return slot;
  }

  #push(slot: Slot, key: string | null): number {
    slot.series.push(key);
    slot.entry.series = slot.series.length;
    this.#dirty.add(slot.entry.id);
    return slot.series.length - 1;
  }

  #noteSeries(slot: Slot, resource: number, scopeName: string, attributes: Attributes): void {
    if (!slot.resourceIds.has(resource)) {
      slot.resourceIds.add(resource);
      insertSorted(slot.entry.resources, resource);
    }
    if (!slot.scopeNames.has(scopeName)) {
      slot.scopeNames.add(scopeName);
      insertSorted(slot.entry.scopes, scopeName);
    }
    for (const k of attributes.keys()) {
      if (!slot.keys.has(k)) {
        slot.keys.add(k);
        insertSorted(slot.entry.attributeKeys, k);
      }
    }
  }

  #markConflicts(name: string): void {
    const same = this.#slots.filter((s) => s.entry.name === name);
    for (const s of same) s.entry.conflicting = same.length > 1;
  }

  /**
   * Restores a metric's series definitions from its `series.js` after `from`. The file may hold more series
   * than the checkpoint knew (written by a flush that never committed): series ids only grow, so the first
   * `series` of them are the committed ones, the rest are dropped and the metric is marked dirty so the file
   * is rewritten.
   */
  restoreSeries(defId: number, defs: readonly SeriesDef[], path: string): void {
    const slot = this.#slot(defId);
    if (slot.restored) throw invalid(path, `series of metric ${defId} restored once`, 'a second restore');
    const n = slot.entry.series;
    if (defs.length < n) throw invalid(`${path}.series`, `at least ${n} series`, defs.length);
    const resources = this.#resources.entries().length;
    const scopes = this.#scopes.entries().length;
    for (const [j, x] of defs.slice(0, n).entries()) {
      const sp = `${path}.series[${j}]`;
      if (x.id !== j) throw invalid(`${sp}.id`, `${j}`, x.id);
      if (x.other) {
        if (slot.other !== null) throw invalid(`${sp}.other`, 'at most one other series', true);
        if (x.resource !== -1) throw invalid(`${sp}.resource`, '-1 for an other series', x.resource);
        if (x.scope !== -1) throw invalid(`${sp}.scope`, '-1 for an other series', x.scope);
        slot.other = j;
        slot.series.push(null);
      } else {
        if (x.resource < 0 || x.resource >= resources) {
          throw invalid(`${sp}.resource`, `a resource id in [0, ${resources})`, x.resource);
        }
        if (x.scope < 0 || x.scope >= scopes) {
          throw invalid(`${sp}.scope`, `a scope id in [0, ${scopes})`, x.scope);
        }
        const key = seriesKey(x.resource, x.scope, x.attributes, x.bounds);
        if (slot.byKey.has(key)) throw invalid(sp, 'a series distinct from the earlier ones', x.id);
        slot.byKey.set(key, j);
        slot.series.push(key);
      }
    }
    slot.restored = true;
    if (defs.length > n) this.#dirty.add(defId);
  }

  toJSON(): SerializedMetricCatalog {
    return {
      resources: this.#resources.entries().map((r) => ({
        attributes: encodeAttributes(r.attributes),
        droppedAttributesCount: r.droppedAttributesCount,
        schemaUrl: r.schemaUrl,
      })),
      scopes: this.#scopes.entries().map((s) => ({
        name: s.name,
        version: s.version,
        attributes: encodeAttributes(s.attributes),
        droppedAttributesCount: s.droppedAttributesCount,
        schemaUrl: s.schemaUrl,
      })),
      metrics: this.#slots.map(({ entry: e }) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        unit: e.unit,
        type: e.type,
        temporality: e.temporality,
        monotonic: e.monotonic,
        scopes: [...e.scopes],
        attributeKeys: [...e.attributeKeys],
        resources: [...e.resources],
        folded: e.folded,
        foldedEvicted: e.foldedEvicted,
        resets: e.resets,
        outOfOrder: e.outOfOrder,
        noValue: e.noValue,
        points: e.points,
        spark: e.spark.toJSON(),
        series: e.series,
      })),
    };
  }

  /**
   * Rebuild from `toJSON` output, failing fast with an `invalid-report` error naming the field. Series
   * definitions are not part of it: `restoreSeries` must be called for every metric with series before it
   * interns more.
   */
  static from(input: unknown, opts: { seriesCap: number }, root = 'metricCatalog'): MetricCatalog {
    const s = parseWith(CatalogSchema, input, root);
    const c = new MetricCatalog(opts);
    s.resources.forEach((r, i) => {
      const path = `${root}.resources[${i}]`;
      const ref = c.#resources.intern({
        attributes: decodeAttributes(r.attributes, `${path}.attributes`),
        droppedAttributesCount: r.droppedAttributesCount,
        schemaUrl: r.schemaUrl,
      });
      if (ref !== i) throw invalid(path, 'a resource distinct from the earlier ones', r);
    });
    s.scopes.forEach((x, i) => {
      const path = `${root}.scopes[${i}]`;
      const ref = c.#scopes.intern({
        name: x.name,
        version: x.version,
        attributes: decodeAttributes(x.attributes, `${path}.attributes`),
        droppedAttributesCount: x.droppedAttributesCount,
        schemaUrl: x.schemaUrl,
      });
      if (ref !== i) throw invalid(path, 'a scope distinct from the earlier ones', x);
    });
    for (const [i, m] of s.metrics.entries()) c.#restoreMetric(m, `${root}.metrics[${i}]`, i);
    for (const name of new Set(c.#slots.map((x) => x.entry.name))) c.#markConflicts(name);
    return c;
  }

  #restoreMetric(m: SerializedMetric, path: string, index: number): void {
    if (m.id !== index) throw invalid(`${path}.id`, `${index}`, m.id);
    if (this.#defIds.has(defKey(m)))
      throw invalid(path, 'a definition distinct from the earlier ones', m.name);
    const entry: MetricEntry = {
      id: m.id,
      name: m.name,
      description: m.description,
      unit: m.unit,
      type: m.type,
      temporality: m.temporality,
      monotonic: m.monotonic,
      conflicting: false,
      scopes: [...m.scopes],
      attributeKeys: [...m.attributeKeys],
      resources: [...m.resources],
      series: m.series,
      folded: m.folded,
      foldedEvicted: m.foldedEvicted,
      resets: m.resets,
      outOfOrder: m.outOfOrder,
      noValue: m.noValue,
      points: m.points,
      spark: ValueBuckets.from(m.spark, `${path}.spark`),
    };
    const slot = this.#addSlot(entry);
    for (const r of m.resources) {
      if (r >= this.#resources.entries().length) throw invalid(`${path}.resources`, 'known resource ids', r);
    }
    for (const x of m.scopes) slot.scopeNames.add(x);
    for (const x of m.attributeKeys) slot.keys.add(x);
    for (const x of m.resources) slot.resourceIds.add(x);
    slot.restored = m.series === 0;
  }
}
