import type { ColumnSpec } from '../format/columns.js';
import { encodeColumns } from '../format/columns.js';
import { wrapDataFile } from '../format/data-file.js';
import type { ManifestChunk } from '../format/manifest.js';
import { chunkKey, chunkPath, type Signal } from '../format/paths.js';
import { LOG_COLUMNS, METRIC_COLUMNS, SPAN_COLUMNS } from '../format/specs.js';
import type { AnyValue, Attributes } from '../model/anyvalue.js';
import type { RelNanos } from '../model/ids.js';
import type {
  LogRecordRecord,
  MetricPointRecord,
  ResourceRecord,
  ScopeRecord,
  SpanRecord,
} from '../model/records.js';

const encoder = new TextEncoder();

function valueSize(v: AnyValue): number {
  switch (v.kind) {
    case 'string':
      return v.value.length + 2;
    case 'bool':
      return 5;
    case 'int':
    case 'double':
      return 12;
    case 'bytes':
      return Math.ceil(v.value.length / 3) * 4 + 8;
    case 'array':
      return v.values.reduce((n, x) => n + valueSize(x) + 1, 2);
    case 'kvlist':
      return attributesSize(v.values);
    case 'empty':
      return 4;
  }
}

function attributesSize(a: Attributes): number {
  let n = 2;
  for (const [k, v] of a) n += k.length + valueSize(v) + 6;
  return n;
}

/** Cheap estimate of a record's decoded (in-memory/JSON) size; chunks are cut on this, not on exact bytes. */
export function estimateSpanBytes(s: SpanRecord): number {
  let n = 230 + s.name.length + s.traceState.length + s.status.message.length + attributesSize(s.attributes);
  for (const e of s.events) n += 40 + e.name.length + attributesSize(e.attributes);
  for (const l of s.links) n += 120 + attributesSize(l.attributes);
  return n;
}

export function estimateLogBytes(l: LogRecordRecord): number {
  return 160 + l.severityText.length + l.eventName.length + valueSize(l.body) + attributesSize(l.attributes);
}

export function estimateMetricBytes(p: MetricPointRecord): number {
  return (
    150 +
    p.name.length +
    p.description.length +
    p.unit.length +
    attributesSize(p.attributes) +
    (JSON.stringify(p.point)?.length ?? 4)
  );
}

export interface SignalSpec<R> {
  readonly signal: Signal;
  readonly columns: ColumnSpec<R>;
  /** Inclusive time range of a row, in RelNanos. */
  readonly range: (row: R) => readonly [number, number];
  readonly estimate: (row: R) => number;
}

export const SPAN_SIGNAL: SignalSpec<SpanRecord> = {
  signal: 'spans',
  columns: SPAN_COLUMNS,
  range: (s) => [s.start, Math.max(s.start, s.end)],
  estimate: estimateSpanBytes,
};

/** Logs without any timestamp are placed at the epoch. */
export function logTime(l: LogRecordRecord): RelNanos {
  return l.time ?? l.observedTime ?? (0 as RelNanos);
}

export const LOG_SIGNAL: SignalSpec<LogRecordRecord> = {
  signal: 'logs',
  columns: LOG_COLUMNS,
  range: (l) => [logTime(l), logTime(l)],
  estimate: estimateLogBytes,
};

export const METRIC_SIGNAL: SignalSpec<MetricPointRecord> = {
  signal: 'metrics',
  columns: METRIC_COLUMNS,
  range: (p) => [Math.min(p.start ?? p.time, p.time), p.time],
  estimate: estimateMetricBytes,
};

export interface BuiltChunk {
  readonly entry: ManifestChunk;
  readonly bytes: Uint8Array;
  /** Estimated decoded size of the rows in the chunk. */
  readonly decodedBytes: number;
}

/** Accumulates rows of one signal and cuts them into numbered chunks. */
export class ChunkBuffer<R> {
  readonly #spec: SignalSpec<R>;
  #rows: R[] = [];
  #estimate = 0;
  #n: number;

  constructor(spec: SignalSpec<R>, nextChunk: number) {
    this.#spec = spec;
    this.#n = nextChunk;
  }

  /** The number of the chunk the buffered rows will be written to. */
  get pendingNumber(): number {
    return this.#n;
  }

  get pendingKey(): string {
    return chunkKey(this.#spec.signal, this.#n);
  }

  get length(): number {
    return this.#rows.length;
  }

  push(row: R): void {
    this.#rows.push(row);
    this.#estimate += this.#spec.estimate(row);
  }

  isFull(targetBytes: number): boolean {
    return this.#estimate >= targetBytes;
  }

  /**
   * Encode the buffered rows without consuming them; null when empty. Call `commit` once the chunk file has
   * been written, so a failed write leaves the rows (and the chunk number) in place for a retry.
   */
  build(resources: readonly ResourceRecord[], scopes: readonly ScopeRecord[]): BuiltChunk | null {
    if (this.#rows.length === 0) return null;
    const rows = this.#rows;
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      const [a, b] = this.#spec.range(row);
      if (a < start) start = a;
      if (b > end) end = b;
    }
    const payload = encodeColumns(this.#spec.columns, rows, resources, scopes);
    const bytes = encoder.encode(wrapDataFile(chunkKey(this.#spec.signal, this.#n), payload));
    return {
      entry: {
        signal: this.#spec.signal,
        n: this.#n,
        path: chunkPath(this.#spec.signal, this.#n),
        start,
        end,
        count: rows.length,
        bytes: bytes.length,
      },
      bytes,
      decodedBytes: this.#estimate,
    };
  }

  /** Drop the rows that were encoded into `chunk` and advance to the next chunk number. */
  commit(chunk: BuiltChunk): void {
    if (chunk.entry.n !== this.#n) {
      throw new Error(`invariant violated: committing chunk ${chunk.entry.n}, expected ${this.#n}`);
    }
    this.#rows = [];
    this.#estimate = 0;
    this.#n++;
  }
}
