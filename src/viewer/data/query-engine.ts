import type { Table } from '@uwdata/flechette';
import type { Query } from '@uwdata/mosaic-sql';

/** The one seam between the data source and whatever runs SQL (D19). No Mosaic value is imported here. */
export interface QueryEngine {
  /**
   * Whether the engine can hold the D5 temp table of a residual condition's ids. False for the served path (D43): the
   * host runs SELECTs only, so an aggregate with a residual condition is refused.
   */
  readonly tempTables: boolean;
  /** Runs one query; int64 columns decode as bigint. An aborted signal rejects with `DOMException('AbortError')`. */
  query(q: Query, signal?: AbortSignal): Promise<Table>;
  /** A statement without a result: the view creation at start, the D5 temp table. */
  exec(sql: string): Promise<void>;
  /** Registers a text file a later statement reads (D5: `read_csv`). */
  registerText(name: string, text: string): Promise<void>;
  /** Forgets every cached result; after a Refresh replaced the registered files (D55). Clients and queued queries stay. */
  clearCache(): void;
  close(): Promise<void>;
}

/** What the engine does besides SQL; `Engine` and `TestDb` both satisfy it. */
export interface EngineFiles {
  registerText(name: string, text: string): void | Promise<void>;
  close(): void | Promise<void>;
}
