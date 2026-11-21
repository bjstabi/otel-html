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
  /** `site` reports fetch the engine files with it; default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** The promise the report's index.html started for the engine file at this page-relative href, if any. */
  prefetched?: (href: string) => Promise<Response> | undefined;
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
/** What the worker's shim serves the wasm at: the page posts the bytes, DuckDB's `fetch` of this URL gets them. */
export const WASM_HANDOFF_URL = `${EMBEDDED_HOST}duckdb.wasm`;
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

/**
 * Classic-script source run first in every engine worker: it takes the wasm the page posts (`{ __oh: { wasm } }`, an
 * ArrayBuffer or a ReadableStream, before DuckDB's own message handler sees the message) and answers the first
 * `fetch` of `WASM_HANDOFF_URL` with it (and lets go of it), then the extension shim. Any other `fetch`, a later
 * one of the hand-off URL included, goes through.
 */
export function workerShim(extensionDataUrls: Record<string, string>): string {
  return `(function(){var u=${JSON.stringify(WASM_HANDOFF_URL)};var b=null;self.addEventListener('message',function(e){var d=e.data;if(d&&d.__oh&&d.__oh.wasm){b=d.__oh.wasm;e.stopImmediatePropagation();}},true);var f=self.fetch;self.fetch=function(i,o){var k=typeof i==='string'?i:i&&i.url;if(k===u&&b!==null){var x=b;b=null;var h={'content-type':'application/wasm'};if(typeof x.byteLength==='number')h['content-length']=String(x.byteLength);return Promise.resolve(new Response(x,{status:200,headers:h}));}return f.call(self,i,o);};})();\n${extensionShim(extensionDataUrls)}`;
}

interface EngineBytes {
  /** `local`: the gunzipped bytes; `site`: the response's body stream, unread (compiled by the worker as it arrives). */
  wasm: Uint8Array | ReadableStream<Uint8Array>;
  worker: Uint8Array;
  /** `data:` URLs keyed `<ext>.duckdb_extension.wasm`, for the worker's shim. */
  extensions: Record<string, string>;
}

const extensionDataUrl = (bytes: Uint8Array): string => `data:application/wasm;base64,${toBase64(bytes)}`;
const extensionKey = (e: EngineExtension): string => `${e}.duckdb_extension.wasm`;

/** `local`: the four wrappers load concurrently; the wasm stays bytes (a `data:` URL of it would cost ~0.5 s). */
async function localBytes(engine: ManifestV4['engine'], deps: EngineDeps): Promise<EngineBytes> {
  const urls = engineUrls(engine, deps.baseUrl);
  const ext = extensionUrls(engine, deps.baseUrl);
  const bytes = (url: string, key: string): Promise<Uint8Array> =>
    loadText(deps.loader, url, key).then(fromBase64);
  const [wasm, worker, ...extensions] = await Promise.all([
    bytes(urls.wasm, ENGINE_WASM_KEY).then(gunzip),
    bytes(urls.worker, ENGINE_WORKER_KEY),
    ...ENGINE_EXTENSIONS.map((e) => bytes(ext[e], engineExtensionKey(e)).then(gunzip)),
  ]);
  return {
    wasm: wasm as Uint8Array,
    worker: worker as Uint8Array,
    extensions: Object.fromEntries(
      ENGINE_EXTENSIONS.map((e, i) => [extensionKey(e), extensionDataUrl(extensions[i] as Uint8Array)]),
    ),
  };
}

/**
 * One `site` engine file's response: the page's early fetch if it has one (and it worked), else one fetch of the
 * file's URL. A failure of that fetch names the file (D13).
 */
async function siteResponse(name: string, engine: ManifestV4['engine'], deps: EngineDeps): Promise<Response> {
  const href = engine.assetsBase + name;
  const early = deps.prefetched?.(href);
  if (early !== undefined) {
    try {
      const response = await early;
      if (response.ok) return response;
    } catch {
      // the early fetch failed: one more try below, which names the file when it fails too
    }
  }
  const url = new URL(href, deps.baseUrl).href;
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url);
  } catch (error) {
    throw siteFailure(name, url, error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw siteFailure(name, url, `HTTP ${response.status}`);
  return response;
}

const siteFailure = (name: string, url: string, actual: string): OtelHtmlError =>
  new OtelHtmlError('invalid-report', { path: url, expected: `the DuckDB engine file (${name})`, actual });

const siteUrl = (name: string, engine: ManifestV4['engine'], deps: EngineDeps): string =>
  new URL(engine.assetsBase + name, deps.baseUrl).href;

/** One `site` engine file read whole. */
async function siteFile(name: string, engine: ManifestV4['engine'], deps: EngineDeps): Promise<Uint8Array> {
  const response = await siteResponse(name, engine, deps);
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw siteFailure(
      name,
      siteUrl(name, engine, deps),
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** The wasm of a `site` report: its body stream, not read here (no copy on the main thread). */
async function siteWasm(
  name: string,
  engine: ManifestV4['engine'],
  deps: EngineDeps,
): Promise<Uint8Array | ReadableStream<Uint8Array>> {
  const response = await siteResponse(name, engine, deps);
  if (response.body !== null) return response.body;
  return new Uint8Array(await response.arrayBuffer());
}

/** `site`: the worker script, the wasm and both extensions are fetched concurrently. */
async function siteBytes(engine: ManifestV4['engine'], deps: EngineDeps): Promise<EngineBytes> {
  const [wasmName, workerName] = engineAssetNames('site');
  const [wasm, worker, ...extensions] = await Promise.all([
    siteWasm(wasmName as string, engine, deps),
    siteFile(workerName as string, engine, deps),
    ...ENGINE_EXTENSIONS.map((e) => siteFile(engineExtensionName(engine.format, e), engine, deps)),
  ]);
  return {
    wasm,
    worker,
    extensions: Object.fromEntries(
      ENGINE_EXTENSIONS.map((e, i) => [extensionKey(e), extensionDataUrl(extensions[i] as Uint8Array)]),
    ),
  };
}

/** A buffer that holds exactly `bytes` (a view into a larger buffer is sliced), for the transfer list. */
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (byteOffset === 0 && byteLength === buffer.byteLength && buffer instanceof ArrayBuffer) return buffer;
  return bytes.slice().buffer;
}

/** Posts the wasm to the worker, transferred; a browser that cannot transfer a stream gets the bytes read from it. */
async function handOffWasm(worker: Worker, source: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
  if (source instanceof Uint8Array) {
    const wasm = exactBuffer(source);
    worker.postMessage({ __oh: { wasm } }, [wasm]);
    return;
  }
  try {
    worker.postMessage({ __oh: { wasm: source } }, [source]);
  } catch {
    const wasm = await new Response(source).arrayBuffer();
    worker.postMessage({ __oh: { wasm } }, [wasm]);
  }
}

async function startDatabase(format: 'local' | 'site', bytes: EngineBytes, deps: EngineDeps) {
  let blob: Blob | null = new Blob([workerShim(bytes.extensions), bytes.worker as BlobPart], {
    type: 'text/javascript',
  });
  const blobUrl = deps.blobUrl.create(blob);
  blob = null;
  let db: AsyncDuckDB | undefined;
  try {
    const worker = deps.createWorker(blobUrl);
    await handOffWasm(worker, bytes.wasm);
    db = new AsyncDuckDB(new VoidLogger(), worker);
    await db.instantiate(WASM_HANDOFF_URL);
    if (format === 'site')
      await db.open({ filesystem: { forceFullHTTPReads: false, allowFullHTTPReads: true } });
    return db;
  } catch (error) {
    await db?.terminate().catch(() => undefined);
    throw error;
  } finally {
    deps.blobUrl.revoke(blobUrl);
  }
}

/**
 * Network autoload is off, and both extensions are loaded from the report's own files before any view exists:
 * both through the worker's shim. A failure names the extension file (D13). The official signed
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
    try {
      await connection.query(`LOAD '${EMBEDDED_HOST}${extensionKey(e)}'`);
    } catch (error) {
      throw new OtelHtmlError('invalid-report', {
        path: urls[e],
        expected: `the DuckDB ${e} extension (${file}) next to the engine`,
        actual: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // The two SETs above do not stop DuckDB-WASM from installing a further extension (ICU, for timezone functions)
  // from extensions.duckdb.org, so the repositories point at the embedded host, whose shim answers every extension
  // but the two with nothing.
  const repository = `${EMBEDDED_HOST}${NO_REPOSITORY}`;
  for (const setting of ['autoinstall_extension_repository', 'custom_extension_repository']) {
    await connection.query(`SET ${setting} = '${repository.replaceAll("'", "''")}'`);
  }
}

export async function startEngine(engine: ManifestV4['engine'], deps: EngineDeps): Promise<Engine> {
  const bytes = await (engine.format === 'site' ? siteBytes(engine, deps) : localBytes(engine, deps));
  const db = await startDatabase(engine.format, bytes, deps);
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
