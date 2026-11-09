import { join, resolve } from 'node:path';
import type { ManifestV4 } from '../format/manifest.js';
import { OtelHtmlError } from '../model/errors.js';
import { viewStatements } from '../query/sql/views.js';
import type { FileSystem, Logger } from '../writer/ports.js';
import type { HostEngineFiles } from './engine-files.js';
import { NODE_FS_PROTOCOL, type NodeDuckDb, openNodeDuckDb } from './node-duckdb.js';

export interface HostEngineOptions {
  report: string;
  manifest: ManifestV4;
  files: HostEngineFiles;
  fs: Pick<FileSystem, 'exists'>;
  logger: Logger;
  timeoutMs: number;
  maxResultBytes: number;
  open?: typeof openNodeDuckDb;
}

export interface HostEngine {
  /** One client statement as Arrow IPC stream bytes. Rejects with the engine's own error until Task 1.3 wraps it in a HostError. */
  query(sql: string): Promise<Uint8Array>;
  readonly restarts: number;
  close(): Promise<void>;
}

function listedPaths(manifest: ManifestV4): string[] {
  return manifest.partitions.flatMap((p) => Object.values(p.files).map((f) => f.path));
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The plain loop of D38: start, poll while `null`, then fetch until an empty message; the messages are the IPC stream. */
async function runPending(db: NodeDuckDb, conn: number, sql: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let header = await db.startPendingQuery(conn, sql, false);
  while (header === null) header = await db.pollPendingQuery(conn);
  chunks.push(header);
  // The end of the result is an empty message (duckdb-wasm's own iterator stops on it); `null` is tolerated too.
  for (
    let chunk = await db.fetchQueryResults(conn);
    chunk !== null && chunk.length > 0;
    chunk = await db.fetchQueryResults(conn)
  ) {
    chunks.push(chunk);
  }
  return concat(chunks);
}

/**
 * Opens the engine over the report: every listed file must exist (`invalid-report` naming the first missing path),
 * each is registered under its manifest path and the five views are created. Statements run one at a time.
 */
export async function startHostEngine(opts: HostEngineOptions): Promise<HostEngine> {
  const report = resolve(opts.report);
  for (const path of listedPaths(opts.manifest)) {
    if (!(await opts.fs.exists(join(report, path)))) {
      throw new OtelHtmlError('invalid-report', {
        path,
        expected: 'a file listed by the manifest',
        actual: 'missing',
      });
    }
  }
  const db = await (opts.open ?? openNodeDuckDb)(opts.files);
  let conn: Awaited<ReturnType<NodeDuckDb['connect']>>;
  try {
    for (const path of listedPaths(opts.manifest)) {
      await db.registerFileURL(path, join(report, path), NODE_FS_PROTOCOL, false);
    }
    conn = await db.connect();
    for (const sql of viewStatements(opts.manifest, (p) => p)) await conn.query(sql);
  } catch (e) {
    await db.terminate();
    throw e;
  }
  const connection = conn;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    restarts: 0,
    query(sql) {
      const run = tail.then(() => runPending(db, connection.id, sql));
      tail = run.catch(() => undefined);
      return run;
    },
    async close() {
      await tail;
      await db.terminate();
    },
  };
}
