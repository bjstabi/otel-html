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
  createDuckDB(bundles: unknown, logger: unknown, runtime: unknown): Promise<DuckDbInstance>;
}

interface DuckDbInstance {
  instantiate(): Promise<void>;
  registerFileBuffer(name: string, buf: Uint8Array): void;
  registerFileText(name: string, text: string): void;
  dropFiles(names?: string[]): void;
  reset(): void;
  connect(): NodeConnection;
}

// The Node build is CommonJS; `require` also finds the WASM bundles that sit next to it (see parquet-metadata.ts).
const require = createRequire(import.meta.url);
const ENTRY = '@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs';

const { OTEL_HTML_DUCKDB_POOL: POOL_ENV } = process.env;
const idle: DuckDbInstance[] = [];
const stats = { created: 0, reused: 0 };

/** How many instances this module (one per test file) created and how many opens reused an idle one. */
export function testDbPoolStats(): { created: number; reused: number } {
  return { ...stats };
}

async function createInstance(): Promise<DuckDbInstance> {
  const duckdb = require(ENTRY) as DuckDbNode;
  const dist = dirname(require.resolve(ENTRY));
  const bundles = {
    mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
    eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
  };
  const db = await duckdb.createDuckDB(bundles, new duckdb.ConsoleLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  stats.created++;
  return db;
}

/**
 * A DuckDB-WASM Node blocking database for tests. Pooled by default (`OTEL_HTML_DUCKDB_POOL=0` or `{ pooled: false }`
 * gives a fresh instance): `close()` drops the registered files and resets the instance, and every open turns the
 * parquet metadata and file caches off, so a later open that registers other bytes under the same name reads them.
 */
export async function openTestDb(opts: { pooled?: boolean } = {}): Promise<TestDb> {
  const pooled = opts.pooled ?? POOL_ENV !== '0';
  const reuse = pooled ? idle.pop() : undefined;
  if (reuse) stats.reused++;
  const db = reuse ?? (await createInstance());
  const conn = db.connect();
  let closed = false;
  if (pooled) {
    conn.query('SET enable_object_cache = false');
    conn.query('SET enable_external_file_cache = false');
  }
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
    close() {
      if (closed) return; // the data source and the test may both close; a second push would hand one instance to two opens
      closed = true;
      conn.close();
      if (!pooled) return;
      db.dropFiles();
      db.reset();
      idle.push(db);
    },
  };
}
