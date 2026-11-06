import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setParquetWasmSource } from '../format/parquet/wasm.js';

// Where the codec's WASM comes from: the package on Node; in a standalone binary the file its build entry embeds
// (`registerEmbeddedParquetWasm`), because a path inlined at build time would not exist on the user's machine.
let embeddedPath: string | undefined;

/**
 * Called by the binary build entry (generated in `scripts/build-binaries.ts`, so invisible to knip) with the path of
 * the embedded `parquet_wasm_bg.wasm`.
 * @public
 */
export function registerEmbeddedParquetWasm(path: string): void {
  embeddedPath = path;
}

setParquetWasmSource(() =>
  readFileSync(
    embeddedPath ?? createRequire(import.meta.url).resolve('parquet-wasm/esm/parquet_wasm_bg.wasm'),
  ),
);
