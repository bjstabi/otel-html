import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { Table } from '@uwdata/flechette';
import { type Connector, Coordinator, type QueryResult, restConnector } from '@uwdata/mosaic-core';
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

function engineFailure(
  error: unknown,
  sql: string,
  describe?: (error: unknown) => string | undefined,
): OtelHtmlError {
  return new OtelHtmlError('invalid-report', {
    path: 'query',
    expected: 'a query the engine accepts',
    actual: describe?.(error) ?? (error instanceof Error ? error.message : String(error)),
    hint: sql,
  });
}

/**
 * The `QueryEngine` over a coordinator. `query` is `coordinator.query(q)`; an aborted signal rejects with
 * `DOMException('AbortError')` and calls `coordinator.cancel([result])`, which only reaches a request still queued in the
 * manager (a query waiting in the consolidator, or already running, is not cancelled: its result is discarded); the
 * generated SQL is attached to a failure as an `invalid-report` `OtelHtmlError` (its hint). `exec` sends
 * `{ type: 'exec', sql }` through the coordinator (so its cache sees the DDL); `registerText` and `close` delegate to
 * `files`. `clearCache` empties the result cache only (`coordinator.manager.cache().clear()`); queued and in-flight queries finish. `tempTables` (default true) is what the engine reports on the seam; the served path passes false (D43).
 * `describe`, when given, words a failure's `actual` (undefined keeps the error's own message).
 */
export function mosaicQueryEngine(
  coordinator: Coordinator,
  files: EngineFiles,
  tempTables = true,
  describe?: (error: unknown) => string | undefined,
): QueryEngine {
  return {
    tempTables,
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
        throw engineFailure(error, String(q), describe);
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
        throw engineFailure(error, sql, describe);
      }
    },
    async registerText(name: string, text: string): Promise<void> {
      await files.registerText(name, text);
    },
    clearCache(): void {
      // Not `coordinator.clear()`: its `manager.clear()` rejects queued queries and aborts those in flight.
      coordinator.manager.cache().clear();
    },
    async close(): Promise<void> {
      // reject queued queries before the worker goes away
      coordinator.clear();
      await files.close();
    },
  };
}

/** The ruled wording, then the host's own words when it sent any (each status has more than one cause on the host). */
function withBody(ruled: string, body: string): string {
  return body === '' ? ruled : `${ruled}: ${body}`;
}

/** What a failed host request means to the reader; a 400 keeps DuckDB's own message (mosaic words it `Query failed with HTTP status N: body`). */
function describeHostFailure(error: unknown): string | undefined {
  if (error instanceof TypeError) return 'the host did not answer (is otel-html host still running?)';
  const status = error instanceof Error ? /^Query failed with HTTP status (\d+): /.exec(error.message) : null;
  const detail = error instanceof Error && status ? error.message.slice(status[0].length).trim() : '';
  switch (status?.[1]) {
    case '400':
      return error instanceof Error ? error.message.slice(status[0].length) : undefined;
    case '413':
      return withBody("the result is larger than the host's --max-result-bytes", detail);
    case '503':
      return withBody('the host is busy or stopping', detail);
    case '504':
      return withBody('the host did not finish the query in time (--timeout)', detail);
    default:
      return undefined;
  }
}

/**
 * The `QueryEngine` of a served report (D43): mosaic-core's `restConnector` POSTs `{ type: 'arrow', sql }` to the host
 * at `endpoint` (`fetchImpl` is for tests). The host runs no DDL and a served report creates no temp tables, so
 * `tempTables` is false, and `registerText` and `exec` reject `usage`; `close` has nothing to release.
 */
export function restQueryEngine(endpoint: string, logger: Logger, fetchImpl?: typeof fetch): QueryEngine {
  const servedFiles: EngineFiles = {
    registerText() {
      return Promise.reject(
        new OtelHtmlError('usage', {
          path: 'registerText',
          expected: 'no temp tables',
          actual: 'a served report creates no temp tables',
        }),
      );
    },
    close() {},
  };
  const engine = mosaicQueryEngine(
    createCoordinator(
      restConnector({ uri: endpoint, method: 'POST', ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
      logger,
    ),
    servedFiles,
    false,
    describeHostFailure,
  );
  return {
    ...engine,
    exec() {
      return Promise.reject(
        new OtelHtmlError('usage', {
          path: 'exec',
          expected: 'queries only',
          actual: 'the host runs no DDL',
        }),
      );
    },
  };
}
