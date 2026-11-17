import type { WidgetTraceIndexSpec } from '../config/widget-traces.js';
import type { WidgetIndexDescription } from '../format/manifest.js';
import type { ColumnBatch } from '../format/parquet/batch.js';
import { batchFromRows } from '../format/parquet/batch.js';
import { encodeColumns } from '../format/parquet/codec.js';
import { type ColumnDef, VAR_COLUMN_PREFIX, widgetTracesColumns } from '../format/parquet/columns.js';
import { type DecodedShared, type ResultRow, sharedFromRow, spanFromRow } from '../format/parquet/decode.js';
import type { Row } from '../format/parquet/rows.js';
import type { UnixNanos } from '../model/ids.js';
import { compileCondition } from '../ottl/compile.js';
import type { SpanTarget } from '../ottl/contexts.js';

/** A partition's index is written only while its own bytes stay within this share of its encoded `spans.parquet`. */
export const WIDGET_INDEX_SHARE = 0.05;

/**
 * Whether a `widget_traces` table of `indexBytes` may be written beside `spansBytes` of spans. The table is weighed by
 * its own bytes: `emptyBytes` (the same columns with no row) is the file's fixed cost and is not counted.
 */
export function widgetIndexAllowed(indexBytes: number, emptyBytes: number, spansBytes: number): boolean {
  return indexBytes - emptyBytes <= WIDGET_INDEX_SHARE * spansBytes;
}

/** What a writer tells when the guard refuses a partition's index (`widgetIndexAllowed`), and with which attributes. */
export function widgetIndexTooLarge(
  index: CompiledWidgetIndex,
  indexBytes: number,
  spansBytes: number,
): [message: string, attrs: Record<string, unknown>] {
  return [
    'the widget trace index of this partition is not written: it would weigh over 5 % of the spans file',
    { conditions: index.conditions.map((c) => c.source), indexBytes, spansBytes },
  ];
}

/** What a writer tells when a partition's `WidgetTraceSet` is not exact (Amendment 1). */
export function widgetIndexInexact(
  index: CompiledWidgetIndex,
): [message: string, attrs: Record<string, unknown>] {
  return [
    'the widget trace index of this partition is not written: its span times are more than 2^53 ns apart',
    { conditions: index.conditions.map((c) => c.source) },
  ];
}

export interface CompiledWidgetIndex {
  readonly conditions: readonly { id: string; source: string; test: (t: SpanTarget) => boolean }[];
  readonly variables: readonly string[];
  readonly columns: readonly ColumnDef[];
  readonly description: WidgetIndexDescription;
}

/** The index a report writes: its conditions compiled, its columns and its manifest entry; null with no condition. */
export function compileWidgetIndex(spec: WidgetTraceIndexSpec): CompiledWidgetIndex | null {
  if (spec.conditions.length === 0) return null;
  return {
    conditions: spec.conditions.map(({ id, source }) => ({
      id,
      source,
      test: compileCondition(source, 'span').test,
    })),
    variables: spec.variables,
    columns: widgetTracesColumns(spec.variables),
    description: {
      conditions: spec.conditions.map((c) => c.id).sort(),
      variables: [...spec.variables].sort(),
    },
  };
}

const TIME_COLUMNS = ['start_time_unix_nano', 'end_time_unix_nano'] as const;
const SHARED_COLUMNS = [
  'resource_attributes',
  'resource_schema_url',
  'resource_dropped_attributes_count',
  'scope_name',
  'scope_version',
  'scope_attributes',
  'scope_schema_url',
  'scope_dropped_attributes_count',
] as const;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const column = (b: ColumnBatch, name: string): readonly unknown[] => b.cells[name] ?? [];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The distinct (condition, trace, variable values) rows of the spans that match an indexed condition. Spans are
 * decoded with times relative to each chunk's smallest start, so a `Number` keeps nanoseconds while a chunk spans no
 * more than 2^53 ns; a chunk that spans more makes the set inexact, and an inexact set is never written.
 */
export class WidgetTraceSet {
  readonly #index: CompiledWidgetIndex;
  readonly #rows = new Map<string, Row>();
  #exact = true;

  constructor(index: CompiledWidgetIndex) {
    this.#index = index;
  }

  /** False once a chunk's times lay too far apart for `Number` to hold their offsets exactly. */
  get exact(): boolean {
    return this.#exact;
  }

  get size(): number {
    return this.#rows.size;
  }

  add(batch: ColumnBatch): void {
    const starts = column(batch, 'start_time_unix_nano');
    const ends = column(batch, 'end_time_unix_nano');
    let origin: bigint | null = null;
    for (let i = 0; i < batch.length; i++) {
      const s = starts[i];
      if (typeof s === 'bigint' && (origin === null || s < origin)) origin = s;
    }
    if (origin === null) {
      // No decoded start (a path that returned numbers): the offsets cannot be computed, so the set is not exact.
      if (batch.length > 0) this.#exact = false;
      return;
    }
    for (let i = 0; i < batch.length; i++) {
      for (const t of [starts[i], ends[i]])
        if (typeof t === 'bigint' && (t - origin > MAX_SAFE || origin - t > MAX_SAFE)) this.#exact = false;
    }
    // Rows of one resource and scope are many: their JSON is decoded once per distinct value in this chunk.
    const memo = new Map<string, DecodedShared>();
    const sharedOf = (r: ResultRow): DecodedShared => {
      const key = JSON.stringify(SHARED_COLUMNS.map((c) => (r[c] === null ? null : String(r[c]))));
      let v = memo.get(key);
      if (v === undefined) {
        v = sharedFromRow(r);
        memo.set(key, v);
      }
      return v;
    };
    const names = Object.keys(batch.cells);
    for (let i = 0; i < batch.length; i++) {
      const row: Record<string, unknown> = {};
      for (const name of names) row[name] = batch.cells[name]?.[i] ?? null;
      for (const c of TIME_COLUMNS) {
        const v = row[c];
        if (typeof v === 'bigint') row[c] = v - origin;
      }
      // No span path reads events or links (only their dropped counts), so they are not decoded.
      Reflect.set(row, 'events', '[]');
      Reflect.set(row, 'links', '[]');
      const traceId = Reflect.get(row, 'trace_id');
      if (typeof traceId !== 'string') continue;
      const { span, shared } = spanFromRow(row, origin, sharedOf);
      const target: SpanTarget = {
        span,
        resource: shared.resource,
        scope: shared.scope,
        epoch: origin as UnixNanos,
      };
      let values: (string | null)[] | null = null;
      for (const c of this.#index.conditions) {
        if (!c.test(target)) continue;
        values ??= this.#index.variables.map((key) => {
          const v = shared.resource.attributes.get(key);
          return v?.kind === 'string' ? v.value : null;
        });
        const id = JSON.stringify([c.id, traceId, values]);
        if (this.#rows.has(id)) continue;
        const out: Row = { condition: c.id, trace_id: traceId };
        for (const [k, key] of this.#index.variables.entries()) {
          out[`${VAR_COLUMN_PREFIX}${key}`] = values[k] ?? null;
        }
        this.#rows.set(id, out);
      }
    }
  }

  /** The rows, sorted by condition, then trace id, then the variable values. */
  rows(): Row[] {
    const vars = this.#index.variables.map((k) => `${VAR_COLUMN_PREFIX}${k}`);
    const text = (r: Row, k: string): string => {
      const v = r[k];
      return typeof v === 'string' ? v : '';
    };
    return [...this.#rows.values()].sort((a, b) => {
      let d =
        cmp(text(a, 'condition'), text(b, 'condition')) || cmp(text(a, 'trace_id'), text(b, 'trace_id'));
      for (const k of vars) d ||= cmp(text(a, k), text(b, k));
      return d;
    });
  }
}

/** The `widget_traces.parquet` bytes of `rows`. */
export function encodeWidgetTraces(
  rows: readonly Row[],
  index: CompiledWidgetIndex,
  rowGroupRows: number,
): Uint8Array {
  return encodeColumns('widget_traces', batchFromRows('widget_traces', rows, index.columns), {
    rowGroupRows,
    columns: index.columns,
  });
}
