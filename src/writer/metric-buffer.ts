import {
  type BucketSeries,
  bucketIndex,
  EXEMPLAR_WIDTH_NS,
  mergeBucketSeries,
  type StoredExemplar,
  selectExemplars,
} from '../format/metric-files.js';
import { type BucketAgg, type CounterAgg, mergeAgg, type NumberAgg } from '../rollups/metric-agg.js';

/** Fields per bucket of the columnar kinds. */
const STRIDE = { counter: 2, number: 6 } as const;
type ColumnKind = keyof typeof STRIDE;
const INITIAL_ROWS = 256;

interface SeriesBuffer {
  t: number[];
  a: BucketAgg[];
}

/**
 * Counter and number buckets in typed arrays, one row per (series, bucket): no object per bucket, so a large
 * buffer neither costs much heap nor leaves old-generation garbage behind when it is written out. A series'
 * rows are appended in bucket order; `last` finds the row of its latest bucket.
 */
class Columns {
  readonly kind: ColumnKind;
  readonly stride: number;
  n = 0;
  sid: Int32Array;
  idx: Int32Array;
  v: Float64Array;
  readonly last = new Map<number, number>();

  constructor(kind: ColumnKind) {
    this.kind = kind;
    this.stride = STRIDE[kind];
    this.sid = new Int32Array(INITIAL_ROWS);
    this.idx = new Int32Array(INITIAL_ROWS);
    this.v = new Float64Array(INITIAL_ROWS * this.stride);
  }

  /** Merges into the series' latest bucket or appends a later one; false when `idx` is older (caller keeps it). */
  add(series: number, idx: number, a: CounterAgg | NumberAgg): 'merged' | 'appended' | 'older' {
    const row = this.last.get(series);
    const at = row === undefined ? undefined : this.idx[row];
    if (row !== undefined && at === idx) {
      this.#mergeInto(row, a);
      return 'merged';
    }
    if (at !== undefined && idx < at) return 'older';
    if (this.n === this.sid.length) this.#grow();
    const r = this.n++;
    this.sid[r] = series;
    this.idx[r] = idx;
    this.#set(r, a);
    this.last.set(series, r);
    return 'appended';
  }

  #grow(): void {
    const cap = this.sid.length * 2;
    const sid = new Int32Array(cap);
    sid.set(this.sid);
    const idx = new Int32Array(cap);
    idx.set(this.idx);
    const v = new Float64Array(cap * this.stride);
    v.set(this.v);
    this.sid = sid;
    this.idx = idx;
    this.v = v;
  }

  #set(r: number, a: CounterAgg | NumberAgg): void {
    const o = r * this.stride;
    const v = this.v;
    if (a.k === 'counter') {
      v[o] = a.delta;
      v[o + 1] = a.resets;
    } else {
      v[o] = a.count;
      v[o + 1] = a.sum;
      v[o + 2] = a.min;
      v[o + 3] = a.max;
      v[o + 4] = a.last;
      v[o + 5] = a.lastTime;
    }
  }

  /** In place, exactly as `mergeAgg(current, a)`. */
  #mergeInto(r: number, a: CounterAgg | NumberAgg): void {
    const o = r * this.stride;
    const v = this.v;
    if (a.k === 'counter') {
      v[o] = (v[o] ?? 0) + a.delta;
      v[o + 1] = (v[o + 1] ?? 0) + a.resets;
      return;
    }
    v[o] = (v[o] ?? 0) + a.count;
    v[o + 1] = (v[o + 1] ?? 0) + a.sum;
    v[o + 2] = Math.min(v[o + 2] ?? a.min, a.min);
    v[o + 3] = Math.max(v[o + 3] ?? a.max, a.max);
    if (a.lastTime >= (v[o + 5] ?? a.lastTime)) {
      v[o + 4] = a.last;
      v[o + 5] = a.lastTime;
    }
  }

  aggAt(r: number): BucketAgg {
    const o = r * this.stride;
    const v = this.v;
    if (this.kind === 'counter') return { k: 'counter', delta: v[o] ?? 0, resets: v[o + 1] ?? 0 };
    return {
      k: 'number',
      count: v[o] ?? 0,
      sum: v[o + 1] ?? 0,
      min: v[o + 2] ?? 0,
      max: v[o + 3] ?? 0,
      last: v[o + 4] ?? 0,
      lastTime: v[o + 5] ?? 0,
    };
  }

  series(): BucketSeries[] {
    const by = new Map<number, BucketSeries>();
    for (let r = 0; r < this.n; r++) {
      const id = this.sid[r] ?? 0;
      let s = by.get(id);
      if (s === undefined) {
        s = { id, t: [], a: [] };
        by.set(id, s);
      }
      s.t.push(this.idx[r] ?? 0);
      s.a.push(this.aggAt(r));
    }
    return [...by.values()].sort((x, y) => x.id - y.id);
  }
}

/** One metric's level-0 buckets and exemplars since they were last written out. */
export class MetricBuffer {
  readonly #exemplarCap: number;
  #columns: Columns | null = null;
  /** Histogram, exponential and summary buckets, and points older than their series' latest bucket. */
  readonly #objects = new Map<number, SeriesBuffer>();
  readonly #exemplars = new Map<string, StoredExemplar[]>();
  #buckets = 0;

  constructor(exemplarCap: number) {
    this.#exemplarCap = exemplarCap;
  }

  /** Buckets held (an upper bound: an old bucket kept apart may share its index with a columnar one). */
  get buckets(): number {
    return this.#buckets;
  }

  get empty(): boolean {
    return this.#buckets === 0 && this.#exemplars.size === 0;
  }

  add(series: number, idx: number, agg: BucketAgg, path: string): void {
    if (agg.k === 'counter' || agg.k === 'number') {
      this.#columns ??= new Columns(agg.k);
      if (this.#columns.kind === agg.k) {
        const r = this.#columns.add(series, idx, agg);
        if (r === 'appended') this.#buckets++;
        if (r !== 'older') return;
      }
    }
    this.#addObject(series, idx, agg, path);
  }

  #addObject(series: number, idx: number, agg: BucketAgg, path: string): void {
    let buf = this.#objects.get(series);
    if (buf === undefined) {
      buf = { t: [], a: [] };
      this.#objects.set(series, buf);
    }
    let i = buf.t.length;
    while (i > 0 && (buf.t[i - 1] ?? 0) > idx) i--; // points arrive mostly in time order: scan from the end
    const j = i - 1;
    const prev = buf.a[j];
    if (j >= 0 && buf.t[j] === idx && prev !== undefined) {
      buf.a[j] = mergeAgg(prev, agg, path);
      return;
    }
    buf.t.splice(i, 0, idx);
    buf.a.splice(i, 0, agg);
    this.#buckets++;
  }

  addExemplars(list: readonly StoredExemplar[]): void {
    for (const e of list) {
      const key = `${e.series}:${bucketIndex(e.time, EXEMPLAR_WIDTH_NS)}`;
      const kept = this.#exemplars.get(key);
      if (kept === undefined) this.#exemplars.set(key, [e]);
      else {
        kept.push(e);
        if (kept.length > this.#exemplarCap)
          this.#exemplars.set(key, selectExemplars(kept, this.#exemplarCap));
      }
    }
  }

  /** The buffered buckets by series, sorted by id. */
  series(path: string): BucketSeries[] {
    const cols = this.#columns?.series() ?? [];
    if (this.#objects.size === 0) return cols;
    const objects = [...this.#objects].map(([id, b]) => ({ id, t: b.t, a: b.a }));
    return mergeBucketSeries([cols, objects], path);
  }

  exemplars(): StoredExemplar[] {
    return [...this.#exemplars.values()].flat().sort((a, b) => a.time - b.time || a.series - b.series);
  }
}
