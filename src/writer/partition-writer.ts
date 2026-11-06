import type { PartitionEntry, PartitionFile } from '../format/manifest.js';
import './parquet-wasm-source.js';
import { encodeTable } from '../format/parquet/codec.js';
import type { Row } from '../format/parquet/rows.js';
import { TABLES, type Table } from '../format/parquet/schema.js';
import { fileStatistics } from '../format/parquet/stats.js';
import { partitionDir, partitionFilePath } from '../format/paths.js';
import { at } from './checkpoint.js';
import type { FileSystem } from './ports.js';

export interface PartitionWriterOptions {
  out: string;
  rowGroupRows: number;
  statisticsKeys: Record<Table, string[]>;
  facetValueCap: number;
  nextPartition: number;
  /** Derives rows for other tables from the rows a cut took; see `Derived`. */
  derive?: (taken: Readonly<Record<Table, readonly Row[]>>) => Derived;
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

function emptyHeld(): Record<Table, Row[]> {
  return { spans: [], logs: [], points: [], traces: [], patterns: [] };
}

/**
 * Holds rows per table and writes them as one partition (a directory of Parquet files) on `cut`. It never touches
 * the manifest or the session state: the caller commits the returned entry.
 */
export class PartitionWriter {
  readonly #fs: FileSystem;
  readonly #opts: PartitionWriterOptions;
  #held: Record<Table, Row[]> = emptyHeld();
  #rows = 0;
  #bytes = 0;
  #next: number;

  constructor(fs: FileSystem, opts: PartitionWriterOptions) {
    this.#fs = fs;
    this.#opts = opts;
    this.#next = opts.nextPartition;
  }

  add(table: Table, row: Row): void {
    this.#held[table].push(row);
    this.#rows++;
    let bytes = ROW_OVERHEAD_BYTES;
    for (const v of Object.values(row)) if (typeof v === 'string') bytes += v.length;
    this.#bytes += bytes;
  }

  /** Rows held across every table. */
  get pendingRows(): number {
    return this.#rows;
  }

  /** Estimated bytes held, for the flush-by-size rule (sum of string cell lengths plus 64 per row). */
  get pendingBytes(): number {
    return this.#bytes;
  }

  get nextPartition(): number {
    return this.#next;
  }

  /**
   * Takes the held rows at its start, so rows added while the files are being written land in the next partition.
   * Encodes every table first, then writes the files, so an encoding error writes nothing. If anything throws
   * (encoding or a write), the taken rows go back in front of the rows added since and `nextPartition` is
   * unchanged: the caller may abort or retry, and a retry rewrites the same partition directory. Callers run one cut
   * at a time. Tables with no rows get no file and no key in `files`. Returns null when nothing is held.
   */
  async cut(source: string): Promise<PartitionEntry | null> {
    if (this.#rows === 0) return null;
    const n = this.#next;
    const taken = this.#held;
    const takenRows = this.#rows;
    const takenBytes = this.#bytes;
    this.#held = emptyHeld();
    this.#rows = 0;
    this.#bytes = 0;
    try {
      // Synchronous, before any await: it sees exactly the rows this cut took. A throw restores them below.
      const derived = this.#opts.derive?.(taken);
      const encoded: { table: Table; rows: Row[]; bytes: Uint8Array }[] = [];
      for (const table of TABLES) {
        const rows = [...taken[table], ...(derived?.rows[table] ?? [])];
        if (rows.length === 0) continue;
        encoded.push({
          table,
          rows,
          bytes: encodeTable(table, rows, { rowGroupRows: this.#opts.rowGroupRows }),
        });
      }
      await this.#fs.mkdirp(at(this.#opts.out, partitionDir(n)));
      const files: Partial<Record<Table, PartitionFile>> = {};
      for (const { table, rows, bytes } of encoded) {
        const path = partitionFilePath(n, table);
        await this.#fs.writeBytes(at(this.#opts.out, path), bytes);
        files[table] = {
          path,
          bytes: bytes.length,
          ...fileStatistics(table, rows, this.#opts.statisticsKeys[table], this.#opts.facetValueCap),
        };
      }
      this.#next = n + 1;
      derived?.commit?.();
      return { n, source, files };
    } catch (e) {
      for (const table of TABLES) this.#held[table] = [...taken[table], ...this.#held[table]];
      this.#rows += takenRows;
      this.#bytes += takenBytes;
      throw e;
    }
  }
}
