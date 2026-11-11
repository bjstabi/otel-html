import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { Connector } from '@uwdata/mosaic-core';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { NODE_FS_PROTOCOL, type NodeDuckDb, openNodeDuckDb } from '../../src/host/node-duckdb.js';
import { viewStatements } from '../../src/query/sql/views.js';
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

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** A worker with its counting port, its files registered and the views created, as the viewer's page has them at start. */
interface Live {
  db: NodeDuckDb;
  conn: Connection;
  port: MessagePort;
  /** The events this worker posted since the last take. A spare's start-up reads land here and are dropped at the swap. */
  events: ReadEvent[];
  waiting: Map<number, () => void>;
}

let running = 0;

/** Counting workers started and not yet terminated in this process, spares included (for tests). */
export const runningWorkers = (): number => running;

/**
 * The viewer's engine over a report folder on disk, in the Node DuckDB-WASM build, with every file read counted. The
 * files are registered under their manifest paths and the views are created as the viewer does; what that reads is
 * not counted. It does not use `startHostEngine`: that policy locks the configuration and its REST engine has no
 * temp tables.
 *
 * `cold()` replaces the worker. DuckDB keeps file footers and file contents in caches that no SQL setting empties
 * (`enable_external_file_cache` and the object-cache pragmas were tried), and a new worker with the views created is
 * the state a page reload gives: the counted statement starts from there in both engines. Starting one takes about
 * half a second, so the next worker is started in the background right after each swap (the spare) and `cold()` only
 * waits for it when it is not ready yet; each worker has its own event list, so what the spare reads while it starts
 * is never counted. A spare takes cores that a small machine does not have (on four, the measurement runs as long
 * without it and uses a tenth more CPU), so `spare: false` starts the worker inside `cold()`.
 */
export async function openCountingEngine(
  dir: string,
  manifest: ManifestV4,
  { spare: useSpare = true }: { spare?: boolean } = {},
): Promise<CountingEngine> {
  const root = resolve(dir);
  const paths = manifest.partitions.flatMap((p) => Object.values(p.files).map((f) => f.path));

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
      db = await openNodeDuckDb(packageHostEngineFiles(), {
        preamble: COUNTING_PREAMBLE,
        workerData: { countPort: port2, countRoot: root },
        transferList: [port2],
      });
    } catch (e) {
      running--;
      port1.close();
      throw e;
    }
    try {
      for (const path of paths) await db.registerFileURL(path, join(root, path), NODE_FS_PROTOCOL, false);
      const conn = await db.connect();
      for (const sql of viewStatements(manifest, (p) => p)) await conn.query(sql);
      return { db, conn, port: port1, events, waiting };
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
  /** A start in the background: a failure surfaces where the spare is awaited, not as an unhandled rejection. */
  const startSpare = (): Promise<Live> => {
    const made = start();
    made.catch(() => undefined);
    return made;
  };

  const textDir = await mkdtemp(join(tmpdir(), 'otel-counting-'));
  let live = await start();
  let spare: Promise<Live> | undefined = useSpare ? startSpare() : undefined;
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
  const engine = mosaicQueryEngine(createCoordinator(connector, quiet), {
    // The residual path's id tables read a CSV registered as text; the Node host registers files by URL only, so the
    // text goes to a file outside the counted root (not counted) and is registered under its name.
    registerText: async (name, text) => {
      const file = join(textDir, name);
      await writeFile(file, text);
      await live.db.registerFileURL(name, file, NODE_FS_PROTOCOL, false);
    },
    close: async () => {},
  });
  let marker = 0;
  const take = async (): Promise<ReadEvent[]> => {
    const from = live;
    const id = marker++;
    await bounded(
      new Promise<void>((done) => {
        from.waiting.set(id, done);
        from.port.postMessage({ marker: id });
      }),
      'the counting worker answering a marker',
    );
    from.waiting.delete(id);
    return from.events.splice(0);
  };
  await take();
  return {
    engine,
    take,
    cold: async () => {
      engine.clearCache();
      const old = live;
      await take();
      live = await bounded(spare ?? start(), 'starting the next counting worker');
      spare = useSpare ? startSpare() : undefined;
      await stop(old);
      await take();
    },
    close: async () => {
      engine.clearCache();
      const last = await spare?.catch(() => undefined);
      await stop(live);
      if (last !== undefined) await stop(last);
      await rm(textDir, { recursive: true, force: true });
    },
  };
}
