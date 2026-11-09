import { initSync } from 'parquet-wasm/esm';

// parquet-wasm's `node` build reads its .wasm relative to `__dirname`, which `bun build --compile` bakes in as the
// build machine's path. The ESM build takes the bytes instead, from a source the host registers (this folder stays
// free of Node modules: see `src/writer/parquet-wasm-source.ts`).
let source: (() => Uint8Array<ArrayBuffer>) | undefined;
let ready = false;

/** Registers where the WASM bytes come from; the codec calls it back once, before its first use. */
export function setParquetWasmSource(read: () => Uint8Array<ArrayBuffer>): void {
  source = read;
}

/** Initialises parquet-wasm once; synchronous, so the codec stays synchronous for its callers. */
export function ensureParquetWasm(): void {
  if (ready) return;
  if (source === undefined)
    throw new Error('no parquet-wasm source registered (src/writer/parquet-wasm-source.ts)');
  initSync({ module: source() });
  ready = true;
}
