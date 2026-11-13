import { attributesFromJson, attributesToJson } from '../format/columns.js';
import { ROLLUP_GRAIN_NS } from '../format/manifest.js';
import type { ColumnBatch } from '../format/parquet/batch.js';
import { durationBucket } from '../format/parquet/duration-bucket.js';
import type { Row } from '../format/parquet/rows.js';
import type { AnyValue } from '../model/anyvalue.js';
import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME, ATTR_HOST_NAME } from '../semconv/attributes.js';

const GRAIN = BigInt(ROLLUP_GRAIN_NS);

/** The columns behind the always-tracked facets (`SPAN_EXPRS` / `LOG_EXPRS` of `query/sql/facets.ts`). */
const CORE_COLUMNS = {
  spans: ['kind', 'name', 'resource_name', 'scope_name', 'service_name', 'status_code'],
  logs: ['event_name', 'has_trace', 'host_name', 'scope_name', 'service_name', 'severity_number'],
} as const;
const CORE_RESOURCE_KEYS = {
  spans: [`resource:${ATTR_HOST_NAME}`, `resource:${ATTR_DEPLOYMENT_ENVIRONMENT_NAME}`],
  logs: [],
} as const;

/**
 * What a table's rollup groups by, in the statistics-key grammar and sorted: the columns behind the core facets,
 * the core resource attributes, and the `attr:` / `resource:` keys among the table's statistics keys.
 */
export function rollupDimensions(table: 'spans' | 'logs', statisticsKeys: readonly string[]): string[] {
  const out = new Set<string>([...CORE_COLUMNS[table], ...CORE_RESOURCE_KEYS[table]]);
  for (const k of statisticsKeys) if (k.startsWith('attr:') || k.startsWith('resource:')) out.add(k);
  return [...out].sort();
}

/** `rollupRows ≤ max(4096, baseRows / 8)`: a rollup that does not shrink its table is not written. */
export function rollupAllowed(rollupRows: number, baseRows: number): boolean {
  return rollupRows <= rollupGroupLimit(baseRows);
}

const INT64_LIMIT = 2n ** 63n;

/** True when every rollup row's `duration_sum` fits the `int64` column; a row that does not fit is refused by `checkRow`, never wrapped. */
export function rollupSumsFit(rows: readonly Row[]): boolean {
  return rows.every((r) => {
    const sum = big(Reflect.get(r, 'duration_sum'));
    return sum === null || (sum >= -INT64_LIMIT && sum < INT64_LIMIT);
  });
}

/** The most rollup groups worth holding for a table of `baseRows` rows: `rollupAllowed` refuses every count above it. */
export function rollupGroupLimit(baseRows: number): number {
  return Math.max(4096, baseRows / 8);
}

const cell = (b: ColumnBatch, name: string, i: number): unknown => b.cells[name]?.[i];
const big = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);

/** The start of the grain holding `t`. */
function grainStart(t: bigint): bigint {
  return t - (((t % GRAIN) + GRAIN) % GRAIN);
}

/** Reduces attribute JSON text to the wanted keys, each value's text kept; null when the table keeps no key of it. */
class Reducer {
  readonly #keys: readonly string[];
  readonly #cache = new Map<string, string>();
  constructor(keys: readonly string[]) {
    this.#keys = keys;
  }

  get active(): boolean {
    return this.#keys.length > 0;
  }

  of(text: unknown): string | null {
    if (!this.active) return null;
    const source = typeof text === 'string' && text !== '' ? text : '{}';
    const hit = this.#cache.get(source);
    if (hit !== undefined) return hit;
    const all = source === '{}' ? new Map<string, AnyValue>() : attributesFromJson(source);
    const kept = new Map<string, AnyValue>();
    for (const k of this.#keys) {
      const v = all.get(k);
      if (v !== undefined) kept.set(k, v);
    }
    const reduced = attributesToJson(kept);
    if (this.#cache.size >= 4_096) this.#cache.clear();
    this.#cache.set(source, reduced);
    return reduced;
  }
}

const keysOf = (dimensions: readonly string[], prefix: string): string[] =>
  dimensions.filter((d) => d.startsWith(prefix)).map((d) => d.slice(prefix.length));

interface Acc {
  row: Row;
  n: bigint;
  sum: bigint;
  min: bigint;
  max: bigint;
}

function groupKey(parts: readonly unknown[]): string {
  return JSON.stringify(parts, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
}

/** Span rollup rows: one per distinct grain, dimensions and duration bucket, with count, sum, min and max of `duration_ns`. */
export function spanRollupRows(spans: ColumnBatch, dimensions: readonly string[]): Row[] {
  const resource = new Reducer(keysOf(dimensions, 'resource:'));
  const attrs = new Reducer(keysOf(dimensions, 'attr:'));
  const groups = new Map<string, Acc>();
  for (let i = 0; i < spans.length; i++) {
    const start = big(cell(spans, 'start_time_unix_nano', i));
    const duration = big(cell(spans, 'duration_ns', i)) ?? 0n;
    const bucket = durationBucket(duration);
    const row: Row = {
      start_time_unix_nano: start === null ? null : grainStart(start),
      service_name: cell(spans, 'service_name', i) ?? null,
      scope_name: cell(spans, 'scope_name', i) ?? null,
      name: cell(spans, 'name', i) ?? null,
      kind: cell(spans, 'kind', i) ?? null,
      status_code: cell(spans, 'status_code', i) ?? null,
      resource_name: cell(spans, 'resource_name', i) ?? null,
      resource_attributes: resource.of(cell(spans, 'resource_attributes', i)),
      attributes: attrs.of(cell(spans, 'attributes', i)),
      duration_bucket: bucket,
    };
    const key = groupKey(Object.values(row));
    const acc = groups.get(key);
    if (acc === undefined) groups.set(key, { row, n: 1n, sum: duration, min: duration, max: duration });
    else {
      acc.n++;
      acc.sum += duration;
      if (duration < acc.min) acc.min = duration;
      if (duration > acc.max) acc.max = duration;
    }
  }
  return [...groups.values()].map((a) => ({
    ...a.row,
    n: a.n,
    duration_sum: a.sum,
    duration_min: a.min,
    duration_max: a.max,
  }));
}

/** Log rollup rows: one per distinct grain of `coalesce(time, observed)` and dimensions, with a count. */
export function logRollupRows(logs: ColumnBatch, dimensions: readonly string[]): Row[] {
  const resource = new Reducer(keysOf(dimensions, 'resource:'));
  const attrs = new Reducer(keysOf(dimensions, 'attr:'));
  const groups = new Map<string, { row: Row; n: bigint }>();
  for (let i = 0; i < logs.length; i++) {
    const t = big(cell(logs, 'time_unix_nano', i)) ?? big(cell(logs, 'observed_time_unix_nano', i));
    const row: Row = {
      time_unix_nano: t === null ? null : grainStart(t),
      observed_time_unix_nano: null,
      service_name: cell(logs, 'service_name', i) ?? null,
      scope_name: cell(logs, 'scope_name', i) ?? null,
      severity_number: cell(logs, 'severity_number', i) ?? null,
      host_name: cell(logs, 'host_name', i) ?? null,
      event_name: cell(logs, 'event_name', i) ?? null,
      has_trace: cell(logs, 'trace_id', i) !== null && cell(logs, 'trace_id', i) !== undefined,
      resource_attributes: resource.of(cell(logs, 'resource_attributes', i)),
      attributes: attrs.of(cell(logs, 'attributes', i)),
    };
    const key = groupKey(Object.values(row));
    const acc = groups.get(key);
    if (acc === undefined) groups.set(key, { row, n: 1n });
    else acc.n++;
  }
  return [...groups.values()].map((a) => ({ ...a.row, n: a.n }));
}

/** The dimension with the most distinct values among `rows` (a rollup's rows), with that count; null for no dimension. */
export function widestDimension(
  rows: readonly Row[],
  dimensions: readonly string[],
): { dimension: string; distinct: number } | null {
  let best: { dimension: string; distinct: number } | null = null;
  for (const d of dimensions) {
    const seen = new Set<string>();
    for (const r of rows) seen.add(dimensionValue(r, d));
    if (best === null || seen.size > best.distinct) best = { dimension: d, distinct: seen.size };
  }
  return best;
}

function dimensionValue(row: Row, dimension: string): string {
  const colon = dimension.indexOf(':');
  if (colon < 0) return String(row[dimension] ?? '\u0000');
  const json = row[dimension.startsWith('attr:') ? 'attributes' : 'resource_attributes'];
  if (typeof json !== 'string') return '\u0000';
  const v = attributesFromJson(json).get(dimension.slice(colon + 1));
  return v === undefined
    ? '\u0000'
    : JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x));
}

const SUMMED = new Set(['n', 'duration_sum']);

/** Rollup rows added up as they arrive: rows with the same key (every column but the measures) fold together. */
export class RollupSum {
  readonly #groups = new Map<string, Row>();
  readonly #limit: number;
  #exceeded = false;

  /** `limit`: the group count past which the sum stops, drops its groups and reports `exceeded` (default: no limit). */
  constructor(limit: number = Number.POSITIVE_INFINITY) {
    this.#limit = limit;
  }

  /** True once the groups outgrew the limit: nothing is held and nothing more is added. */
  get exceeded(): boolean {
    return this.#exceeded;
  }

  add(rows: readonly Row[]): this {
    for (const row of rows) {
      if (this.#exceeded) break;
      const key = groupKey(Object.entries(row).filter(([k]) => !MEASURES.has(k)));
      const cur = this.#groups.get(key);
      if (cur === undefined) {
        this.#groups.set(key, { ...row });
        if (this.#groups.size > this.#limit) {
          this.#exceeded = true;
          this.#groups.clear();
        }
        continue;
      }
      for (const k of SUMMED) {
        const a = big(cur[k]);
        const b = big(row[k]);
        if (a !== null || b !== null) cur[k] = (a ?? 0n) + (b ?? 0n);
      }
      const lo = big(row[MIN]);
      const lc = big(cur[MIN]);
      if (lo !== null && (lc === null || lo < lc)) cur[MIN] = lo;
      const hi = big(row[MAX]);
      const hc = big(cur[MAX]);
      if (hi !== null && (hc === null || hi > hc)) cur[MAX] = hi;
    }
    return this;
  }

  get size(): number {
    return this.#groups.size;
  }

  rows(): Row[] {
    return [...this.#groups.values()];
  }
}

const MIN = 'duration_min';
const MAX = 'duration_max';
const MEASURES = new Set(['n', 'duration_sum', MIN, MAX]);

/** `a` and `b` (rollup rows of one table) added up: rows with the same key sum `n` and `duration_sum`, and keep the min of the mins and the max of the maxes. */
export function addRollupRows(a: readonly Row[], b: readonly Row[]): Row[] {
  return new RollupSum().add(a).add(b).rows();
}
