import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostEngineFiles } from '../src/host/engine-files.js';

/** The Node engine files from the installed `@duckdb/duckdb-wasm` package, so host tests need no `mise run build`. */
export function packageHostEngineFiles(): HostEngineFiles {
  const bindings = createRequire(import.meta.url).resolve('@duckdb/duckdb-wasm/dist/duckdb-node.cjs');
  const dist = dirname(bindings);
  return {
    bindings,
    worker: join(dist, 'duckdb-node-eh.worker.cjs'),
    wasm: join(dist, 'duckdb-eh.wasm'),
    extensions: {
      parquet: fileURLToPath(
        new URL('../.cache/duckdb-extensions/parquet.duckdb_extension.wasm', import.meta.url),
      ),
      json: fileURLToPath(new URL('../.cache/duckdb-extensions/json.duckdb_extension.wasm', import.meta.url)),
    },
    close: async () => {},
  };
}
