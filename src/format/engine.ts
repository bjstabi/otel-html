/**
 * The DuckDB-WASM version the report's engine files must match: the exact `@duckdb/duckdb-wasm` version in
 * `package.json` (a test checks it). `scripts/engine-assets.ts` names the files in `dist/viewer/assets/` by it.
 */
export const ENGINE_VERSION = '1.32.0';

/**
 * The engine files a report of this format copies into its `assets/`, as file names. A `site` report is served
 * over http and takes the plain files; a `local` report opens from `file://`, where only classic scripts load, and
 * takes the base64 wrappers. A `chunks` report has no engine.
 */
export function engineAssetNames(format: 'local' | 'site'): string[] {
  const base = `duckdb.${ENGINE_VERSION}`;
  return format === 'site'
    ? [`${base}.wasm`, `${base}.worker.js`]
    : [`${base}.wasm.gz.b64.js`, `${base}.worker.b64.js`];
}

/** The keys under which the `local` wrappers push the gzipped WASM and the worker onto `__OH__`. */
export const ENGINE_WASM_KEY = 'engine/wasm.gz';
export const ENGINE_WORKER_KEY = 'engine/worker';
