import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import type { HostEngineFiles } from './engine-files.js';

/** The slice of DuckDB-WASM's Node `AsyncDuckDB` the host uses, typed here so `src/` never imports the package (D35). */
export interface NodeDuckDb {
  startPendingQuery(conn: number, sql: string, allowStreamResult: boolean): Promise<Uint8Array | null>;
  pollPendingQuery(conn: number): Promise<Uint8Array | null>;
  cancelPendingQuery(conn: number): Promise<boolean>;
  fetchQueryResults(conn: number): Promise<Uint8Array | null>;
  registerFileURL(name: string, url: string, proto: number, directIO: boolean): Promise<void>;
  connect(): Promise<{
    readonly id: number;
    query(sql: string): Promise<unknown>;
    /** Parses and plans one statement without running it; the engine rejects more than one. */
    prepare(sql: string): Promise<{ close(): Promise<void> }>;
    close(): Promise<void>;
  }>;
  terminate(): Promise<void>;
  /** Resolves with the reason when the worker dies on its own (an `error` or an `exit`). */
  readonly exited?: Promise<string>;
}

/** `DuckDBDataProtocol.NODE_FS`: the file is read from disk by range. */
export const NODE_FS_PROTOCOL = 1;

/**
 * The Web-Worker shim run with `eval: true`: an `EventTarget` as `self`, `postMessage` to the parent port, and the
 * parent port's messages to `onmessage` and the target. duckdb-wasm's own Node path needs the `web-worker` package,
 * which is not a dependency.
 */
export const WORKER_SHIM = `
const { parentPort, workerData } = require('node:worker_threads');
const target = new EventTarget();
// DuckDB's worker logs every failure with console.log; worker_threads would forward that to the parent's stdout.
for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = () => {};
globalThis.self = globalThis;
globalThis.addEventListener = target.addEventListener.bind(target);
globalThis.removeEventListener = target.removeEventListener.bind(target);
globalThis.dispatchEvent = target.dispatchEvent.bind(target);
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
parentPort.on('message', (data) => {
  const event = new MessageEvent('message', { data });
  if (typeof globalThis.onmessage === 'function') globalThis.onmessage(event);
  target.dispatchEvent(event);
});
// DuckDB-WASM fetches an extension it LOADs with a synchronous XMLHttpRequest, which Node lacks. This one answers
// from workerData.extensions (file name to path) and nothing else: no request leaves the worker.
globalThis.XMLHttpRequest = class {
  open(method, url) { this.url = String(url); }
  setRequestHeader() {}
  send() {
    const path = workerData.extensions[this.url.split('/').pop()];
    if (path === undefined) { this.status = 404; this.response = new ArrayBuffer(0); return; }
    const bytes = require('node:fs').readFileSync(path);
    this.status = 200;
    this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  }
  getAllResponseHeaders() { return ''; }
  getResponseHeader() { return ''; }
};
require(workerData.mod);
`;

/** The extensions this build lacks and the viewer's SQL needs; `LOAD` names each by a URL the shim answers from a file. */
const EXTENSIONS = ['parquet', 'json'] as const;
const extensionFile = (e: string): string => `${e}.duckdb_extension.wasm`;
const extensionUrl = (e: string): string => `https://otel-html.invalid/${extensionFile(e)}`;

type Listener = (event: unknown) => void;

/** A `worker_threads` Worker with the `addEventListener` face `AsyncDuckDB` expects of a Web Worker. */
function webWorker(worker: Worker): unknown {
  const wrapped = new Map<Listener, Listener>();
  return {
    postMessage: (message: unknown, transfer?: readonly ArrayBuffer[]) =>
      worker.postMessage(message, transfer as ArrayBuffer[] | undefined),
    terminate: () => worker.terminate(),
    addEventListener(type: string, listener: Listener) {
      const wrap: Listener = type === 'message' ? (data) => listener({ data }) : listener;
      wrapped.set(listener, wrap);
      worker.on(type === 'close' ? 'exit' : type, wrap);
    },
    removeEventListener(type: string, listener: Listener) {
      const wrap = wrapped.get(listener);
      if (wrap === undefined) return;
      wrapped.delete(listener);
      worker.off(type === 'close' ? 'exit' : type, wrap);
    },
  };
}

interface RawConnection {
  query(sql: string): Promise<unknown>;
  prepare(sql: string): Promise<{ close(): Promise<void> }>;
  close(): Promise<void>;
  useUnsafe<R>(callback: (bindings: unknown, conn: number) => R): R;
}

interface Bindings {
  readonly AsyncDuckDB: new (
    logger: unknown,
    worker: unknown,
  ) => Omit<NodeDuckDb, 'connect'> & {
    instantiate(wasm: string): Promise<void>;
    open(config: Record<string, never>): Promise<void>;
    connect(): Promise<RawConnection>;
  };
  readonly VoidLogger: new () => unknown;
}

const require = createRequire(import.meta.url);

/** `require(files.bindings)`, a Worker from the shim, `new AsyncDuckDB(new VoidLogger(), shim)`, `instantiate(files.wasm)`, `open({})`, then `LOAD` of the two extensions. */
export async function openNodeDuckDb(files: HostEngineFiles): Promise<NodeDuckDb> {
  const bindings = require(files.bindings) as Bindings;
  const worker = new Worker(WORKER_SHIM, {
    eval: true,
    workerData: {
      mod: files.worker,
      extensions: Object.fromEntries(EXTENSIONS.map((e) => [extensionFile(e), files.extensions[e]])),
    },
  });
  const db = new bindings.AsyncDuckDB(new bindings.VoidLogger(), webWorker(worker));
  try {
    await db.instantiate(files.wasm);
    await db.open({});
    // Load them before the policy locks the configuration (and before the views, which read Parquet).
    const conn = await db.connect();
    for (const e of EXTENSIONS) await conn.query(`LOAD '${extensionUrl(e)}'`);
    await conn.close();
  } catch (e) {
    await worker.terminate();
    throw e;
  }
  const exited = new Promise<string>((resolve) => {
    worker.once('error', (e: Error) => resolve(`worker error: ${e.message}`));
    worker.once('exit', (code) => resolve(`worker exited with code ${code}`));
  });
  // `AsyncDuckDBConnection` keeps its connection number private; `useUnsafe` is the way to read it.
  const connect: NodeDuckDb['connect'] = async () => {
    const raw = await db.connect();
    const id = raw.useUnsafe((_, conn) => conn);
    return {
      id,
      query: (sql) => raw.query(sql),
      prepare: (sql) => raw.prepare(sql),
      close: () => raw.close(),
    };
  };
  return {
    startPendingQuery: (conn, sql, stream) => db.startPendingQuery(conn, sql, stream),
    pollPendingQuery: (conn) => db.pollPendingQuery(conn),
    cancelPendingQuery: (conn) => db.cancelPendingQuery(conn),
    fetchQueryResults: (conn) => db.fetchQueryResults(conn),
    registerFileURL: (name, url, proto, directIO) => db.registerFileURL(name, url, proto, directIO),
    connect,
    terminate: () => db.terminate(),
    exited,
  };
}
