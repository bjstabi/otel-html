import type { Table } from '@uwdata/flechette';
import { attributesFromJson } from '../../format/columns.js';
import type { ResultRow } from '../../format/parquet/decode.js';
import type { Attributes } from '../../model/anyvalue.js';
import { OtelHtmlError } from '../../model/errors.js';
import { canonicalAttributesKey } from '../../model/interner.js';
import type { ResourceRecord, ScopeRecord } from '../../model/records.js';
import type { MetricQuery } from '../../query/metric-query.js';
import type { MetricIdentity } from '../../query/sql/points.js';
import type { BucketSpec } from '../../query/sql/time.js';
import { type MetricCatalogData, type MetricDef, type MetricEntry, resourceKey } from './metric-catalog.js';
import { SHOW_BY_KIND } from './metric-tables.js';
import { cell, rowsOf, toNumber } from './span-results.js';
import type { TimeWindow } from './time-window.js';

/** Request and result shapes of the metric data layer. */

export interface SeriesPoints {
  key: string;
  label: string;
  group: Record<string, string>;
  unit: string;
  /** [bucket start (RelNanos), value]; null is a gap. */
  points: [number, number | null][];
  resourceService: string | null;
}

export interface MetricQueryResult {
  queryId: string;
  /** The series' bucket width: the rollup interval when a rollup ƒ applies. `heat.widthNs` is the cells'. */
  widthNs: number;
  series: SeriesPoints[];
  exemplars: {
    time: number;
    value: number;
    traceId: string | null;
    spanId: string | null;
    seriesKey: string;
  }[];
  heat: { bounds: number[]; cells: [number, number, number][]; widthNs: number } | null;
  distribution: { bounds: number[]; counts: number[] } | null;
  notes: string[];
}

export interface RunInfo {
  id: string;
  /** RelNanos: the start of the bucket holding the run's last point. */
  time: number;
  revision: string | null;
}

interface RunPoint {
  value: number;
  failed: boolean;
}

export interface RunLine {
  key: string;
  label: string;
  unit: string;
  /** Aligned with `runs`; null where the line has no point in that run. */
  points: (RunPoint | null)[];
}

export interface RunQueryResult {
  queryId: string;
  runs: RunInfo[];
  lines: RunLine[];
  /** Series with data that no run could be read for: no run id. */
  leftOut: number;
  /** The window the query covered, echoed so a chart can tell when it changed. */
  window: TimeWindow;
  notes: string[];
}

/** One decoded row of `seriesQuery`; `seriesId` is the stored hash text. */
export interface SeriesRow {
  seriesId: string;
  /** The metric's description as this series stored it. */
  description: string;
  attributes: Attributes;
  resource: ResourceRecord;
  scope: ScopeRecord;
  bounds: number[] | null;
  groups: (string | null)[];
}

export interface MetricQueryRequest {
  entry: MetricEntry;
  query: MetricQuery;
  window: TimeWindow;
  maxPoints: number;
  widthNs?: number;
  resources?: readonly number[];
  exemplars: boolean;
}

export interface MetricRunQueryRequest {
  entry: MetricEntry;
  query: MetricQuery;
  window: TimeWindow;
  runBy: string;
  failedWhen: string | null;
  resources?: readonly number[];
}

export interface MetricMethods {
  metricCatalog(): Promise<MetricCatalogData>;
  metricShowOptions(entryId: number): Promise<readonly string[]>;
  metricQuery(req: MetricQueryRequest, signal?: AbortSignal): Promise<MetricQueryResult>;
  metricRunQuery(req: MetricRunQueryRequest, signal?: AbortSignal): Promise<RunQueryResult>;
  metricsForResources(resources: readonly ResourceRecord[]): Promise<readonly MetricEntry[]>;
}

export function resolveMetric(
  catalog: MetricCatalogData,
  q: Pick<MetricQuery, 'metric' | 'kind' | 'unit'>,
): { entry: MetricEntry } | { ambiguous: MetricEntry[] } | { missing: true } {
  const found = catalog.entries.filter(
    (e) =>
      e.name === q.metric && (q.kind === null || e.type === q.kind) && (q.unit === null || e.unit === q.unit),
  );
  const [only] = found;
  if (only === undefined) return { missing: true };
  return found.length === 1 ? { entry: only } : { ambiguous: found };
}

const BASE_WIDTH_NS = 1e6;
/** Fewer gaps than this leave the bucket width to the pick alone (one outage would read as a slow scrape). */
const INTERVAL_MIN_GAPS = 8;

/** Buckets of `widthNs` a window touches; both ends are inclusive. */
const bucketsOver = (w: TimeWindow, widthNs: number): number =>
  Math.floor(w.end / widthNs) - Math.floor(w.start / widthNs) + 1;

/** D24: the smallest 1 ms x 2^k whose buckets over the window number at most `maxPoints`. */
export function pickWidthNs(window: TimeWindow, maxPoints: number): number {
  let width = BASE_WIDTH_NS;
  // No width satisfies a bound under 1, and a window that is not finite never shrinks to a bucket count.
  if (!(maxPoints >= 1) || !Number.isFinite(window.start) || !Number.isFinite(window.end)) return width;
  while (bucketsOver(window, width) > maxPoints) width *= 2;
  return width;
}

/** D24: the pick, or the interval rounded up to a whole multiple of the pick when the points are sparser. */
export function chartWidthNs(pick: number, intervalNs: number): number {
  return intervalNs <= pick ? pick : Math.ceil(intervalNs / pick) * pick;
}

/** The upper median of the gaps (an even count rounds up); 0 under `INTERVAL_MIN_GAPS` gaps. */
export function upperMedian(gaps: readonly number[]): number {
  if (gaps.length < INTERVAL_MIN_GAPS) return 0;
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// ---------------------------------------------------------------------------------------------
// The catalog's rows
// ---------------------------------------------------------------------------------------------

const POINT_TYPES: Record<string, MetricDef['type']> = {
  gauge: 'gauge',
  sum: 'sum',
  histogram: 'histogram',
  exp_histogram: 'exponentialHistogram',
  summary: 'summary',
};
const TEMPORALITIES: Record<number, MetricDef['temporality']> = {
  0: 'unspecified',
  1: 'delta',
  2: 'cumulative',
};

const invalid = (path: string, expected: string, actual: unknown): OtelHtmlError =>
  new OtelHtmlError('invalid-report', {
    path,
    expected,
    actual: typeof actual === 'bigint' ? actual.toString() : (JSON.stringify(actual) ?? String(actual)),
  });

const textOf = (row: ResultRow, name: string): string => {
  const v = cell(row, name);
  if (typeof v !== 'string') throw invalid(name, 'a string', v);
  return v;
};

/** The definition as `points` stores it: the key joining the defs, identity and sparkline rows. */
function storedDef(row: ResultRow): MetricIdentity & { key: string } {
  const unit = cell(row, 'metric_unit');
  const temporality = cell(row, 'aggregation_temporality');
  const monotonic = cell(row, 'is_monotonic');
  const id: MetricIdentity = {
    name: textOf(row, 'metric_name'),
    type: textOf(row, 'point_type'),
    unit: typeof unit === 'string' ? unit : null,
    temporality:
      temporality === null || temporality === undefined ? null : toNumber(temporality, 'temporality'),
    monotonic: typeof monotonic === 'boolean' ? monotonic : null,
  };
  return { ...id, key: JSON.stringify([id.name, id.type, id.unit, id.temporality, id.monotonic]) };
}

/** The keys of an attribute JSON text without decoding its values; the `{"$m": [[key, value], ...]}` form lists its keys. */
function attributeKeysOf(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [...attributesFromJson(text).keys()]; // throws the typed error
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return [...attributesFromJson(text).keys()];
  const keys = Object.keys(parsed);
  const [only] = keys;
  if (keys.length === 1 && only === '$m') {
    const entries = (parsed as { $m?: unknown }).$m;
    if (Array.isArray(entries))
      return entries.flatMap((e: unknown) => (Array.isArray(e) && typeof e[0] === 'string' ? [e[0]] : []));
  }
  return keys;
}

const scopeKey = (s: ScopeRecord): string =>
  JSON.stringify([
    s.name,
    s.version,
    s.schemaUrl,
    s.droppedAttributesCount,
    canonicalAttributesKey(s.attributes),
  ]);

const compare = <T extends string | number | boolean>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

export interface CatalogRows extends MetricCatalogData {
  /** Per resource record (by index), every stored `resource_attributes` text that decodes to it (D29). */
  resourceTexts: readonly string[][];
  /** Per entry (by id), the definition as `points` stores it. */
  identities: readonly MetricIdentity[];
}

/** The three catalog statements' results as the catalog (D20): attribute keys and resources come from the identity texts. */
export function catalogFrom(defs: Table, identities: Table, spark: Table, spec: BucketSpec): CatalogRows {
  const buckets = Math.floor((spec.endNs - spec.startNs) / spec.widthNs) + 1;

  interface Acc {
    id: MetricIdentity;
    row: ResultRow;
    keys: Set<string>;
    resources: Set<string>;
    sums: number[];
    counts: number[];
  }
  const accs = new Map<string, Acc>();
  for (const row of rowsOf(defs)) {
    const d = storedDef(row);
    const { key, ...id } = d;
    accs.set(key, {
      id,
      row,
      keys: new Set(),
      resources: new Set(),
      sums: new Array<number>(buckets).fill(0),
      counts: new Array<number>(buckets).fill(0),
    });
  }

  const resources = new Map<string, { record: ResourceRecord; texts: Set<string> }>();
  const scopes = new Map<string, ScopeRecord>();
  const seenAttributes = new Set<string>();
  // identity rows repeat the same resource and scope texts: decode each once
  const resourceByText = new Map<string, { key: string; record: ResourceRecord }>();
  const scopeByText = new Set<string>();
  for (const row of rowsOf(identities)) {
    const def = storedDef(row);
    const acc = accs.get(def.key);
    if (acc === undefined) continue;
    const attributes = textOf(row, 'attributes');
    const seen = `${def.key}\u0000${attributes}`;
    if (!seenAttributes.has(seen)) {
      seenAttributes.add(seen);
      for (const k of attributeKeysOf(attributes)) acc.keys.add(k);
    }
    const text = textOf(row, 'resource_attributes');
    const schemaUrl = textOf(row, 'resource_schema_url');
    const dropped = toNumber(cell(row, 'resource_dropped_attributes_count'), 'resource dropped');
    const stored = JSON.stringify([text, schemaUrl, dropped]);
    let decoded = resourceByText.get(stored);
    if (decoded === undefined) {
      const record: ResourceRecord = {
        attributes: attributesFromJson(text),
        droppedAttributesCount: dropped,
        schemaUrl,
      };
      decoded = { key: resourceKey(record), record };
      resourceByText.set(stored, decoded);
      const known = resources.get(decoded.key);
      if (known === undefined) resources.set(decoded.key, { record, texts: new Set([text]) });
      else known.texts.add(text);
    }
    acc.resources.add(decoded.key);
    const scopeText = JSON.stringify([
      textOf(row, 'scope_name'),
      textOf(row, 'scope_version'),
      textOf(row, 'scope_attributes'),
      textOf(row, 'scope_schema_url'),
      toNumber(cell(row, 'scope_dropped_attributes_count'), 'scope dropped'),
    ]);
    if (!scopeByText.has(scopeText)) {
      scopeByText.add(scopeText);
      const scope: ScopeRecord = {
        name: textOf(row, 'scope_name'),
        version: textOf(row, 'scope_version'),
        attributes: attributesFromJson(textOf(row, 'scope_attributes')),
        droppedAttributesCount: toNumber(cell(row, 'scope_dropped_attributes_count'), 'scope dropped'),
        schemaUrl: textOf(row, 'scope_schema_url'),
      };
      scopes.set(scopeKey(scope), scope);
    }
  }

  for (const row of rowsOf(spark)) {
    const acc = accs.get(storedDef(row).key);
    if (acc === undefined) continue;
    const i = Math.round((toNumber(cell(row, 'bucket'), 'bucket') - spec.startNs) / spec.widthNs);
    if (i < 0 || i >= buckets) continue;
    acc.sums[i] = Number(cell(row, 'sum') ?? 0);
    acc.counts[i] = toNumber(cell(row, 'n'), 'n');
  }

  const orderedResources = [...resources.entries()].sort(([a], [b]) => compare(a, b));
  const indexOf = new Map(orderedResources.map(([k], i) => [k, i]));
  const orderedScopes = [...scopes.entries()].sort(([a], [b]) => compare(a, b)).map(([, s]) => s);

  const defsOf = [...accs.values()].map((acc) => {
    const type = POINT_TYPES[acc.id.type];
    if (type === undefined) throw invalid('point_type', 'a point type', acc.id.type);
    const temporality = TEMPORALITIES[acc.id.temporality ?? 0];
    if (temporality === undefined) throw invalid('aggregation_temporality', '0, 1 or 2', acc.id.temporality);
    return { acc, type, temporality };
  });
  defsOf.sort(
    (a, b) =>
      compare(a.acc.id.name, b.acc.id.name) ||
      compare(a.type, b.type) ||
      compare(a.acc.id.unit ?? '', b.acc.id.unit ?? '') ||
      compare(a.acc.id.temporality ?? 0, b.acc.id.temporality ?? 0) ||
      compare(a.acc.id.monotonic === true, b.acc.id.monotonic === true),
  );
  const names = new Map<string, number>();
  for (const { acc } of defsOf) names.set(acc.id.name, (names.get(acc.id.name) ?? 0) + 1);

  const entries = defsOf.map(({ acc, type, temporality }, id): MetricEntry => {
    const description = cell(acc.row, 'description');
    const scopeNames = cell(acc.row, 'scopes');
    return {
      id,
      name: acc.id.name,
      description: typeof description === 'string' ? description : '',
      unit: acc.id.unit ?? '',
      type,
      temporality,
      monotonic: acc.id.monotonic === true,
      conflicting: (names.get(acc.id.name) ?? 0) > 1,
      scopes:
        scopeNames === null || scopeNames === undefined ? [] : Array.from(scopeNames as ArrayLike<string>),
      attributeKeys: [...acc.keys].sort(compare),
      resources: [...acc.resources]
        .map((k) => indexOf.get(k) ?? -1)
        .filter((i) => i >= 0)
        .sort((a, b) => a - b),
      series: toNumber(cell(acc.row, 'series'), 'series'),
      points: toNumber(cell(acc.row, 'points'), 'points'),
      resets: toNumber(cell(acc.row, 'resets'), 'resets'),
      outOfOrder: toNumber(cell(acc.row, 'out_of_order'), 'out_of_order'),
      noValue: toNumber(cell(acc.row, 'no_value'), 'no_value'),
      spark: { widthNs: spec.widthNs, startNs: spec.startNs, sums: acc.sums, counts: acc.counts },
    };
  });

  return {
    entries,
    resources: orderedResources.map(([, r]) => r.record),
    scopes: orderedScopes,
    resourceTexts: orderedResources.map(([, r]) => [...r.texts]),
    identities: defsOf.map(({ acc }) => acc.id),
  };
}

/** `q<quantile>` per quantile of a `summaryQuantilesQuery` result, then `count` and `sum`. */
export function summaryShowOptions(t: Table): string[] {
  const qs = rowsOf(t).map((r) => {
    const q = cell(r, 'q');
    if (typeof q !== 'number') throw invalid('q', 'a number', q);
    return `q${q}`;
  });
  return [...qs, ...SHOW_BY_KIND.summary];
}
