import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { Table } from '@uwdata/flechette';
import { type Connector, Coordinator, type QueryResult } from '@uwdata/mosaic-core';
import type { Query } from '@uwdata/mosaic-sql';
import { OtelHtmlError } from '../../model/errors.js';
import type { EngineFiles, QueryEngine } from './query-engine.js';

export type Logger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

function runSql(connection: AsyncDuckDBConnection, sql: string): Promise<Uint8Array> {
  // biome-ignore lint/correctness/useHookAtTopLevel: useUnsafe is DuckDB's connection API, not a React hook
  return connection.useUnsafe((bindings, id) => bindings.runQuery(id, sql));
}

/**
 * A hand-written mosaic Connector over a duckdb-wasm connection, not `DuckDBWASMConnector` (D19): `type: 'arrow'`
 * returns the IPC bytes of `connection.useUnsafe((bindings, id) => bindings.runQuery(id, sql))`; `type: 'exec'` runs
 * the same and resolves undefined; `type: 'json'` is rejected with `invalid-report` (never requested).
 */
export function engineConnector(connection: AsyncDuckDBConnection): Connector {
  // The mosaic `signal` option is ignored: duckdb-wasm cannot abort a running query, its result is discarded.
  async function query(request: { type: string; sql: string }): Promise<Uint8Array | undefined> {
    if (request.type === 'arrow') return await runSql(connection, request.sql);
    if (request.type === 'exec') {
      await runSql(connection, request.sql);
      return undefined;
    }
    throw new OtelHtmlError('invalid-report', {
      path: 'query',
      expected: "a request of type 'arrow' or 'exec'",
      actual: `type '${request.type}'`,
    });
  }
  return { query } as Connector;
}

const noGroups = { group() {}, groupCollapsed() {}, groupEnd() {} };

/** `new Coordinator(connector, { logger, cache: true, consolidate: true, ipc: { useBigInt: true, useDate: false }, preagg: { enabled: false } })`. */
export function createCoordinator(connector: Connector, logger: Logger): Coordinator {
  return new Coordinator(connector, {
    // mosaic's Logger also wants log/group*, which nothing here uses
    logger: { ...noGroups, ...logger, log: logger.info },
    cache: true,
    consolidate: true,
    ipc: { useBigInt: true, useDate: false },
    preagg: { enabled: false },
  });
}

function abortError(): DOMException {
  return new DOMException('The query was aborted', 'AbortError');
}

function engineFailure(error: unknown, sql: string): OtelHtmlError {
  return new OtelHtmlError('invalid-report', {
    path: 'query',
    expected: 'a query the engine accepts',
    actual: error instanceof Error ? error.message : String(error),
    hint: sql,
  });
}

/**
 * The `QueryEngine` over a coordinator. `query` is `coordinator.query(q)`; an aborted signal rejects with
 * `DOMException('AbortError')` and calls `coordinator.cancel([result])`, which only reaches a request still queued in the
 * manager (a query waiting in the consolidator, or already running, is not cancelled: its result is discarded); the
 * generated SQL is attached to a failure as an `invalid-report` `OtelHtmlError` (its hint). `exec` sends
 * `{ type: 'exec', sql }` through the coordinator (so its cache sees the DDL); `registerText` and `close` delegate to
 * `files`.
 */
export function mosaicQueryEngine(coordinator: Coordinator, files: EngineFiles): QueryEngine {
  return {
    async query(q: Query, signal?: AbortSignal): Promise<Table> {
      if (signal?.aborted) throw abortError();
      const result: QueryResult<Table> = coordinator.query(q);
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          // reject first: cancel() synchronously rejects `result` with 'Canceled', which would win the race
          reject(abortError());
          coordinator.cancel([result]);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([result, aborted]);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw engineFailure(error, String(q));
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        // a request cancelled by the abort rejects `result` too; that rejection is handled here
        result.catch(() => undefined);
      }
    },
    async exec(sql: string): Promise<void> {
      try {
        await coordinator.exec(sql);
      } catch (error) {
        throw engineFailure(error, sql);
      }
    },
    async registerText(name: string, text: string): Promise<void> {
      await files.registerText(name, text);
    },
    async close(): Promise<void> {
      // reject queued queries before the worker goes away
      coordinator.clear();
      await files.close();
    },
  };
}
