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
  /**
   * Runs the statements one page issued together; one settled entry per statement, in input order, so a failed
   * statement rejects only its own caller. An engine that cannot do better than one at a time passes
   * `sequentialBatch(engine)`. `signal` aborts every statement of the batch that has not finished.
   */
  queryBatch(qs: readonly Query[], signal?: AbortSignal): Promise<PromiseSettledResult<Table>[]>;
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

/** `queryBatch` for an engine that runs one statement at a time: `query` per statement, in order, each settled on its own. */
export function sequentialBatch(engine: Pick<QueryEngine, 'query'>): QueryEngine['queryBatch'] {
  return (qs, signal) =>
    Promise.all(
      qs.map(
        (q): Promise<PromiseSettledResult<Table>> =>
          engine.query(q, signal).then(
            (value) => ({ status: 'fulfilled', value }),
            (reason: unknown) => ({ status: 'rejected', reason }),
          ),
      ),
    );
}
