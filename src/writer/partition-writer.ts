import type { ReportFormat } from '../config/schema.js';
import type { PartitionEntry, PartitionFile } from '../format/manifest.js';
import './parquet-wasm-source.js';
import {
  batchFromRows,
  type ColumnBatch,
  concatBatches,
  emptyColumns,
  type MutableBatch,
  pushRow,
} from '../format/parquet/batch.js';
import { checkRow, encodeColumns } from '../format/parquet/codec.js';
import type { Row } from '../format/parquet/rows.js';
import { TABLES, type Table } from '../format/parquet/schema.js';
import { fileStatistics } from '../format/parquet/stats.js';
import { partitionDir, partitionFilePath, partitionKey, partitionWrapperPath } from '../format/paths.js';
import { at } from './checkpoint.js';
import type { FileSystem } from './ports.js';
import { writeWrapper } from './wrapper-file.js';

export interface PartitionWriterOptions {
  out: string;
  rowGroupRows: number;
  statisticsKeys: Record<Table, string[]>;
  facetValueCap: number;
  nextPartition: number;
  /** `local` also writes each Parquet file's base64 script (`<table>.parquet.js`) after the file. */
  format?: ReportFormat;
  /** Derives rows for other tables from the rows a cut took; see `Derived`. */
  derive?: (taken: Readonly<Record<Table, ColumnBatch>>) => Derived;
}

/**
 * What a derive hook returns. `rows` are written with the cut's own rows (they need not be held). `commit` runs
 * once, only after every file of the cut was written, so a stateful deriver changes its state only on success.
 */
interface Derived {
  rows: Partial<Record<Table, readonly Row[]>>;
  commit?: () => void;
}

const ROW_OVERHEAD_BYTES = 64;
const LIST_ELEMENT_BYTES = 8;

function emptyHeld(): Record<Table, MutableBatch> {
  const held = {} as Record<Table, MutableBatch>;
  for (const t of TABLES) held[t] = { length: 0, cells: emptyColumns(t) };
  return held;
}

/**
 * Holds rows per table, as one array per column, and writes them as one partition (a directory of Parquet files) on `cut`. It never touches
 * the manifest or the session state: the caller commits the returned entry.
 */
export class PartitionWriter {
  readonly #fs: FileSystem;
  readonly #opts: PartitionWriterOptions;
  #held: Record<Table, MutableBatch> = emptyHeld();
  #rows = 0;
  #bytes = 0;
  #next: number;
  #cutting = false;

  constructor(fs: FileSystem, opts: PartitionWriterOptions) {
    this.#fs = fs;
    this.#opts = opts;
    this.#next = opts.nextPartition;
  }

  /**
   * Holds a copy of the row's cells. The row must have passed `checkRow`: held rows are not checked again when they
   * are encoded (derived rows are).
   */
  add(table: Table, row: Row): void {
    const h = this.#held[table];
    pushRow(table, h.cells, row);
    h.length++;
    this.#rows++;
    let bytes = ROW_OVERHEAD_BYTES;
    for (const v of Object.values(row)) {
      if (typeof v === 'string') bytes += v.length;
      else if (Array.isArray(v)) bytes += LIST_ELEMENT_BYTES * v.length;
    }
    this.#bytes += bytes;
  }

  /** Rows held across every table. */
  get pendingRows(): number {
    return this.#rows;
  }

  /** Estimated bytes held, for the flush-by-size rule (string cell lengths, 8 per list element, and 64 per row). */
  get pendingBytes(): number {
    return this.#bytes;
  }

  get nextPartition(): number {
    return this.#next;
  }

  /** Takes partition numbers below `n` as used, for a partition written by other means (compaction). Never goes back. */
  skipTo(n: number): void {
    if (this.#cutting) throw new Error('PartitionWriter.skipTo called while a cut is in progress');
    this.#next = Math.max(this.#next, n);
  }

  /**
   * Takes the held rows at its start, so rows added while the files are being written land in the next partition.
   * Encodes every table first, then writes the files, so an encoding error writes nothing. If anything throws
   * (encoding or a write), the taken rows go back in front of the rows added since and `nextPartition` is
   * unchanged: the caller may abort or retry, and a retry rewrites the same partition directory. Cuts must not
   * overlap: a call while another cut is in progress throws. Tables with no rows get no file and no key in `files`. Returns null when nothing is held.
   */
  async cut(source: string): Promise<PartitionEntry | null> {
    if (this.#cutting) throw new Error('PartitionWriter.cut called while another cut is in progress');
    if (this.#rows === 0) return null;
    this.#cutting = true;
    const n = this.#next;
    const taken = {} as Record<Table, ColumnBatch>;
    for (const t of TABLES) taken[t] = this.#held[t];
    const takenRows = this.#rows;
    const takenBytes = this.#bytes;
    this.#held = emptyHeld();
    this.#rows = 0;
    this.#bytes = 0;
    try {
      // Synchronous, before any await: it sees exactly the rows this cut took. A throw restores them below.
      const derived = this.#opts.derive?.(taken);
      const encoded: { table: Table; batch: ColumnBatch; bytes: Uint8Array }[] = [];
      for (const table of TABLES) {
        // Held rows were checked when the session accepted them; derived rows were not.
        const derivedRows = derived?.rows[table] ?? [];
        for (const [i, row] of derivedRows.entries()) checkRow(table, row, i);
        const extra = batchFromRows(table, derivedRows);
        const batch = extra.length === 0 ? taken[table] : concatBatches(table, taken[table], extra);
        if (batch.length === 0) continue;
        encoded.push({
          table,
          batch,
          bytes: encodeColumns(table, batch, { rowGroupRows: this.#opts.rowGroupRows }),
        });
      }
      await this.#fs.mkdirp(at(this.#opts.out, partitionDir(n)));
      const files: Partial<Record<Table, PartitionFile>> = {};
      for (const { table, batch, bytes } of encoded) {
        const path = partitionFilePath(n, table);
        await this.#fs.writeBytes(at(this.#opts.out, path), bytes);
        if (this.#opts.format === 'local') {
          await writeWrapper(
            this.#fs,
            at(this.#opts.out, partitionWrapperPath(n, table)),
            partitionKey(n, table),
            bytes,
          );
        }
        files[table] = {
          path,
          bytes: bytes.length,
          ...fileStatistics(table, batch, this.#opts.statisticsKeys[table], this.#opts.facetValueCap),
        };
      }
      derived?.commit?.(); // before the number advances: a throw here leaves the cut retryable
      this.#next = n + 1;
      return { n, source, files };
    } catch (e) {
      for (const table of TABLES) this.#held[table] = concatBatches(table, taken[table], this.#held[table]);
      this.#rows += takenRows;
      this.#bytes += takenBytes;
      throw e;
    } finally {
      this.#cutting = false;
    }
  }
}
