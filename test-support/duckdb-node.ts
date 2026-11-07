import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Structurally `Connector` of `@uwdata/mosaic-core` (an `arrow` request resolves to IPC bytes, an `exec` one to nothing).
 * Importing that type would pull mosaic-core's declarations into the root typecheck, which needs DOM types they assume.
 */
export interface TestConnector {
  query(query: { type: 'arrow'; sql: string }, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  query(query: { type: 'exec'; sql: string }, options?: { signal?: AbortSignal }): Promise<void>;
  readonly requests: readonly { type: string; sql: string }[];
}

export interface TestDb {
  registerFile(name: string, bytes: Uint8Array): void;
  /** `db.registerFileText`; makes TestDb an `EngineFiles` (Task 1.5). */
  registerText(name: string, text: string): void;
  exec(sql: string): void;
  rows(sql: string): Record<string, unknown>[];
  /** A mosaic Connector over this database: `type: 'arrow'` returns the IPC bytes of `bindings.runQuery(conn, sql)`; it records every request in `requests` (tests count statements). */
  connector: TestConnector;
  close(): void;
}

interface NodeConnection {
  query(sql: string): { toArray(): { toJSON(): unknown }[] };
  useUnsafe<R>(
    callback: (bindings: { runQuery(conn: number, sql: string): Uint8Array }, conn: number) => R,
  ): R;
  close(): void;
}

/** The slice of DuckDB-WASM's Node blocking build used here (its own typings need Emscripten and DOM types). */
interface DuckDbNode {
  readonly NODE_RUNTIME: unknown;
  readonly ConsoleLogger: new () => unknown;
  createDuckDB(
    bundles: unknown,
    logger: unknown,
    runtime: unknown,
  ): Promise<{
    instantiate(): Promise<void>;
    registerFileBuffer(name: string, buf: Uint8Array): void;
    registerFileText(name: string, text: string): void;
    connect(): NodeConnection;
  }>;
}

// The Node build is CommonJS; `require` also finds the WASM bundles that sit next to it (see parquet-metadata.ts).
const require = createRequire(import.meta.url);
const ENTRY = '@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs';

/** A DuckDB-WASM Node blocking database for tests. */
export async function openTestDb(): Promise<TestDb> {
  const duckdb = require(ENTRY) as DuckDbNode;
  const dist = dirname(require.resolve(ENTRY));
  const bundles = {
    mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
    eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
  };
  const db = await duckdb.createDuckDB(bundles, new duckdb.ConsoleLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  const conn = db.connect();
  const requests: { type: string; sql: string }[] = [];
  const connector = {
    requests,
    query(request: { type: string; sql: string }): Promise<Uint8Array | undefined> {
      requests.push({ type: request.type, sql: request.sql });
      try {
        // biome-ignore lint/correctness/useHookAtTopLevel: useUnsafe is DuckDB's connection API, not a React hook
        const bytes = conn.useUnsafe((bindings, id) => bindings.runQuery(id, request.sql));
        return Promise.resolve(request.type === 'exec' ? undefined : bytes);
      } catch (e) {
        return Promise.reject(e);
      }
    },
  } as unknown as TestDb['connector'];
  return {
    registerFile: (name, bytes) => db.registerFileBuffer(name, bytes),
    registerText: (name, text) => db.registerFileText(name, text),
    exec(sql) {
      conn.query(sql);
    },
    rows: (sql) =>
      conn
        .query(sql)
        .toArray()
        .map((r) => r.toJSON() as Record<string, unknown>),
    connector,
    close: () => conn.close(),
  };
}
