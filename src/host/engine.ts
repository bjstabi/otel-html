import { join, resolve } from 'node:path';
import type { ManifestV4 } from '../format/manifest.js';
import { OtelHtmlError } from '../model/errors.js';
import { viewStatements } from '../query/sql/views.js';
import type { FileSystem, Logger } from '../writer/ports.js';
import type { HostEngineFiles } from './engine-files.js';
import { NODE_FS_PROTOCOL, type NodeDuckDb, openNodeDuckDb } from './node-duckdb.js';

/** A request outcome with an HTTP status: the client's statement was refused or failed (400), or the host could not serve it. */
export class HostError extends Error {
  readonly status: 400 | 413 | 503 | 504;
  constructor(status: 400 | 413 | 503 | 504, message: string) {
    super(message);
    this.name = 'HostError';
    this.status = status;
  }
}

/** D37, in this order: a `LOAD` of an extension the build lacks hangs the worker when it runs before these. */
export const POLICY_STATEMENTS: readonly string[] = [
  'SET autoinstall_known_extensions = false',
  'SET autoload_known_extensions = false',
  "SET allowed_directories = ['data/partitions/']",
  'SET enable_external_access = false',
  'SET lock_configuration = true',
];

/** Only a query can sit inside the parentheses: DDL, DML, `SET`, `PRAGMA`, `LOAD` and a second statement are parser errors. */
export function wrapStatement(sql: string): string {
  return `SELECT * FROM (\n${sql}\n) AS otel_host`;
}

/** The pending-query path reports errors as JSON (`exception_type`, `exception_message`); DuckDB's own text is `<Type> Error: <message>`. */
function engineMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'exception_message' in parsed) {
      const { exception_type: type, exception_message: message } = parsed as Record<string, unknown>;
      return typeof type === 'string' ? `${type} Error: ${String(message)}` : String(message);
    }
  } catch {
    // not JSON: the message is already DuckDB's text
  }
  return text;
}

/** Locks the engine down; runs after the views, on the connection that created them. */
async function applyPolicy(conn: { query(sql: string): Promise<unknown> }): Promise<void> {
  for (const sql of POLICY_STATEMENTS) await conn.query(sql);
}

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
  /** One client statement as Arrow IPC stream bytes. Rejects `HostError(400, <the engine's message>)` for a statement the engine refuses or cannot run. */
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
    await applyPolicy(conn);
  } catch (e) {
    await db.terminate();
    throw e;
  }
  const connection = conn;
  let tail: Promise<unknown> = Promise.resolve();
  return {
    restarts: 0,
    query(sql) {
      const run = tail.then(() =>
        runPending(db, connection.id, wrapStatement(sql)).catch((e: unknown) => {
          throw new HostError(400, engineMessage(e));
        }),
      );
      tail = run.catch(() => undefined);
      return run;
    },
    async close() {
      await tail;
      await db.terminate();
    },
  };
}
