import type { Table } from '@uwdata/flechette';
import type { Query } from '@uwdata/mosaic-sql';

/** One statement of a batch and the signal that cancels it. */
export interface BatchItem {
  query: Query;
  signal?: AbortSignal | undefined;
}

/** The one seam between the data source and whatever runs SQL (D19). No Mosaic value is imported here. */
export interface QueryEngine {
  /**
   * Whether the engine can hold the D5 temp table of a residual condition's ids. False for the served path (D43): the
   * host runs SELECTs only, so an aggregate with a residual condition is refused.
   */
  readonly tempTables: boolean;
  /** Runs one query; int64 columns decode as bigint. An aborted signal rejects with `DOMException('AbortError')`. */
  query(q: Query, signal?: AbortSignal): Promise<Table>;
  /**
   * Starts the statements one page issued together, in input order, and returns one promise per statement in the same
   * order, each settling as its own statement does (a failure rejects only its own) and each carrying its own signal,
   * which cancels that statement as `query` would. An engine that cannot do better than one at a time passes
   * `sequentialBatch(engine)`; a server engine resolves them all from one response.
   */
  queryBatch(items: readonly BatchItem[]): Promise<Table>[];
  /** A statement without a result: the view creation at start, the D5 temp table. */
  exec(sql: string): Promise<void>;
  /** Registers a text file a later statement reads (D5: `read_csv`). */
  registerText(name: string, text: string): Promise<void>;
  /** Forgets every cached result; after a Refresh replaced the registered files (D55). Clients, queued queries and queries in flight stay and finish. */
  clearCache(): void;
  /** Makes these files cheap to read before a statement that reads them. Resolves even when a file could not be fetched. */
  prepare(paths: readonly string[], signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** What the engine does besides SQL; `Engine` and `TestDb` both satisfy it. */
export interface EngineFiles {
  registerText(name: string, text: string): void | Promise<void>;
  close(): void | Promise<void>;
}

/** `queryBatch` for an engine that runs one statement at a time: `query` per statement, started in order, each settling on its own. */
export function sequentialBatch(engine: Pick<QueryEngine, 'query'>): QueryEngine['queryBatch'] {
  return (items) => items.map((i) => engine.query(i.query, i.signal));
}
