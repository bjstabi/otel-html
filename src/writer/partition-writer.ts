import type { PartitionEntry, PartitionFile } from '../format/manifest.js';
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
}

const ROW_OVERHEAD_BYTES = 64;

/**
 * Holds rows per table and writes them as one partition (a directory of Parquet files) on `cut`. It never touches
 * the manifest or the session state: the caller commits the returned entry.
 */
export class PartitionWriter {
  readonly #fs: FileSystem;
  readonly #opts: PartitionWriterOptions;
  readonly #held: Record<Table, Row[]> = { spans: [], logs: [], points: [], traces: [], patterns: [] };
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
   * Encodes every table first, then writes the files, so an encoding error writes nothing. If anything throws
   * (encoding or a write), the rows stay held and `nextPartition` is unchanged: the caller may abort or retry, and
   * a retry rewrites the same partition directory. On success the held rows are released.
   * Tables with no rows get no file and no key in `files`. Returns null when nothing is held.
   */
  async cut(source: string): Promise<PartitionEntry | null> {
    if (this.#rows === 0) return null;
    const n = this.#next;
    const encoded: { table: Table; rows: Row[]; bytes: Uint8Array }[] = [];
    for (const table of TABLES) {
      const rows = this.#held[table];
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
    for (const table of TABLES) this.#held[table] = [];
    this.#rows = 0;
    this.#bytes = 0;
    this.#next = n + 1;
    return { n, source, files };
  }
}
