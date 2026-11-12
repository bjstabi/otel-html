import { AsyncDuckDB, type AsyncDuckDBConnection, VoidLogger } from '@duckdb/duckdb-wasm';
import {
  ENGINE_EXTENSIONS,
  ENGINE_WASM_KEY,
  ENGINE_WORKER_KEY,
  type EngineExtension,
  engineAssetNames,
  engineExtensionKey,
  engineExtensionName,
} from '../../../format/engine.js';
import type { ManifestV4 } from '../../../format/manifest.js';
import { OtelHtmlError } from '../../../model/errors.js';
import type { ScriptLoader } from '../script-loader.js';
import { fromBase64, gunzip, loadText, toBase64 } from './bytes.js';
import type { FileGate } from './file-gate.js';
import { createFileGate } from './file-gate.js';

export interface EngineDeps {
  loader: ScriptLoader;
  /** `document.baseURI`: engine and partition URLs resolve against it. */
  baseUrl: string;
  createWorker: (url: string) => Worker;
  /** `URL.createObjectURL` / `revokeObjectURL`, injected for tests. */
  blobUrl: { create(blob: Blob): string; revoke(url: string): void };
}

export interface Engine {
  readonly db: AsyncDuckDB;
  readonly connection: AsyncDuckDBConnection;
  readonly format: 'local' | 'site';
  /** Orders file swaps against statements (see `FileGate`). */
  readonly gate?: FileGate;
  registerText(name: string, text: string): Promise<void>;
  close(): Promise<void>;
}

/** `assetsBase + name` resolved against `baseUrl`, for the two engine files of the manifest's format. */
export function engineUrls(engine: ManifestV4['engine'], baseUrl: string): { wasm: string; worker: string } {
  const [wasm, worker] = engineAssetNames(engine.format)
    .slice(0, 2)
    .map((name) => new URL(engine.assetsBase + name, baseUrl).href);
  return { wasm: wasm as string, worker: worker as string };
}

/** Each extension's asset URL: the report's own file, resolved like the engine files. */
export function extensionUrls(
  engine: ManifestV4['engine'],
  baseUrl: string,
): Record<EngineExtension, string> {
  const url = (e: EngineExtension): string =>
    new URL(engine.assetsBase + engineExtensionName(engine.format, e), baseUrl).href;
  return { parquet: url('parquet'), json: url('json') };
}

/**
 * The address a `local` report's extensions are loaded from. Nothing answers there: the worker's shim (below)
 * rewrites a request for it to the embedded bytes. A shim that fails shows as a failed load; the name never
 * resolves. DuckDB reads the extension's name from the last path segment.
 */
const EMBEDDED_HOST = 'https://oh-engine.invalid/';
/** Where DuckDB looks for an extension it does not have (ICU, say) once the two are loaded: nowhere that answers. */
const NO_REPOSITORY = 'no-extensions';

/**
 * Classic-script source run first in a `local` worker. DuckDB-WASM fetches an extension with a synchronous
 * XMLHttpRequest from inside the worker; `file://` pages cannot fetch, and registered buffers are not consulted for
 * extensions, so the request for `EMBEDDED_HOST + <file>` is pointed at a data: URL holding the extension. A
 * request for any other file there (ICU, say) is pointed at an empty `data:,`: no request leaves the worker, and
 * DuckDB reports a clean load error. Throwing from `open` instead would trap inside the WASM call.
 */
export function extensionShim(dataUrls: Record<string, string>): string {
  return `(function(){var m=${JSON.stringify(dataUrls)};var h=${JSON.stringify(EMBEDDED_HOST)};var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(){var a=Array.prototype.slice.call(arguments);var k=String(a[1]);if(k.indexOf(h)===0){var f=k.slice(h.length);a[1]=Object.prototype.hasOwnProperty.call(m,f)?m[f]:'data:,';}return o.apply(this,a);};})();\n`;
}

async function embeddedExtensions(
  engine: ManifestV4['engine'],
  baseUrl: string,
  deps: EngineDeps,
): Promise<Record<string, string>> {
  const urls = extensionUrls(engine, baseUrl);
  const out: Record<string, string> = {};
  for (const e of ENGINE_EXTENSIONS) {
    const bytes = await gunzip(fromBase64(await loadText(deps.loader, urls[e], engineExtensionKey(e))));
    out[`${e}.duckdb_extension.wasm`] = `data:application/wasm;base64,${toBase64(bytes)}`;
  }
  return out;
}

async function startLocal(
  urls: { wasm: string; worker: string },
  loadExtensionData: () => Promise<Record<string, string>>,
  deps: EngineDeps,
) {
  let wasmBytes: Uint8Array | null = await gunzip(
    fromBase64(await loadText(deps.loader, urls.wasm, ENGINE_WASM_KEY)),
  );
  let wasmUrl: string | null = `data:application/wasm;base64,${toBase64(wasmBytes)}`;
  wasmBytes = null;
  const workerBytes = fromBase64(await loadText(deps.loader, urls.worker, ENGINE_WORKER_KEY));
  let blob: Blob | null = new Blob([extensionShim(await loadExtensionData()), workerBytes as BlobPart], {
    type: 'text/javascript',
  });
  const blobUrl = deps.blobUrl.create(blob);
  blob = null;
  let db: AsyncDuckDB | undefined;
  try {
    db = new AsyncDuckDB(new VoidLogger(), deps.createWorker(blobUrl));
    await db.instantiate(wasmUrl);
    return db;
  } catch (error) {
    await db?.terminate().catch(() => undefined);
    throw error;
  } finally {
    wasmUrl = null;
    deps.blobUrl.revoke(blobUrl);
  }
}

async function startSite(urls: { wasm: string; worker: string }, deps: EngineDeps) {
  let db: AsyncDuckDB | undefined;
  try {
    db = new AsyncDuckDB(new VoidLogger(), deps.createWorker(urls.worker));
    await db.instantiate(urls.wasm);
    await db.open({ filesystem: { forceFullHTTPReads: false, allowFullHTTPReads: true } });
    return db;
  } catch (error) {
    await db?.terminate().catch(() => undefined);
    throw error;
  }
}

/**
 * Network autoload is off, and both extensions are loaded from the report's own files before any view exists:
 * `local` through the worker's shim, `site` by URL. A failure names the extension file (D13). The official signed
 * binaries pass DuckDB's signature check, which stays on.
 */
async function loadExtensions(
  connection: AsyncDuckDBConnection,
  engine: ManifestV4['engine'],
  baseUrl: string,
): Promise<void> {
  await connection.query('SET autoinstall_known_extensions = false');
  await connection.query('SET autoload_known_extensions = false');
  const urls = extensionUrls(engine, baseUrl);
  for (const e of ENGINE_EXTENSIONS) {
    const file = engineExtensionName(engine.format, e);
    const target = engine.format === 'local' ? `${EMBEDDED_HOST}${e}.duckdb_extension.wasm` : urls[e];
    try {
      await connection.query(`LOAD '${target.replaceAll("'", "''")}'`);
    } catch (error) {
      throw new OtelHtmlError('invalid-report', {
        path: urls[e],
        expected: `the DuckDB ${e} extension (${file}) next to the engine`,
        actual: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // The two SETs above do not stop DuckDB-WASM from installing a further extension (ICU, for timezone functions)
  // from extensions.duckdb.org, so the repositories point where nothing can answer: `local` at the embedded host,
  // whose shim answers every extension but the two with nothing; `site` at a path under the report's own assets (a 404).
  const repository =
    engine.format === 'local'
      ? `${EMBEDDED_HOST}${NO_REPOSITORY}`
      : new URL(`${engine.assetsBase}${NO_REPOSITORY}`, baseUrl).href;
  for (const setting of ['autoinstall_extension_repository', 'custom_extension_repository']) {
    await connection.query(`SET ${setting} = '${repository.replaceAll("'", "''")}'`);
  }
}

export async function startEngine(engine: ManifestV4['engine'], deps: EngineDeps): Promise<Engine> {
  const urls = engineUrls(engine, deps.baseUrl);
  const db = await (engine.format === 'site'
    ? startSite(urls, deps)
    : startLocal(urls, () => embeddedExtensions(engine, deps.baseUrl, deps), deps));
  let connection: AsyncDuckDBConnection;
  try {
    connection = await db.connect();
    await loadExtensions(connection, engine, deps.baseUrl);
  } catch (error) {
    await db.terminate().catch(() => undefined);
    throw error;
  }
  return {
    db,
    connection,
    format: engine.format,
    gate: createFileGate(),
    registerText: (name, text) => db.registerFileText(name, text),
    async close() {
      // the worker is released even when the connection will not close; that error still surfaces
      try {
        await connection.close();
      } finally {
        await db.terminate();
      }
    },
  };
}
