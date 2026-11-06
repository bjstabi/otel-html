import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface ColumnChunkMetadata {
  readonly path_in_schema: string;
  readonly row_group_id: number;
  readonly compression: string;
  readonly row_group_num_rows: number;
  readonly stats_min_value: string | null;
  readonly stats_max_value: string | null;
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
    connect(): {
      query(sql: string): { toArray(): { toJSON(): unknown }[] };
      close(): void;
    };
  }>;
}

// The Node build is CommonJS; `require` also finds the WASM bundles that sit next to it. Knip cannot see this
// dependency, so it is listed under ignoreDependencies.
const require = createRequire(import.meta.url);
const ENTRY = '@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs';

/** The `parquet_metadata` rows of a Parquet file, read by DuckDB-WASM's Node build (test-only). */
export async function parquetMetadata(bytes: Uint8Array): Promise<ColumnChunkMetadata[]> {
  const duckdb = require(ENTRY) as DuckDbNode;
  const dist = dirname(require.resolve(ENTRY));
  const bundles = {
    mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
    eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
  };
  const db = await duckdb.createDuckDB(bundles, new duckdb.ConsoleLogger(), duckdb.NODE_RUNTIME);
  await db.instantiate();
  db.registerFileBuffer('f.parquet', bytes);
  const conn = db.connect();
  try {
    return conn
      .query("SELECT * FROM parquet_metadata('f.parquet')")
      .toArray()
      .map((r) => {
        const row = r.toJSON() as Omit<ColumnChunkMetadata, 'row_group_id' | 'row_group_num_rows'> & {
          row_group_id: bigint;
          row_group_num_rows: bigint;
        };
        // DuckDB hands BIGINT columns back as bigint
        return {
          ...row,
          row_group_id: Number(row.row_group_id),
          row_group_num_rows: Number(row.row_group_num_rows),
        } as ColumnChunkMetadata;
      });
  } finally {
    conn.close();
  }
}
