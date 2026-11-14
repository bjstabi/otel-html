import type { ReportFormat } from '../config/schema.js';
import {
  type PartitionEntry,
  type PartitionFile,
  ROLLUP_GRAIN_NS,
  type RollupDescription,
} from '../format/manifest.js';
import './parquet-wasm-source.js';
import { batchFromRows, type ColumnBatch } from '../format/parquet/batch.js';
import {
  addBloomFiltersToBlob,
  BLOOM_COLUMN,
  BLOOM_TABLES,
  BloomCollector,
} from '../format/parquet/bloom.js';
import { checkRow, compareKeys, encodeColumns, sortKeyOf } from '../format/parquet/codec.js';
import { ROLLUP_OF, type RollupTable, TABLE_COLUMNS, TABLES, type Table } from '../format/parquet/columns.js';
import type { Row } from '../format/parquet/rows.js';
import { type FileStatistics, fileStatistics, hasTimeEndMax, timeEndMaxOf } from '../format/parquet/stats.js';
import { encodeBatches, type PanicGuard, readColumns } from '../format/parquet/stream.js';
import { partitionDir, partitionFilePath, partitionKey, partitionWrapperPath } from '../format/paths.js';
import { OtelHtmlError } from '../model/errors.js';
import { at } from './checkpoint.js';
import type { FileSystem } from './ports.js';
import {
  logRollupRows,
  RollupSum,
  rollupAllowed,
  rollupDimensions,
  rollupGroupLimit,
  rollupSumsFit,
  spanRollupRows,
  widestDimension,
} from './rollup-rows.js';
import { watchWasmPanics } from './wasm-panic.js';
import { writeWrapperOfFile } from './wrapper-file.js';

export interface CompactOptions {
  /** The partition number the compacted files are written to. */
  nextPartition: number;
  rowGroupRows: number;
  statisticsKeys: Record<Table, string[]>;
  facetValueCap: number;
  /** `local` also writes each final file's base64 script after it (never for the merge temporaries). */
  format?: ReportFormat;
  /** The entry's `source`, `compact:<first>..<last>`. */
  source: string;
  /**
   * How `patterns` rows are matched across the partitions. `cluster` (the default) is one Drain lineage: rows of one
   * cluster id are summed and the latest template wins. `cluster-template` is for partitions of different lineages
   * (a merge's copies), whose ids collide: only rows with the same id and template are summed.
   */
  patternKey?: 'cluster' | 'cluster-template';
  /**
   * With `cluster`: the template each cluster id has in the highest partition of the whole report close, when this
   * compaction holds only one time group of it (`latestTemplates`). A cluster not listed keeps its own latest.
   */
  templates?: ReadonlyMap<string, string>;
  /** Where the guard's refusal of a rollup is told. */
  warn?: (message: string, attrs: Record<string, unknown>) => void;
}

/** The most time one compaction output may span, unless a single input does already: 24 hours, in nanoseconds. */
export const COMPACTION_SPAN_NS = 86_400_000_000_000n;

/**
 * Splits `inputs` into groups that are compacted separately, so that no output covers more than
 * `COMPACTION_SPAN_NS` between its earliest `timeMin` and its latest `timeMax`. Inputs are taken in order of `timeMin`
 * and added to the open group while the union stays within the bound; one input that spans more than the bound is a
 * group of its own (it is not made worse, and nothing else joins it). Inputs with no time join the first group that is
 * not such a long input, or are a group of their own when every group is.
 * The members of a group keep the order the caller gave them, and the groups follow time.
 */
export function timeGroups<T extends { timeMin: string | null; timeMax: string | null }>(
  inputs: readonly T[],
): T[][] {
  const timeless = inputs.filter((i) => i.timeMin === null || i.timeMax === null);
  const timed = inputs
    .filter((i) => i.timeMin !== null && i.timeMax !== null)
    .map((input, order) => ({
      input,
      order,
      min: BigInt(input.timeMin ?? 0),
      max: BigInt(input.timeMax ?? 0),
    }))
    .sort((a, b) => (a.min < b.min ? -1 : a.min > b.min ? 1 : a.order - b.order));
  const groups: { members: typeof timed; min: bigint; max: bigint; alone: boolean }[] = [];
  for (const t of timed) {
    const open = groups.at(-1);
    const long = t.max - t.min > COMPACTION_SPAN_NS;
    if (open !== undefined && !long && !open.alone) {
      let max = open.max;
      if (t.max > max) max = t.max;
      if (max - open.min <= COMPACTION_SPAN_NS) {
        open.members.push(t);
        open.max = max;
        continue;
      }
    }
    groups.push({ members: [t], min: t.min, max: t.max, alone: long });
  }
  const out = groups.map((g) => [...g.members].sort((a, b) => a.order - b.order).map((m) => m.input));
  if (timeless.length === 0) return out;
  const open = groups.findIndex((g) => !g.alone);
  const target = open < 0 ? undefined : out[open];
  if (target === undefined) return [timeless, ...out];
  target.unshift(...timeless);
  return out;
}

/** The tables whose rows carry the time a partition covers (not the rollups, which repeat it, nor `patterns`). */
const TIMED: readonly Table[] = ['spans', 'logs', 'points', 'traces'];

/** The earliest `timeMin` and latest `timeMax` of the partition's timed files; null when none has a time. */
export function timeRangeOf(entry: PartitionEntry): { timeMin: string | null; timeMax: string | null } {
  let min: bigint | null = null;
  let max: bigint | null = null;
  for (const t of TIMED) {
    const f = entry.files[t];
    if (f?.timeMin == null || f.timeMax == null) continue;
    const lo = BigInt(f.timeMin);
    const hi = BigInt(f.timeMax);
    if (min === null || lo < min) min = lo;
    if (max === null || hi > max) max = hi;
  }
  return { timeMin: min === null ? null : String(min), timeMax: max === null ? null : String(max) };
}

/** Rows a merge holds before it hands them to the writer; the Parquet writer still cuts row groups of `rowGroupRows`. */
const MERGE_CHUNK_ROWS = 4096;

const big = (v: unknown): bigint | null => (typeof v === 'bigint' ? v : null);
const cell = (r: Row | undefined, k: string): unknown => (r === undefined ? undefined : Reflect.get(r, k));
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

async function blobOf(fs: FileSystem, p: string): Promise<Blob> {
  if (fs.openBlob !== undefined) return fs.openBlob(p);
  return new Blob([new Uint8Array(await fs.readBytes(p))]);
}

/** The table's file in each entry that has one, in entry order. */
function inputsOf(entries: readonly PartitionEntry[], table: Table): PartitionFile[] {
  const files: PartitionFile[] = [];
  for (const e of entries) {
    const f = e.files[table];
    if (f !== undefined) files.push(f);
  }
  return files;
}

// -- k-way merge --------------------------------------------------------------------------------------------------

/** One sorted input: its decoded current record batch and the sort key of its current row. */
class Cursor {
  cols: unknown[][] = [];
  row = -1;
  length = 0;
  key: unknown[] = [];
  readonly #names: ReadonlyMap<string, number>;
  readonly #table: Table;

  constructor(
    table: Table,
    readonly index: number,
    readonly source: AsyncGenerator<unknown[][]>,
    names: ReadonlyMap<string, number>,
  ) {
    this.#table = table;
    this.#names = names;
  }

  get buffered(): boolean {
    return this.row + 1 < this.length;
  }

  /** Moves to the next row of the current batch; `buffered` must be true. */
  step(): void {
    this.row++;
    this.#setKey();
  }

  /** Loads the next record batch; false when the input is used up. */
  async load(): Promise<boolean> {
    const next = await this.source.next();
    if (next.done === true) return false;
    this.cols = next.value;
    this.length = next.value[0]?.length ?? 0;
    this.row = 0;
    this.#setKey();
    return true;
  }

  #setKey(): void {
    this.key = sortKeyOf(this.#table, (name) => {
      const c = this.#names.get(name);
      return c === undefined ? undefined : this.cols[c]?.[this.row];
    });
  }
}

/** Whether `a` comes before `b`: by sort key, then the earlier input (a stable merge). */
function before(a: Cursor, b: Cursor): boolean {
  for (let i = 0; i < a.key.length; i++) {
    const d = compareKeys(a.key[i], b.key[i]);
    if (d !== 0) return d < 0;
  }
  return a.index < b.index;
}

function siftDown(heap: Cursor[], from: number): void {
  let i = from;
  for (;;) {
    const l = 2 * i + 1;
    const r = l + 1;
    let m = i;
    const hl = heap[l];
    const hr = heap[r];
    const hm = heap[m];
    if (hl !== undefined && hm !== undefined && before(hl, hm)) m = l;
    const hm2 = heap[m];
    if (hr !== undefined && hm2 !== undefined && before(hr, hm2)) m = r;
    if (m === i) return;
    const a = heap[i];
    const b = heap[m];
    if (a === undefined || b === undefined) return;
    heap[i] = b;
    heap[m] = a;
    i = m;
  }
}

/**
 * Merges sorted inputs into batches of `MERGE_CHUNK_ROWS` rows. Every input is read a record batch at a time, so what
 * is held is one record batch (up to `READ_BATCH_ROWS` rows) per input plus the chunk being built.
 */
async function* mergeSorted(table: Table, inputs: readonly Cursor[]): AsyncGenerator<ColumnBatch> {
  const names = TABLE_COLUMNS[table].map((c) => c.name);
  const heap: Cursor[] = [];
  for (const c of inputs) if (await c.load()) heap.push(c);
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) siftDown(heap, i);
  let chunk: unknown[][] = names.map(() => []);
  const take = (): ColumnBatch => {
    const cells: Record<string, unknown[]> = {};
    for (const [i, name] of names.entries()) cells[name] = chunk[i] ?? [];
    const length = chunk[0]?.length ?? 0;
    chunk = names.map(() => []);
    return { length, cells };
  };
  while (heap.length > 0) {
    const top = heap[0];
    if (top === undefined) break;
    for (let c = 0; c < names.length; c++) chunk[c]?.push(top.cols[c]?.[top.row] ?? null);
    if ((chunk[0]?.length ?? 0) >= MERGE_CHUNK_ROWS) yield take();
    if (top.buffered) top.step();
    else if (!(await top.load())) {
      const last = heap.pop();
      if (last === undefined || heap.length === 0) break;
      if (last !== top) heap[0] = last;
    }
    siftDown(heap, 0);
  }
  if ((chunk[0]?.length ?? 0) > 0) yield take();
}

// -- statistics -----------------------------------------------------------------------------------------------------

/** Folds the statistics of consecutive chunks into those of their concatenation (the cap applies to the union). */
class StatisticsFold {
  #rows = 0;
  #min: bigint | null = null;
  #max: bigint | null = null;
  #end: string | null = null;
  readonly #sets = new Map<string, Set<string> | null>();

  constructor(
    private readonly keys: readonly string[],
    private readonly cap: number,
  ) {
    for (const k of keys) this.#sets.set(k, new Set());
  }

  add(s: FileStatistics, timeEndMax?: string | null): void {
    this.#rows += s.rows;
    if (timeEndMax !== undefined && timeEndMax !== null) {
      if (this.#end === null || BigInt(timeEndMax) > BigInt(this.#end)) this.#end = timeEndMax;
    }
    const lo = s.timeMin === null ? null : BigInt(s.timeMin);
    const hi = s.timeMax === null ? null : BigInt(s.timeMax);
    if (lo !== null && (this.#min === null || lo < this.#min)) this.#min = lo;
    if (hi !== null && (this.#max === null || hi > this.#max)) this.#max = hi;
    for (const k of this.keys) {
      const set = this.#sets.get(k);
      const vals = s.values[k];
      if (set === null || set === undefined) continue;
      if (vals === null || vals === undefined) {
        this.#sets.set(k, null);
        continue;
      }
      for (const v of vals) set.add(v);
      if (set.size > this.cap) this.#sets.set(k, null);
    }
  }

  /** The largest end time folded in (null when no row had one). */
  get timeEndMax(): string | null {
    return this.#end;
  }

  result(): FileStatistics {
    const values: Record<string, string[] | null> = Object.create(null) as Record<string, string[] | null>;
    for (const k of this.keys) {
      const set = this.#sets.get(k);
      values[k] = set === null || set === undefined ? null : [...set].sort();
    }
    return {
      rows: this.#rows,
      timeMin: this.#min === null ? null : this.#min.toString(),
      timeMax: this.#max === null ? null : this.#max.toString(),
      values,
    };
  }
}

// -- re-aggregated tables -------------------------------------------------------------------------------------------

interface Located {
  /** Position of the row's partition among the compacted ones: the lower wins a tie. */
  part: number;
  row: Row;
}

async function* rowsOf(table: Table, blob: Blob, path: string, guard: PanicGuard): AsyncGenerator<Row> {
  const names = TABLE_COLUMNS[table].map((c) => c.name);
  for await (const cols of readColumns(table, blob, path, undefined, guard)) {
    const n = cols[0]?.length ?? 0;
    for (let r = 0; r < n; r++) {
      const row: Row = {};
      for (const [c, name] of names.entries()) row[name] = cols[c]?.[r] ?? null;
      yield row;
    }
  }
}

/** Whether `a` is the better root candidate: the earlier start (a missing start loses), then the lower partition. */
function betterRoot(a: Located, b: Located): boolean {
  const sa = big(cell(a.row, 'start_time_unix_nano'));
  const sb = big(cell(b.row, 'start_time_unix_nano'));
  if (sa !== sb) return sa !== null && (sb === null || sa < sb);
  return a.part < b.part;
}

interface TraceAcc {
  spanStart: bigint | null;
  spanEnd: bigint | null;
  anyStart: bigint | null;
  anyEnd: bigint | null;
  hasSpans: boolean;
  spanCount: number;
  errorCount: number;
  logCount: number;
  root: Located | null;
}

function lower(a: bigint | null, b: bigint | null): bigint | null {
  return a === null ? b : b === null ? a : b < a ? b : a;
}
function upper(a: bigint | null, b: bigint | null): bigint | null {
  return a === null ? b : b === null ? a : b > a ? b : a;
}

/**
 * Per trace id: counts summed; the range is that of the rows with spans, or of all rows when none has spans; the
 * root columns come from the root row with the smallest start (the lower partition on a tie).
 */
async function aggregateTraces(rows: AsyncIterable<Located>): Promise<Row[]> {
  const acc = new Map<string, TraceAcc>();
  for await (const l of rows) {
    const id = text(cell(l.row, 'trace_id'));
    if (id === null) continue;
    let a = acc.get(id);
    if (a === undefined) {
      a = {
        spanStart: null,
        spanEnd: null,
        anyStart: null,
        anyEnd: null,
        hasSpans: false,
        spanCount: 0,
        errorCount: 0,
        logCount: 0,
        root: null,
      };
      acc.set(id, a);
    }
    const start = big(cell(l.row, 'start_time_unix_nano'));
    const end = big(cell(l.row, 'end_time_unix_nano'));
    const spans = Number(cell(l.row, 'span_count') ?? 0);
    a.spanCount += spans;
    a.errorCount += Number(cell(l.row, 'error_count') ?? 0);
    a.logCount += Number(cell(l.row, 'log_count') ?? 0);
    a.anyStart = lower(a.anyStart, start);
    a.anyEnd = upper(a.anyEnd, end);
    if (spans > 0) {
      a.hasSpans = true;
      a.spanStart = lower(a.spanStart, start);
      a.spanEnd = upper(a.spanEnd, end);
    }
    if (
      cell(l.row, 'root_name') !== null &&
      cell(l.row, 'root_name') !== undefined &&
      (a.root === null || betterRoot(l, a.root))
    ) {
      a.root = l;
    }
  }
  const out: Row[] = [];
  for (const [id, a] of acc) {
    out.push({
      trace_id: id,
      start_time_unix_nano: a.hasSpans ? a.spanStart : a.anyStart,
      end_time_unix_nano: a.hasSpans ? a.spanEnd : a.anyEnd,
      span_count: a.spanCount,
      error_count: a.errorCount,
      root_service: cell(a.root?.row, 'root_service') ?? null,
      root_name: cell(a.root?.row, 'root_name') ?? null,
      root_resource: cell(a.root?.row, 'root_resource') ?? null,
      log_count: a.logCount,
    });
  }
  // The order `traceRows` gives: start (a missing one last), then the trace id; the encoder keeps it for equal starts.
  return out.sort((x, y) => {
    const d = compareKeys(cell(x, 'start_time_unix_nano'), cell(y, 'start_time_unix_nano'));
    return d !== 0 ? d : compareKeys(cell(x, 'trace_id'), cell(y, 'trace_id'));
  });
}

interface PatternAcc {
  template: string;
  count: bigint;
  first: bigint | null;
  last: bigint | null;
  severities: Map<number, number>;
  sample: Located | null;
}

function severityCounts(json: unknown): [number, number][] {
  if (typeof json !== 'string' || json === '') return [];
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) return [];
  return Object.entries(parsed).map(([k, v]) => [Number(k), Number(v)]);
}

/**
 * Per cluster id (one Drain lineage), or with `byTemplate` per id and template (different lineages): counts summed; first the minimum and last the maximum; the template from the
 * highest partition; the sample from the row with the smallest first time (the lower partition on a tie).
 */
async function aggregatePatterns(
  rows: AsyncIterable<Located>,
  byTemplate: boolean,
  templates?: ReadonlyMap<string, string>,
): Promise<Row[]> {
  const acc = new Map<string, PatternAcc & { id: bigint }>();
  for await (const l of rows) {
    const id = big(cell(l.row, 'cluster_id'));
    if (id === null) continue;
    const key = byTemplate ? `${id}\u0000${text(cell(l.row, 'template')) ?? ''}` : String(id);
    let a = acc.get(key);
    if (a === undefined) {
      a = { id, template: '', count: 0n, first: null, last: null, severities: new Map(), sample: null };
      acc.set(key, a);
    }
    a.template = text(cell(l.row, 'template')) ?? a.template; // rows arrive in partition order: the last wins
    a.count += big(cell(l.row, 'count')) ?? 0n;
    const first = big(cell(l.row, 'first_time_unix_nano'));
    a.first = lower(a.first, first);
    a.last = upper(a.last, big(cell(l.row, 'last_time_unix_nano')));
    for (const [sev, n] of severityCounts(cell(l.row, 'severity_counts'))) {
      a.severities.set(sev, (a.severities.get(sev) ?? 0) + n);
    }
    if (a.sample === null) a.sample = l;
    else {
      const cur = big(cell(a.sample.row, 'first_time_unix_nano'));
      if (first !== null && (cur === null || first < cur)) a.sample = l;
    }
  }
  return [...acc.values()]
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((a): Row => {
      const template = byTemplate ? undefined : templates?.get(String(a.id));
      const severities: Record<string, number> = {};
      for (const sev of [...a.severities.keys()].sort((x, y) => x - y)) {
        severities[String(sev)] = a.severities.get(sev) ?? 0;
      }
      return {
        cluster_id: a.id,
        template: template ?? a.template,
        count: a.count,
        first_time_unix_nano: a.first,
        last_time_unix_nano: a.last,
        severity_counts: JSON.stringify(severities),
        sample: text(cell(a.sample?.row, 'sample')) ?? null,
      };
    });
}

/**
 * The template of each cluster id in the highest partition that has it, over `entries` (in partition order): what a
 * single compaction of all of them would write. Compacting by time group, each group gets these, so a pattern keeps
 * one template (one Patterns row) across the output partitions. `stale` are the partitions that hold a cluster with
 * another template: a group of one of them is rewritten, or it would keep the old row.
 */
export async function latestTemplates(
  fs: FileSystem,
  out: string,
  entries: readonly PartitionEntry[],
): Promise<{ templates: Map<string, string>; stale: Set<number> }> {
  const templates = new Map<string, string>();
  const held: { n: number; id: string; template: string }[] = [];
  const watch = watchWasmPanics();
  try {
    for (const e of entries) {
      const f = e.files.patterns;
      if (f === undefined) continue;
      for await (const row of rowsOf('patterns', await blobOf(fs, at(out, f.path)), f.path, watch.guard)) {
        const id = big(cell(row, 'cluster_id'));
        const template = text(cell(row, 'template'));
        if (id === null || template === null) continue;
        templates.set(String(id), template);
        held.push({ n: e.n, id: String(id), template });
      }
    }
  } finally {
    watch.stop();
  }
  return {
    templates,
    stale: new Set(held.filter((h) => templates.get(h.id) !== h.template).map((h) => h.n)),
  };
}

// -- rollups ----------------------------------------------------------------------------------------------------

type RollupPlan =
  | { how: 'sum'; description: RollupDescription }
  | { how: 'recompute'; description: RollupDescription };

const sameDescription = (a: RollupDescription, b: RollupDescription): boolean =>
  a.grainNs === b.grainNs &&
  a.durationBuckets === b.durationBuckets &&
  a.dimensions.length === b.dimensions.length &&
  a.dimensions.every((d, i) => d === b.dimensions[i]);

/**
 * How the compacted partition gets the rollup of `table`: null when no input has rows of its base table; the inputs'
 * rollups added up when every input with base rows has one and the descriptions are all equal; else recomputed from
 * the rows of the merge, with the dimensions this report's statistics keys give.
 */
function planRollup(
  entries: readonly PartitionEntry[],
  table: RollupTable,
  opts: CompactOptions,
): RollupPlan | null {
  const base = ROLLUP_OF[table];
  const withBase = entries.filter((e) => e.files[base] !== undefined);
  if (withBase.length === 0) return null;
  const descriptions = withBase.map((e) => e.files[table]?.rollup);
  const first = descriptions[0];
  if (first !== undefined && descriptions.every((d) => d !== undefined && sameDescription(d, first))) {
    return { how: 'sum', description: first };
  }
  return {
    how: 'recompute',
    description: {
      grainNs: ROLLUP_GRAIN_NS,
      dimensions: rollupDimensions(base, opts.statisticsKeys[base]),
      ...(table === 'span_rollups' ? { durationBuckets: 'log2x8' as const } : {}),
    },
  };
}

/**
 * The most rollup groups worth holding: `rollupAllowed` refuses more than `rollupGroupLimit(base rows)`, and the output
 * keeps every base row of the inputs (`compactPartitions` checks it), so the inputs' sum is the output's count.
 */
function groupLimitOf(entries: readonly PartitionEntry[], base: 'spans' | 'logs'): number {
  return rollupGroupLimit(inputsOf(entries, base).reduce((t, f) => t + f.rows, 0));
}

/**
 * The rows of the compacted partition's rollup: the inputs' rollup files added up, or the rows recomputed during the
 * merge; null when the groups outgrew the limit (they were dropped as soon as they did).
 */
async function rollupRowsOf(
  fs: FileSystem,
  out: string,
  entries: readonly PartitionEntry[],
  table: RollupTable,
  plan: RollupPlan,
  recomputed: RollupSum | undefined,
  guard: PanicGuard,
): Promise<Row[] | null> {
  if (plan.how === 'recompute')
    return recomputed === undefined ? [] : recomputed.exceeded ? null : recomputed.rows();
  const sum = new RollupSum(groupLimitOf(entries, ROLLUP_OF[table]));
  for (const f of inputsOf(entries, table)) {
    const rows: Row[] = [];
    for await (const row of rowsOf(table, await blobOf(fs, at(out, f.path)), f.path, guard)) rows.push(row);
    sum.add(rows);
    if (sum.exceeded) return null;
  }
  return sum.rows();
}

// -- compaction -----------------------------------------------------------------------------------------------------

/**
 * Files merged at once in the first round, whose inputs are flush partitions of one small row group each. An open
 * reader costs about 5 MB at `READ_BATCH_ROWS` (3.6 M `points` rows: peak 315 MB at 16 files, 404 MB at 32, 609 MB at
 * 64), and every round rewrites all the rows, so a larger fan-out saves time (4 800 partitions: 5 passes at 8, 4 at
 * 16) and costs memory.
 */
const FIRST_FANOUT = 16;

/**
 * Files merged at once after the first round: the files of the earlier rounds hold many rows in row groups of
 * `rowGroupRows`, and an open reader of one costs much more than one of a flush partition (about 9 MB against 5 MB,
 * and the metadata of its row groups), as does the file being written, whose size grows with every round: the last
 * round of a 72 M-point session peaked at 522 MB with 16 files and 50 000-row groups.
 */
const FANOUT = 8;

const fanoutOf = (round: number): number => (round === 0 ? FIRST_FANOUT : FANOUT);

/** Writes the chunks to `p` as they come where the file system can, else collects them and writes the bytes. Returns the size written. */
async function writeChunks(fs: FileSystem, p: string, chunks: AsyncIterable<Uint8Array>): Promise<number> {
  let size = 0;
  async function* counted(): AsyncGenerator<Uint8Array> {
    for await (const chunk of chunks) {
      size += chunk.length;
      yield chunk;
    }
  }
  if (fs.writeByteChunksAtomic !== undefined) {
    await fs.writeByteChunksAtomic(p, counted());
    return size;
  }
  const parts: Uint8Array[] = [];
  for await (const chunk of counted()) parts.push(chunk);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  await fs.writeBytes(p, bytes);
  return size;
}

/**
 * One merge of the sorted files at `paths` (given in order; ties go to the earlier file) into a Parquet file of row
 * groups of `rowGroupRows`. `onChunk` sees the merged rows as they go by.
 */
async function* mergeFiles(
  fs: FileSystem,
  table: Table,
  paths: readonly string[],
  rowGroupRows: number,
  guard: PanicGuard,
  onChunk?: (chunk: ColumnBatch) => void,
): AsyncGenerator<Uint8Array> {
  const names = new Map(TABLE_COLUMNS[table].map((c, i) => [c.name, i]));
  const generators: AsyncGenerator<unknown[][]>[] = [];
  const cursors: Cursor[] = [];
  try {
    for (const [i, p] of paths.entries()) {
      const g = readColumns(table, await blobOf(fs, p), p, undefined, guard);
      generators.push(g);
      cursors.push(new Cursor(table, i, g, names));
    }
    async function* chunks(): AsyncGenerator<ColumnBatch> {
      for await (const chunk of mergeSorted(table, cursors)) {
        onChunk?.(chunk);
        yield chunk;
      }
    }
    yield* encodeBatches(table, chunks(), { rowGroupRows }, guard);
  } finally {
    await Promise.all(generators.map((g) => g.return(undefined).catch(() => undefined)));
  }
}

/**
 * Merges the table's files into the table file of the compacted partition. With more files than the round's fan-out,
 * rounds of that many consecutive files (`FIRST_FANOUT`, then `FANOUT`) are merged into temporary files in `dir` first (consecutive, so the order of equal
 * keys is kept), and the last round writes the result to `finalPath`, whose statistics are folded from the rows as they pass.
 */
async function mergeTable(
  fs: FileSystem,
  dir: string,
  table: Table,
  inputs: readonly string[],
  finalPath: string,
  opts: CompactOptions,
  guard: PanicGuard,
  onRows?: (chunk: ColumnBatch) => void,
): Promise<{ size: number; stats: FileStatistics; timeEndMax: string | null }> {
  const keys = opts.statisticsKeys[table];
  let level: string[] = [...inputs];
  const temporary: string[] = [];
  for (let round = 0; level.length > fanoutOf(round); round++) {
    const fan = fanoutOf(round);
    const next: string[] = [];
    for (let g = 0; g < level.length; g += fan) {
      const group = level.slice(g, g + fan);
      const only = group[0];
      if (group.length === 1 && only !== undefined) {
        next.push(only);
        continue;
      }
      const path = at(dir, `.merge-${table}-${round}-${g / fan}.parquet`);
      // The final row group size, not a small one: parquet-wasm holds the metadata of every row group of a file it
      // writes or reads (about 30 KB each), so 4 096-row groups made a round's memory grow with the rows it merged.
      await writeChunks(fs, path, mergeFiles(fs, table, group, opts.rowGroupRows, guard));
      temporary.push(path);
      next.push(path);
      for (const used of group) {
        if (temporary.includes(used)) await fs.remove(used);
      }
    }
    level = next;
  }
  const fold = new StatisticsFold(keys, opts.facetValueCap);
  // Tables with a bloom filter on trace_id: the merge is written aside, then copied with the filters added before its footer.
  const bloom = BLOOM_TABLES.has(table) ? new BloomCollector(opts.rowGroupRows) : undefined;
  const merged = bloom === undefined ? finalPath : at(dir, `.bloom-${table}.parquet`);
  let size = await writeChunks(
    fs,
    merged,
    mergeFiles(fs, table, level, opts.rowGroupRows, guard, (chunk) => {
      fold.add(
        fileStatistics(table, chunk, keys, opts.facetValueCap),
        hasTimeEndMax(table) ? timeEndMaxOf(chunk) : undefined,
      );
      onRows?.(chunk);
      bloom?.add(chunk.cells[BLOOM_COLUMN] ?? []);
    }),
  );
  if (bloom !== undefined) {
    size = await writeChunks(fs, finalPath, addBloomFiltersToBlob(await blobOf(fs, merged), bloom.finish()));
    await fs.remove(merged);
  }
  for (const used of level) {
    if (temporary.includes(used)) await fs.remove(used);
  }
  return { size, stats: fold.result(), timeEndMax: fold.timeEndMax };
}

/**
 * Compacts the partitions `entries` (given in partition order) into one partition, `opts.nextPartition`, one file per
 * table, and returns its entry. The caller lists it and removes the old partitions; this writes only the new folder
 * and removes it again if anything fails.
 *
 * - spans, logs, points: every row is kept. Each input file is already sorted by the table's key, so the files are
 *   merged (a k-way merge, ties to the earlier partition; see `mergeTable` for the rounds) and written as they
 *   come. What is held is a small decoded batch per open file, one chunk of merged rows, and the compressed output.
 *   The bytes equal encoding the sorted union of the rows in one go (same sort, row groups and compression).
 * - traces, patterns: one row per trace or cluster across the partitions (see `aggregateTraces`,
 *   `aggregatePatterns`), folded into one accumulator per trace or cluster as the rows are read: what is held follows the distinct traces and clusters, not the rows of the inputs.
 *
 * Every input file's schema is checked first (`invalid-report` for a foreign or old file); nothing is converted.
 * Statistics come from the merged rows, so a key some input did not record is still known.
 */
export async function compactPartitions(
  fs: FileSystem,
  out: string,
  entries: readonly PartitionEntry[],
  opts: CompactOptions,
): Promise<PartitionEntry> {
  const n = opts.nextPartition;
  const dir = at(out, partitionDir(n));
  const files: Partial<Record<Table, PartitionFile>> = {};
  let created = false;
  const watch = watchWasmPanics();
  const { guard } = watch;
  const plans: Partial<Record<RollupTable, RollupPlan>> = {};
  for (const t of ['span_rollups', 'log_rollups'] as const) {
    const plan = planRollup(entries, t, opts);
    if (plan !== null) plans[t] = plan;
  }
  // Rollups recomputed from the rows the merge reads anyway, one chunk at a time.
  const recomputed: Partial<Record<RollupTable, RollupSum>> = {};
  const onRows = (table: Table): ((chunk: ColumnBatch) => void) | undefined => {
    const rt = table === 'spans' ? 'span_rollups' : table === 'logs' ? 'log_rollups' : null;
    const plan = rt === null ? undefined : plans[rt];
    if (rt === null || plan === undefined || plan.how !== 'recompute') return undefined;
    const sum = new RollupSum(groupLimitOf(entries, ROLLUP_OF[rt]));
    recomputed[rt] = sum;
    const make = rt === 'span_rollups' ? spanRollupRows : logRollupRows;
    return (chunk) => {
      if (sum.exceeded) return;
      sum.add(make(chunk, plan.description.dimensions));
    };
  };
  try {
    for (const table of TABLES) {
      const rollupTable = table === 'span_rollups' || table === 'log_rollups' ? table : null;
      const plan = rollupTable === null ? undefined : plans[rollupTable];
      if (rollupTable !== null && plan === undefined) continue;
      const inputs = inputsOf(entries, table);
      if (rollupTable === null && inputs.length === 0) continue;
      const keys = opts.statisticsKeys[table];
      const path = partitionFilePath(n, table);
      let size: number;
      let stats: FileStatistics;
      let timeEndMax: string | null | undefined;
      let rollup: RollupDescription | undefined;
      if (rollupTable !== null && plan !== undefined) {
        const rows = await rollupRowsOf(fs, out, entries, rollupTable, plan, recomputed[rollupTable], guard);
        const baseRows = files[ROLLUP_OF[rollupTable]]?.rows ?? 0;
        if (rows === null) {
          opts.warn?.(
            `the ${ROLLUP_OF[rollupTable]} rollup has more groups than ${rollupGroupLimit(baseRows)} and does not shrink this partition, so it is not written`,
            { baseRows, groupLimit: rollupGroupLimit(baseRows) },
          );
          continue;
        }
        if (!rollupSumsFit(rows)) {
          opts.warn?.(
            `the ${ROLLUP_OF[rollupTable]} rollup has a duration sum beyond the int64 range, so it is not written`,
            { rollupRows: rows.length, baseRows },
          );
          continue;
        }
        if (!rollupAllowed(rows.length, baseRows)) {
          const dimensions = plan.description.dimensions;
          const widest = widestDimension(rows, dimensions);
          opts.warn?.(
            `the ${ROLLUP_OF[rollupTable]} rollup does not shrink this partition, so it is not written`,
            {
              rollupRows: rows.length,
              baseRows,
              widestDimension: widest?.dimension,
              distinctValues: widest?.distinct,
            },
          );
          continue;
        }
        if (!created) {
          await fs.mkdirp(dir);
          created = true;
        }
        for (const [i, row] of rows.entries()) checkRow(table, row, i);
        const batch = batchFromRows(table, rows);
        const bytes = encodeColumns(table, batch, { rowGroupRows: opts.rowGroupRows });
        await fs.writeBytes(at(out, path), bytes);
        size = bytes.length;
        stats = fileStatistics(table, batch, keys, opts.facetValueCap);
        rollup = plan.description;
      } else {
        if (!created) {
          await fs.mkdirp(dir);
          created = true;
        }
        if (table === 'traces' || table === 'patterns') {
          async function* located(): AsyncGenerator<Located> {
            for (const [part, f] of inputs.entries()) {
              for await (const row of rowsOf(table, await blobOf(fs, at(out, f.path)), f.path, guard)) {
                yield { part, row };
              }
            }
          }
          // Each row is folded into its trace's or cluster's accumulator as it is read.
          const byTemplate = opts.patternKey === 'cluster-template';
          const rows = await (table === 'traces'
            ? aggregateTraces(located())
            : aggregatePatterns(located(), byTemplate, opts.templates));
          for (const [i, row] of rows.entries()) checkRow(table, row, i);
          const batch = batchFromRows(table, rows);
          const bytes = encodeColumns(table, batch, { rowGroupRows: opts.rowGroupRows });
          await fs.writeBytes(at(out, path), bytes);
          size = bytes.length;
          stats = fileStatistics(table, batch, keys, opts.facetValueCap);
          if (hasTimeEndMax(table)) timeEndMax = timeEndMaxOf(batch);
        } else {
          ({ size, stats, timeEndMax } = await mergeTable(
            fs,
            dir,
            table,
            inputs.map((f) => at(out, f.path)),
            at(out, path),
            opts,
            guard,
            onRows(table),
          ));
          const expected = inputs.reduce((sum, f) => sum + f.rows, 0);
          if (stats.rows !== expected) {
            throw new OtelHtmlError('invalid-report', {
              path: partitionFilePath(n, table),
              expected: `${expected} rows, as the inputs list`,
              actual: `${stats.rows} rows merged`,
            });
          }
          if (!hasTimeEndMax(table)) timeEndMax = undefined;
        }
      }
      // The wrapper of the local format is written from the finished file in chunks, after the merge has released its readers.
      if (opts.format === 'local') {
        await writeWrapperOfFile(
          fs,
          at(out, partitionWrapperPath(n, table)),
          partitionKey(n, table),
          at(out, path),
        );
      }
      files[table] = {
        path,
        bytes: size,
        ...stats,
        ...(timeEndMax === undefined ? {} : { timeEndMax }),
        ...(rollup === undefined ? {} : { rollup }),
      };
    }
  } catch (e) {
    if (created) await fs.removeDir(dir).catch(() => undefined);
    throw e;
  } finally {
    watch.stop();
  }
  return { n, source: opts.source, files };
}
