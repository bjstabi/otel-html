/**
 * The DuckDB-WASM version the report's engine files must match: the exact `@duckdb/duckdb-wasm` version in
 * `package.json` (a test checks it). `scripts/engine-assets.ts` names the files in `dist/viewer/assets/` by it.
 */
export const ENGINE_VERSION = '1.32.0';

/** The DuckDB extensions the viewer's SQL needs: `read_parquet` and the JSON functions. */
export const ENGINE_EXTENSIONS = ['parquet', 'json'] as const;
export type EngineExtension = (typeof ENGINE_EXTENSIONS)[number];

/**
 * The file a report carries an extension as. A `site` report serves the signed binary as it is, named
 * `<extension>.<engine version>.duckdb_extension.wasm` (DuckDB takes the extension name, hence its entry point,
 * from the part of the last URL segment before the first dot, so the version may follow it). A `local` report opens
 * from `file://`, where only classic scripts load, and takes a gzipped base64 wrapper named by the engine version.
 */
export function engineExtensionName(format: 'local' | 'site', extension: EngineExtension): string {
  return format === 'site'
    ? `${extension}.${ENGINE_VERSION}.duckdb_extension.wasm`
    : `duckdb.${ENGINE_VERSION}.${extension}.ext.gz.b64.js`;
}

/**
 * The engine files a report of this format copies into its `assets/`, as file names: the WASM, the worker, then
 * one file per extension. A `site` report is served over http and takes the plain files; a `local` report opens
 * from `file://`, where only classic scripts load, and takes the base64 wrappers.
 */
export function engineAssetNames(format: 'local' | 'site'): string[] {
  const base = `duckdb.${ENGINE_VERSION}`;
  const core =
    format === 'site'
      ? [`${base}.wasm`, `${base}.worker.js`]
      : [`${base}.wasm.gz.b64.js`, `${base}.worker.b64.js`];
  return [...core, ...ENGINE_EXTENSIONS.map((e) => engineExtensionName(format, e))];
}

/**
 * The DuckDB-WASM Node build the host runs: the `AsyncDuckDB` bindings and the worker, named by engine version.
 * Shipped in the viewer's assets folder, never copied into a report.
 */
export function engineNodeAssetNames(): { bindings: string; worker: string } {
  const base = `duckdb.${ENGINE_VERSION}`;
  return { bindings: `${base}.node.cjs`, worker: `${base}.node.worker.cjs` };
}

/** The keys under which the `local` wrappers push the gzipped WASM and the worker onto `__OH__`. */
export const ENGINE_WASM_KEY = 'engine/wasm.gz';
export const ENGINE_WORKER_KEY = 'engine/worker';
/** The key under which a `local` extension wrapper pushes the gzipped extension. */
export const engineExtensionKey = (extension: EngineExtension): string => `engine/ext/${extension}.gz`;
