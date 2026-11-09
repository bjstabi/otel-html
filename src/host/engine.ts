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

const CLOSED_MESSAGE = 'the host is closed';

const sqlString = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * D37, in this order: a `LOAD` of an extension the build lacks hangs the worker when it runs before these.
 * `allowed_paths` names exactly the registered files: `allowed_directories` is a prefix rule, and a name that is not
 * registered falls through to the Node file system, relative to the process's working directory.
 */
export function policyStatements(manifest: ManifestV4): string[] {
  return [
    'SET autoinstall_known_extensions = false',
    'SET autoload_known_extensions = false',
    `SET allowed_paths = [${listedPaths(manifest).map(sqlString).join(', ')}]`,
    'SET enable_external_access = false',
    'SET lock_configuration = true',
  ];
}

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
async function applyPolicy(
  conn: { query(sql: string): Promise<unknown> },
  manifest: ManifestV4,
): Promise<void> {
  for (const sql of policyStatements(manifest)) await conn.query(sql);
}

/** At most this many statements are in the engine's hands at once, the running one included; more are refused 503. */
export const MAX_QUEUED = 256;
/** A worker call unsettled this long after the statement's timeout means a hung worker: it is replaced. */
export const HUNG_GRACE_MS = 5_000;

/** A worker that has not finished its files, views and policy by then is hung; independent of the statement timeout. */
export const OPEN_DEADLINE_MS = 30_000;

export interface HostEngineOptions {
  report: string;
  manifest: ManifestV4;
  files: HostEngineFiles;
  fs: Pick<FileSystem, 'exists'>;
  logger: Logger;
  timeoutMs: number;
  maxResultBytes: number;
  /** Test only: the grace after the timeout before a silent worker is replaced (default `HUNG_GRACE_MS`). */
  graceMs?: number;
  /** Test only: how long a worker may take to open (default `OPEN_DEADLINE_MS`). */
  openDeadlineMs?: number;
  open?: typeof openNodeDuckDb;
}

export interface HostEngine {
  /**
   * One client statement as Arrow IPC stream bytes. Rejects `HostError`: 400 (the engine's message) for a statement it
   * refuses or cannot run, 413 over the result cap, 503 when the queue is full or the engine is closed, 504 past the
   * timeout or when the worker had to be replaced.
   */
  query(sql: string): Promise<Uint8Array>;
  readonly restarts: number;
  /** Stops the worker at once, even mid-statement; idempotent. Statements still waiting reject 503. */
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

/** A worker and its one connection, with the files registered, the views created and the policy applied. */
interface Live {
  db: NodeDuckDb;
  conn: Awaited<ReturnType<NodeDuckDb['connect']>>;
  /** What to tell the statements in flight when the worker dies: one subscription to `exited` serves them all. */
  onExit: Set<(reason: string) => void>;
}

/** The setup of D36 and D37, shared by the first start and every restart. */
async function openLive(opts: HostEngineOptions, report: string): Promise<Live> {
  const db = await (opts.open ?? openNodeDuckDb)(opts.files);
  try {
    for (const path of listedPaths(opts.manifest)) {
      await db.registerFileURL(path, join(report, path), NODE_FS_PROTOCOL, false);
    }
    const conn = await db.connect();
    for (const sql of viewStatements(opts.manifest, (p) => p)) await conn.query(sql);
    await applyPolicy(conn, opts.manifest);
    const live: Live = { db, conn, onExit: new Set() };
    void db.exited?.then((reason) => {
      for (const notify of [...live.onExit]) notify(reason);
    });
    return live;
  } catch (e) {
    await db.terminate().catch(() => undefined);
    throw e;
  }
}

/** The worker stopped answering or died; carries why. */
class WorkerLost extends Error {}

const sleepUntil = (ms: number, reason: string): { promise: Promise<never>; cancel(): void } => {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WorkerLost(reason)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
};

/**
 * The D38 loop for one statement: prepare (refuses more than one statement, which closed a wrap breakout), start, poll
 * while `null` (cancelling at the deadline), fetch until an empty message (the messages are the IPC stream), stopping
 * past the cap. Cancel and cap drop the connection and open another: the cheap way to forget a half-read result.
 */
async function runStatement(live: Live, opts: HostEngineOptions, sql: string): Promise<Uint8Array> {
  const deadline = Date.now() + opts.timeoutMs;
  const timedOut = () => new HostError(504, `the statement did not finish within ${opts.timeoutMs} ms`);
  // A cancel or a reset that fails leaves a connection nothing can use: the worker is replaced.
  const lost = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (e) {
      throw new WorkerLost(`${what} failed: ${engineMessage(e)}`);
    }
  };
  const reset = () =>
    lost('reopening the connection', async () => {
      await live.conn.close().catch(() => undefined);
      live.conn = await live.db.connect();
    });
  const wrapped = wrapStatement(sql);
  try {
    await (await live.conn.prepare(wrapped)).close();
    const id = live.conn.id;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const take = async (chunk: Uint8Array) => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > opts.maxResultBytes) {
        await reset();
        throw new HostError(413, `the result exceeds ${opts.maxResultBytes} bytes`);
      }
    };
    let header = await live.db.startPendingQuery(id, wrapped, false);
    while (header === null) {
      if (Date.now() >= deadline) {
        await lost('cancelling the statement', () => live.db.cancelPendingQuery(id));
        throw timedOut();
      }
      header = await live.db.pollPendingQuery(id);
    }
    await take(header);
    // The end of the result is an empty message (duckdb-wasm's own iterator stops on it); `null` is tolerated too.
    for (;;) {
      if (Date.now() >= deadline) {
        await reset();
        throw timedOut();
      }
      const chunk = await live.db.fetchQueryResults(id);
      if (chunk === null || chunk.length === 0) break;
      await take(chunk);
    }
    return concat(chunks);
  } catch (e) {
    if (e instanceof HostError || e instanceof WorkerLost) throw e;
    throw new HostError(400, engineMessage(e));
  }
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
  const graceMs = opts.graceMs ?? HUNG_GRACE_MS;
  let live: Live | null = null;
  let closed = false;
  let outstanding = 0;
  let restarts = 0;
  let tail: Promise<unknown> = Promise.resolve();

  /** `openLive` under its own deadline, unless `close()` came first; a worker nobody will use is stopped here. */
  async function reopen(first = false): Promise<Live> {
    const opening = openLive(opts, report);
    const guard = sleepUntil(opts.openDeadlineMs ?? OPEN_DEADLINE_MS, 'the new worker did not start');
    try {
      const fresh = await Promise.race([opening, guard.promise]);
      if (closed) {
        await fresh.db.terminate().catch(() => undefined);
        throw new HostError(503, CLOSED_MESSAGE);
      }
      return fresh;
    } catch (e) {
      // A worker that finishes starting after we gave up on it is stopped too.
      void opening.then(
        (late) => (late === live ? undefined : late.db.terminate().catch(() => undefined)),
        () => undefined,
      );
      if (e instanceof HostError) throw e;
      opts.logger.debug(`the engine worker could not be started: ${engineMessage(e)}`);
      throw new HostError(
        503,
        first ? `the engine did not start: ${engineMessage(e)}` : 'the engine could not be restarted',
      );
    } finally {
      guard.cancel();
    }
  }

  /** Runs one statement under the hung-worker guard; a lost worker is replaced before the request fails 504. */
  async function execute(sql: string): Promise<Uint8Array> {
    if (closed) throw new HostError(503, CLOSED_MESSAGE);
    live ??= await reopen();
    const current = live;
    const work = runStatement(current, opts, sql);
    work.catch(() => undefined);
    const hung = sleepUntil(opts.timeoutMs + graceMs, 'the worker did not answer');
    let notify: (reason: string) => void = () => {};
    const died = new Promise<never>((_, reject) => {
      notify = (reason) => reject(new WorkerLost(reason));
      current.onExit.add(notify);
    });
    died.catch(() => undefined);
    try {
      return await Promise.race([work, hung.promise, died]);
    } catch (e) {
      if (!(e instanceof WorkerLost)) throw e;
      if (closed) throw new HostError(503, CLOSED_MESSAGE);
      live = null;
      await current.db.terminate().catch(() => undefined);
      restarts += 1;
      // The request's one warn line is written by `query`; the replacement is its cause.
      opts.logger.debug(`the engine worker was replaced (${e.message})`);
      try {
        live = await reopen();
      } catch (failure) {
        opts.logger.debug(`the engine worker could not be restarted: ${engineMessage(failure)}`);
      }
      if (closed) throw new HostError(503, CLOSED_MESSAGE);
      if (live === null) throw new HostError(503, 'the engine stopped answering and could not be restarted');
      throw new HostError(504, 'the engine stopped answering and was restarted');
    } finally {
      hung.cancel();
      current.onExit.delete(notify);
    }
  }

  // The first open is bounded like every reopen: a worker that hangs at start fails the start.
  live = await reopen(true);

  return {
    get restarts() {
      return restarts;
    },
    query(sql) {
      if (closed) return Promise.reject(new HostError(503, CLOSED_MESSAGE));
      if (outstanding >= MAX_QUEUED) {
        opts.logger.warn(`503 the host is busy: ${sql.slice(0, 200)}`);
        return Promise.reject(new HostError(503, 'the host is busy'));
      }
      outstanding += 1;
      const run = tail.then(async () => {
        try {
          const out = await execute(sql);
          opts.logger.debug(`ok ${out.length} bytes: ${sql.slice(0, 200)}`);
          return out;
        } catch (e) {
          if (e instanceof HostError && e.message !== CLOSED_MESSAGE) {
            opts.logger.warn(`${e.status} ${e.message}: ${sql.slice(0, 200)}`);
          }
          throw e;
        } finally {
          outstanding -= 1;
        }
      });
      tail = run.catch(() => undefined);
      return run;
    },
    async close() {
      if (closed) return;
      closed = true;
      const last = live;
      live = null;
      await last?.db.terminate().catch(() => undefined);
    },
  };
}
