import type { ReportFormat } from '../config/schema.js';
import type { PartitionEntry, PartitionFile } from '../format/manifest.js';
import './parquet-wasm-source.js';
import { batchFromRows, type ColumnBatch } from '../format/parquet/batch.js';
import { checkRow, compareKeys, encodeColumns, sortKeyOf } from '../format/parquet/codec.js';
import { TABLE_COLUMNS, TABLES, type Table } from '../format/parquet/columns.js';
import type { Row } from '../format/parquet/rows.js';
import { type FileStatistics, fileStatistics } from '../format/parquet/stats.js';
import { encodeBatches, type PanicGuard, readColumns } from '../format/parquet/stream.js';
import { partitionDir, partitionFilePath, partitionKey, partitionWrapperPath } from '../format/paths.js';
import { OtelHtmlError } from '../model/errors.js';
import { at } from './checkpoint.js';
import type { FileSystem } from './ports.js';
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
  readonly #sets = new Map<string, Set<string> | null>();

  constructor(
    private readonly keys: readonly string[],
    private readonly cap: number,
  ) {
    for (const k of keys) this.#sets.set(k, new Set());
  }

  add(s: FileStatistics): void {
    this.#rows += s.rows;
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

/** A key that is unknown (`null`, or absent) in any input stays unknown: the merged rows cannot tell what a partition did not record. */
function keepUnknown(
  stats: FileStatistics,
  inputs: readonly PartitionFile[],
  keys: readonly string[],
): FileStatistics {
  const values: Record<string, string[] | null> = Object.create(null) as Record<string, string[] | null>;
  for (const k of keys) {
    const unknown = inputs.some((f) => f.values[k] === null || f.values[k] === undefined);
    values[k] = unknown ? null : (stats.values[k] ?? null);
  }
  return { ...stats, values };
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
async function aggregatePatterns(rows: AsyncIterable<Located>, byTemplate: boolean): Promise<Row[]> {
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
      const severities: Record<string, number> = {};
      for (const sev of [...a.severities.keys()].sort((x, y) => x - y)) {
        severities[String(sev)] = a.severities.get(sev) ?? 0;
      }
      return {
        cluster_id: a.id,
        template: a.template,
        count: a.count,
        first_time_unix_nano: a.first,
        last_time_unix_nano: a.last,
        severity_counts: JSON.stringify(severities),
        sample: text(cell(a.sample?.row, 'sample')) ?? null,
      };
    });
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
): Promise<{ size: number; stats: FileStatistics }> {
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
  const size = await writeChunks(
    fs,
    finalPath,
    mergeFiles(fs, table, level, opts.rowGroupRows, guard, (chunk) =>
      fold.add(fileStatistics(table, chunk, keys, opts.facetValueCap)),
    ),
  );
  for (const used of level) {
    if (temporary.includes(used)) await fs.remove(used);
  }
  return { size, stats: fold.result() };
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
 * Statistics come from the merged rows, except that a key unknown in any input stays unknown.
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
  try {
    for (const table of TABLES) {
      const inputs = inputsOf(entries, table);
      if (inputs.length === 0) continue;
      if (!created) {
        await fs.mkdirp(dir);
        created = true;
      }
      const keys = opts.statisticsKeys[table];
      const path = partitionFilePath(n, table);
      let size: number;
      let stats: FileStatistics;
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
          : aggregatePatterns(located(), byTemplate));
        for (const [i, row] of rows.entries()) checkRow(table, row, i);
        const batch = batchFromRows(table, rows);
        const bytes = encodeColumns(table, batch, { rowGroupRows: opts.rowGroupRows });
        await fs.writeBytes(at(out, path), bytes);
        size = bytes.length;
        stats = fileStatistics(table, batch, keys, opts.facetValueCap);
      } else {
        ({ size, stats } = await mergeTable(
          fs,
          dir,
          table,
          inputs.map((f) => at(out, f.path)),
          at(out, path),
          opts,
          guard,
        ));
        const expected = inputs.reduce((sum, f) => sum + f.rows, 0);
        if (stats.rows !== expected) {
          throw new OtelHtmlError('invalid-report', {
            path: partitionFilePath(n, table),
            expected: `${expected} rows, as the inputs list`,
            actual: `${stats.rows} rows merged`,
          });
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
      files[table] = { path, bytes: size, ...keepUnknown(stats, inputs, keys) };
    }
  } catch (e) {
    if (created) await fs.removeDir(dir).catch(() => undefined);
    throw e;
  } finally {
    watch.stop();
  }
  return { n, source: opts.source, files };
}
