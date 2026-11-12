import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { Connector } from '@uwdata/mosaic-core';
import type { ManifestV4 } from '../../src/format/manifest.js';
import type { HostEngineFiles } from '../../src/host/engine-files.js';
import { NODE_FS_PROTOCOL, type NodeDuckDb, openNodeDuckDb } from '../../src/host/node-duckdb.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { viewStatements } from '../../src/query/sql/views.js';
import { smallFiles } from '../../src/viewer/data/engine/small-files.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import { packageHostEngineFiles } from '../host-engine-files.js';
import { bounded } from './bounded.js';

export interface ReadEvent {
  /** The manifest path (`partitions/000001/spans.parquet`), not the absolute one. */
  path: string;
  kind: 'open' | 'read';
  offset: number;
  bytes: number;
}

export interface CountingEngine {
  engine: QueryEngine;
  /** The events since the last take, complete: it round-trips a marker through the worker first. */
  take(): Promise<ReadEvent[]>;
  /** Paths prepared (fetched whole) since the last call, with their sizes; empties the record. */
  prepared(): ReadonlyMap<string, number>;
  /** After it, the next statement reads every footer again (no cached metadata, no cached result). */
  cold(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The manifest path of `p` (forward slashes on every OS) when it lies under `root`, else null. Plain JavaScript source,
 * because the worker's preamble embeds it as text and a test evaluates the same text with the Windows path functions.
 */
export const RELATIVE_SOURCE = `(function (resolve, sep, root, p) {
  if (typeof p !== 'string') return null;
  const prefix = root.endsWith(sep) ? root : root + sep;
  const full = resolve(p);
  return full.startsWith(prefix) ? full.slice(prefix.length).split(sep).join('/') : null;
})`;

/**
 * JavaScript run in the worker before the shim: `fs.openSync`, `fs.readSync` and `fs.closeSync` post an event on the
 * port in `workerData.countPort` for every file under `workerData.countRoot`, as its manifest path. A marker sent on
 * the port is answered on it, after every event posted before it.
 */
const COUNTING_PREAMBLE = `{
  const fs = require('node:fs');
  const { sep, resolve } = require('node:path');
  const { workerData } = require('node:worker_threads');
  const port = workerData.countPort;
  const rel = ${RELATIVE_SOURCE};
  const open = new Map();
  port.on('message', (m) => port.postMessage({ marker: m.marker }));
  const relative = (p) => rel(resolve, sep, workerData.countRoot, p);
  const openSync = fs.openSync;
  const readSync = fs.readSync;
  const closeSync = fs.closeSync;
  fs.openSync = function (p, ...rest) {
    const fd = openSync.call(this, p, ...rest);
    const path = relative(p);
    if (path !== null) {
      open.set(fd, path);
      port.postMessage({ event: { path, kind: 'open', offset: 0, bytes: 0 } });
    }
    return fd;
  };
  fs.readSync = function (fd, buffer, ...rest) {
    const n = readSync.call(this, fd, buffer, ...rest);
    const path = open.get(fd);
    if (path !== undefined) {
      const at = typeof rest[0] === 'object' && rest[0] !== null ? rest[0].position : rest[2];
      port.postMessage({ event: { path, kind: 'read', offset: Number(at ?? 0), bytes: n } });
    }
    return n;
  };
  fs.closeSync = function (fd) {
    open.delete(fd);
    return closeSync.call(this, fd);
  };
  // Compiled once per test process and handed to every worker: the engine's wasm and the two extensions' (matched by
  // length and their first bytes). What the worker does not find here, it compiles as before.
  const compiled = workerData.compiled;
  if (compiled !== undefined) {
    const find = (src) => {
      if (!(src instanceof Uint8Array) && !(src instanceof ArrayBuffer)) return undefined;
      const bytes = src instanceof ArrayBuffer ? new Uint8Array(src) : src;
      return compiled.extensions.find(
        (e) => e.length === bytes.length && e.head.every((b, i) => bytes[i] === b),
      )?.module;
    };
    const readFile = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) {
      return p === compiled.wasmPath ? new Uint8Array(0) : readFile.call(this, p, ...rest);
    };
    const instantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = function (src, imports) {
      const module = src instanceof Uint8Array && src.length === 0 ? compiled.wasm : find(src);
      if (module === undefined) return instantiate.call(this, src, imports);
      return instantiate.call(this, module, imports).then((instance) => ({ instance, module }));
    };
    WebAssembly.Module = new Proxy(WebAssembly.Module, {
      construct: (target, args, newTarget) => find(args[0]) ?? Reflect.construct(target, args, newTarget),
    });
  }
}`;

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

type Connection = Awaited<ReturnType<NodeDuckDb['connect']>>;

/** One statement as Arrow IPC stream bytes: start, poll while pending, fetch until the empty message. */
async function runIpc(db: NodeDuckDb, conn: Connection, sql: string): Promise<Uint8Array> {
  let header = await db.startPendingQuery(conn.id, sql, false);
  while (header === null) header = await db.pollPendingQuery(conn.id);
  const chunks = [header];
  for (;;) {
    const chunk = await db.fetchQueryResults(conn.id);
    if (chunk === null || chunk.length === 0) break;
    chunks.push(chunk);
  }
  return concat(chunks);
}

interface Precompiled {
  wasmPath: string;
  wasm: WebAssembly.Module;
  extensions: { length: number; head: Uint8Array; module: WebAssembly.Module }[];
}

const precompiled = new Map<string, Promise<Precompiled>>();

/** The engine's wasm and the two extensions compiled once in this process (a compiled module crosses to a worker thread). */
function compileOnce(files: HostEngineFiles): Promise<Precompiled> {
  const hit = precompiled.get(files.wasm);
  if (hit !== undefined) return hit;
  const made = (async (): Promise<Precompiled> => {
    const extensions: Precompiled['extensions'] = [];
    for (const path of Object.values(files.extensions)) {
      const bytes = await readFile(path);
      extensions.push({
        length: bytes.length,
        head: bytes.subarray(0, 64),
        module: await WebAssembly.compile(bytes),
      });
    }
    return { wasmPath: files.wasm, wasm: await WebAssembly.compile(await readFile(files.wasm)), extensions };
  })();
  precompiled.set(files.wasm, made);
  return made;
}

/**
 * Above the generator's largest traces, patterns and rollup file (8 row groups), below its smallest spans and logs
 * file (2 row groups): the files that load whole in the harness are the ones the live report loads whole.
 */
export const HARNESS_SMALL_FILE_BYTES = 350_000;

export interface CountingOptions {
  /** Files of this size or smaller are prepared whole; 0 prepares none (every file by range). */
  threshold?: number;
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** A worker with its counting port, its files registered and the views created, as the viewer's page has them at start. */
interface Live {
  db: NodeDuckDb;
  conn: Connection;
  port: MessagePort;
  /** The events this worker posted since the last take. */
  events: ReadEvent[];
  waiting: Map<number, () => void>;
}

let running = 0;

/** Counting workers started and not yet terminated in this process (for tests). */
export const runningWorkers = (): number => running;

/**
 * The viewer's engine over a report folder on disk, in the Node DuckDB-WASM build, with every file read counted. The
 * files are registered under their manifest paths and the views are created as the viewer does; what that reads is
 * not counted. It does not use `startHostEngine`: that policy locks the configuration and its REST engine has no
 * temp tables.
 *
 * `cold()` gives the worker an empty database (`reset()`, the files registered again and the views created). DuckDB
 * keeps file footers and file contents in caches that no SQL setting empties (`enable_external_file_cache` and the
 * object-cache pragmas were tried), but a new database instance has none, which is the state a page reload gives: the
 * counted statement starts from there in both engines. The worker thread stays: ending one thread per cold step
 * (about 450 in a measurement) made Node 24.22's V8 abort now and then ("jit_page_->allocations_.erase"), and a reset
 * costs 50 ms instead of the 600 ms of a new worker. The worker ends in `close()`.
 */
export async function openCountingEngine(
  dir: string,
  manifest: ManifestV4,
  options: CountingOptions = {},
): Promise<CountingEngine> {
  const threshold = options.threshold ?? HARNESS_SMALL_FILE_BYTES;
  const root = resolve(dir);
  const paths = manifest.partitions.flatMap((p) => Object.values(p.files).map((f) => f.path));
  const sizes = new Map(
    manifest.partitions.flatMap((p) => Object.values(p.files).map((f) => [f.path, f.bytes])),
  );

  const prepare = async (db: NodeDuckDb): Promise<Connection> => {
    for (const path of paths) await db.registerFileURL(path, join(root, path), NODE_FS_PROTOCOL, false);
    const conn = await db.connect();
    for (const sql of viewStatements(manifest, (p) => p)) await conn.query(sql);
    return conn;
  };
  async function start(): Promise<Live> {
    const { port1, port2 } = new MessageChannel();
    const events: ReadEvent[] = [];
    const waiting = new Map<number, () => void>();
    port1.on('message', (m: { event?: ReadEvent; marker?: number }) => {
      if (m.event !== undefined) events.push(m.event);
      else if (m.marker !== undefined) waiting.get(m.marker)?.();
    });
    // The worker's port must not keep the test process alive.
    port1.unref();
    running++;
    let db: NodeDuckDb;
    try {
      const files = packageHostEngineFiles();
      db = await openNodeDuckDb(files, {
        preamble: COUNTING_PREAMBLE,
        workerData: { countPort: port2, countRoot: root, compiled: await compileOnce(files) },
        transferList: [port2],
      });
    } catch (e) {
      running--;
      port1.close();
      throw e;
    }
    try {
      return { db, conn: await prepare(db), port: port1, events, waiting };
    } catch (e) {
      running--;
      await db.terminate().catch(() => undefined);
      port1.close();
      throw e;
    }
  }
  const stop = async (live: Live): Promise<void> => {
    await live.conn.close().catch(() => undefined);
    await live.db.terminate();
    live.port.close();
    running--;
  };

  const textDir = await mkdtemp(join(tmpdir(), 'otel-counting-'));
  const live = await start();
  // A prepared file is read whole once (not counted by the worker: the main thread reads it) and registered again,
  // under its name, from a copy outside the counted root, which stands for the page's buffer: the statement then
  // reads no counted byte of it. `prepared()` hands the paths and sizes to the cost.
  const prepared = new Map<string, number>();
  let loader = makeLoader();
  function makeLoader() {
    return smallFiles({
      threshold,
      bytesOf: (path) => sizes.get(path),
      fetchWhole: async (path) => new Uint8Array(await readFile(join(root, path))),
      swap: async (path, bytes) => {
        const copy = join(textDir, 'whole', path);
        await mkdir(join(copy, '..'), { recursive: true });
        await writeFile(copy, bytes);
        await live.db.registerFileURL(path, copy, NODE_FS_PROTOCOL, false);
        prepared.set(path, bytes.length);
      },
    });
  }
  // One connection runs one statement at a time: two pending queries on it interleave their result buffers (the
  // viewer's worker queues them the same way), so concurrent requests such as getTrace's two reads wait in turn.
  let turn: Promise<unknown> = Promise.resolve();
  const connector = {
    query(request: { type: string; sql: string }): Promise<Uint8Array | undefined> {
      const run = turn.then(async () => {
        const bytes = await bounded(
          runIpc(live.db, live.conn, request.sql),
          `a statement (${request.sql.slice(0, 60)})`,
        );
        return request.type === 'arrow' ? bytes : undefined;
      });
      turn = run.catch(() => undefined);
      return run;
    },
  } as Connector;
  const engine = mosaicQueryEngine(
    createCoordinator(connector, quiet),
    {
      // The residual path's id tables read a CSV registered as text; the Node host registers files by URL only, so the
      // text goes to a file outside the counted root (not counted) and is registered under its name.
      registerText: async (name, text) => {
        const file = join(textDir, name);
        await writeFile(file, text);
        await live.db.registerFileURL(name, file, NODE_FS_PROTOCOL, false);
      },
      close: async () => {},
    },
    true,
    undefined,
    (paths, signal) => loader.prepare(paths, signal),
  );
  let marker = 0;
  const take = async (): Promise<ReadEvent[]> => {
    const id = marker++;
    await bounded(
      new Promise<void>((done) => {
        live.waiting.set(id, done);
        live.port.postMessage({ marker: id });
      }),
      'the counting worker answering a marker',
    );
    live.waiting.delete(id);
    return live.events.splice(0);
  };
  await take();
  return {
    engine,
    take,
    prepared: () => {
      const taken = new Map(prepared);
      prepared.clear();
      return taken;
    },
    cold: async () => {
      engine.clearCache();
      prepared.clear();
      loader = makeLoader();
      await take();
      const { db } = live;
      if (db.reset === undefined) throw new OtelHtmlError('usage', { message: 'the engine cannot reset' });
      await live.conn.close().catch(() => undefined);
      await bounded(db.reset(), 'resetting the counting database');
      live.conn = await bounded(prepare(db), 'preparing the counting database');
      await take();
    },
    close: async () => {
      engine.clearCache();
      await stop(live);
      await rm(textDir, { recursive: true, force: true });
    },
  };
}
