import { AsyncDuckDB, type AsyncDuckDBConnection, VoidLogger } from '@duckdb/duckdb-wasm';
import { ENGINE_WASM_KEY, ENGINE_WORKER_KEY, engineAssetNames } from '../../../format/engine.js';
import type { ManifestV4 } from '../../../format/manifest.js';
import type { ScriptLoader } from '../script-loader.js';
import { fromBase64, gunzip, loadText, toBase64 } from './bytes.js';

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
  registerText(name: string, text: string): Promise<void>;
  close(): Promise<void>;
}

/** `assetsBase + name` resolved against `baseUrl`, for the two engine files of the manifest's format. */
export function engineUrls(engine: ManifestV4['engine'], baseUrl: string): { wasm: string; worker: string } {
  const [wasm, worker] = engineAssetNames(engine.format).map(
    (name) => new URL(engine.assetsBase + name, baseUrl).href,
  );
  return { wasm: wasm as string, worker: worker as string };
}

async function startLocal(urls: { wasm: string; worker: string }, deps: EngineDeps) {
  let wasmBytes: Uint8Array | null = await gunzip(
    fromBase64(await loadText(deps.loader, urls.wasm, ENGINE_WASM_KEY)),
  );
  let wasmUrl: string | null = `data:application/wasm;base64,${toBase64(wasmBytes)}`;
  wasmBytes = null;
  let blob: Blob | null = new Blob(
    [fromBase64(await loadText(deps.loader, urls.worker, ENGINE_WORKER_KEY)) as BlobPart],
    { type: 'text/javascript' },
  );
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

export async function startEngine(engine: ManifestV4['engine'], deps: EngineDeps): Promise<Engine> {
  const urls = engineUrls(engine, deps.baseUrl);
  const db = await (engine.format === 'site' ? startSite(urls, deps) : startLocal(urls, deps));
  let connection: AsyncDuckDBConnection;
  try {
    connection = await db.connect();
  } catch (error) {
    await db.terminate().catch(() => undefined);
    throw error;
  }
  return {
    db,
    connection,
    format: engine.format,
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
