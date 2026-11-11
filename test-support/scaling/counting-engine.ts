import { resolve } from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import type { Connector } from '@uwdata/mosaic-core';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { NODE_FS_PROTOCOL, type NodeDuckDb, openNodeDuckDb } from '../../src/host/node-duckdb.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { viewStatements } from '../../src/query/sql/views.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import { packageHostEngineFiles } from '../host-engine-files.js';

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
 * JavaScript run in the worker before the shim: `fs.openSync`, `fs.readSync` and `fs.closeSync` post an event on the
 * port in `workerData.countPort` for every file under `workerData.countRoot`, as its manifest path. A marker sent on
 * the port is answered on it, after every event posted before it.
 */
const COUNTING_PREAMBLE = `{
  const fs = require('node:fs');
  const { sep } = require('node:path');
  const { workerData } = require('node:worker_threads');
  const port = workerData.countPort;
  const root = workerData.countRoot + sep;
  const open = new Map();
  port.on('message', (m) => port.postMessage({ marker: m.marker }));
  const relative = (p) => (typeof p === 'string' && p.startsWith(root) ? p.slice(root.length).split(sep).join('/') : null);
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
}

/**
 * The viewer's engine over a report folder on disk, in the Node DuckDB-WASM build, with every file read counted. The
 * files are registered under their manifest paths and the views are created as the viewer does; what that reads is
 * not counted. It does not use `startHostEngine`: that policy locks the configuration and its REST engine has no
 * temp tables.
 *
 * `cold()` replaces the worker. DuckDB keeps file footers and file contents in caches that no SQL setting empties
 * (`enable_external_file_cache` and the object-cache pragmas were tried), and a new worker with the views created is
 * the state a page reload gives: the counted statement starts from there in both engines.
 */
export async function openCountingEngine(dir: string, manifest: ManifestV4): Promise<CountingEngine> {
  const root = resolve(dir);
  const paths = manifest.partitions.flatMap((p) => Object.values(p.files).map((f) => f.path));
  let events: ReadEvent[] = [];
  const waiting = new Map<number, () => void>();

  async function start(): Promise<Live> {
    const { port1, port2 } = new MessageChannel();
    port1.on('message', (m: { event?: ReadEvent; marker?: number }) => {
      if (m.event !== undefined) events.push(m.event);
      else if (m.marker !== undefined) waiting.get(m.marker)?.();
    });
    // The worker's port must not keep the test process alive.
    port1.unref();
    const db = await openNodeDuckDb(packageHostEngineFiles(), {
      preamble: COUNTING_PREAMBLE,
      workerData: { countPort: port2, countRoot: root },
      transferList: [port2],
    });
    try {
      for (const path of paths) await db.registerFileURL(path, `${root}/${path}`, NODE_FS_PROTOCOL, false);
      const conn = await db.connect();
      for (const sql of viewStatements(manifest, (p) => p)) await conn.query(sql);
      return { db, conn, port: port1 };
    } catch (e) {
      await db.terminate().catch(() => undefined);
      port1.close();
      throw e;
    }
  }
  const stop = async (live: Live): Promise<void> => {
    await live.conn.close().catch(() => undefined);
    await live.db.terminate();
    live.port.close();
  };

  let live = await start();
  const connector = {
    async query(request: { type: string; sql: string }): Promise<Uint8Array | undefined> {
      const bytes = await runIpc(live.db, live.conn, request.sql);
      return request.type === 'arrow' ? bytes : undefined;
    },
  } as Connector;
  const engine = mosaicQueryEngine(createCoordinator(connector, quiet), {
    registerText: () => {
      throw new OtelHtmlError('usage', { message: 'the counting engine does not register text files' });
    },
    close: async () => {},
  });
  let marker = 0;
  const take = async (): Promise<ReadEvent[]> => {
    const id = marker++;
    await new Promise<void>((done) => {
      waiting.set(id, done);
      live.port.postMessage({ marker: id });
    });
    waiting.delete(id);
    const out = events;
    events = [];
    return out;
  };
  await take();
  events = [];
  return {
    engine,
    take,
    cold: async () => {
      engine.clearCache();
      const old = live;
      live = await start();
      await stop(old);
      await take();
    },
    close: async () => {
      engine.clearCache();
      await stop(live);
    },
  };
}
