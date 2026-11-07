import { AsyncDuckDB, type AsyncDuckDBConnection, VoidLogger } from '@duckdb/duckdb-wasm';
import { ENGINE_WASM_KEY, ENGINE_WORKER_KEY, engineAssetNames } from '../../../format/engine.js';
import type { ManifestV4 } from '../../../format/manifest.js';
import type { ScriptLoader } from '../script-loader.js';
import { fromBase64, gunzip, toBase64 } from './bytes.js';

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
  let wasmB64: unknown = await deps.loader.load(urls.wasm, ENGINE_WASM_KEY);
  let wasmBytes: Uint8Array | null = await gunzip(fromBase64(String(wasmB64)));
  wasmB64 = null;
  let wasmUrl: string | null = `data:application/wasm;base64,${toBase64(wasmBytes)}`;
  wasmBytes = null;
  const workerB64 = await deps.loader.load(urls.worker, ENGINE_WORKER_KEY);
  const workerText = new TextDecoder().decode(fromBase64(String(workerB64)));
  const blobUrl = deps.blobUrl.create(new Blob([workerText], { type: 'text/javascript' }));
  const db = new AsyncDuckDB(new VoidLogger(), deps.createWorker(blobUrl));
  try {
    await db.instantiate(wasmUrl);
  } finally {
    wasmUrl = null;
    deps.blobUrl.revoke(blobUrl);
  }
  return db;
}

async function startSite(urls: { wasm: string; worker: string }, deps: EngineDeps) {
  const db = new AsyncDuckDB(new VoidLogger(), deps.createWorker(urls.worker));
  await db.instantiate(urls.wasm);
  await db.open({ filesystem: { forceFullHTTPReads: false, allowFullHTTPReads: true } });
  return db;
}

export async function startEngine(engine: ManifestV4['engine'], deps: EngineDeps): Promise<Engine> {
  const urls = engineUrls(engine, deps.baseUrl);
  const db = await (engine.format === 'site' ? startSite(urls, deps) : startLocal(urls, deps));
  const connection = await db.connect();
  return {
    db,
    connection,
    format: engine.format,
    registerText: (name, text) => db.registerFileText(name, text),
    async close() {
      await connection.close();
      await db.terminate();
    },
  };
}
