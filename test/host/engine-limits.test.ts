import { tableFromIPC } from 'apache-arrow';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type HostEngine,
  type HostEngineOptions,
  HostError,
  HUNG_GRACE_MS,
  MAX_QUEUED,
  startHostEngine,
} from '../../src/host/engine.js';
import { type NodeDuckDb, openNodeDuckDb } from '../../src/host/node-duckdb.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { buildFormat4Report, spansOnlyRequest } from '../../test-support/format4-fixture.js';
import { packageHostEngineFiles } from '../../test-support/host-engine-files.js';
import { writeReportDir } from '../../test-support/report-dir.js';

const warnings: string[] = [];
const logger = {
  debug() {},
  info() {},
  warn(message: string) {
    warnings.push(message);
  },
  error() {},
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  warnings.length = 0;
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function started(over: Partial<HostEngineOptions> = {}): Promise<HostEngine> {
  const fixture = await buildFormat4Report([spansOnlyRequest(3)], { close: false });
  const report = await writeReportDir(fixture);
  cleanups.push(report.close);
  const engine = await startHostEngine({
    report: report.dir,
    manifest: fixture.manifest,
    files: packageHostEngineFiles(),
    fs: createNodeFileSystem(),
    logger,
    timeoutMs: 30_000,
    maxResultBytes: 64 * 1024 * 1024,
    ...over,
  });
  cleanups.push(() => engine.close());
  return engine;
}

const rejection = async (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
const LONG = 'SELECT count(*) FROM range(300000000) r1, range(50) r2 WHERE (r1.range * r2.range) % 7919 = 1';
const count = (bytes: Uint8Array): number => tableFromIPC(bytes).numRows;

describe('the statement timeout (Review Focus 2)', () => {
  it('cancels a long statement at the timeout and answers the next one within 100 ms (@perf)', async () => {
    const e = await started({ timeoutMs: 300 });
    const t0 = performance.now();
    await rejection(e.query(LONG));
    const cancelMs = performance.now() - t0;
    const t1 = performance.now();
    await e.query('SELECT 1');
    const nextMs = performance.now() - t1;
    process.stdout.write(`perf: cancel ${cancelMs.toFixed(0)} ms, next statement ${nextMs.toFixed(0)} ms\n`);
    expect(cancelMs).toBeGreaterThan(250);
    expect(cancelMs).toBeLessThan(1500);
    expect(nextMs).toBeLessThan(100);
  });

  it('cancels a long statement at the timeout and answers the next one at once', async () => {
    const e = await started({ timeoutMs: 300 });
    const t0 = performance.now();
    const error = await rejection(
      e.query(
        'SELECT count(*) FROM range(300000000) r1, range(50) r2 WHERE (r1.range * r2.range) % 7919 = 1',
      ),
    );
    const cancelMs = performance.now() - t0;
    process.stdout.write(`${`cancel latency: 504 after ${cancelMs.toFixed(0)} ms (timeout 300 ms)`}\n`);
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).status).toBe(504);
    expect((error as HostError).message).toBe('the statement did not finish within 300 ms');
    expect(cancelMs).toBeGreaterThan(250); // never before the deadline
    expect(count(await e.query('SELECT 1'))).toBe(1);
    expect(e.restarts).toBe(0);
    expect(warnings.some((w) => w.includes('504'))).toBe(true);
  });
});

describe('the result cap (Review Focus 3)', () => {
  it('stops reading long before the end of a huge result (@perf)', async () => {
    const e = await started({ maxResultBytes: 1_000_000 });
    const t0 = performance.now();
    await rejection(e.query('SELECT range AS x, range AS y, range AS z FROM range(20000000)'));
    const ms = performance.now() - t0;
    process.stdout.write(`perf: cap 413 after ${ms.toFixed(0)} ms\n`);
    // 20 million rows of three bigints are 480 MB: reading it all would take seconds.
    expect(ms).toBeLessThan(2000);
  });

  it('refuses a result above the cap without reading all of it, and the next statement works', async () => {
    const e = await started({ maxResultBytes: 1_000_000 });
    const t0 = performance.now();
    const error = await rejection(e.query('SELECT range AS x, range AS y, range AS z FROM range(20000000)'));
    const ms = performance.now() - t0;
    process.stdout.write(`${`cap: 413 after ${ms.toFixed(0)} ms`}\n`);
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).status).toBe(413);
    expect((error as HostError).message).toBe('the result exceeds 1000000 bytes');
    expect(count(await e.query('SELECT 1'))).toBe(1);
  });

  it('streams 250,000 rows under the default cap', async () => {
    const e = await started();
    expect(count(await e.query('SELECT range AS x FROM range(250000)'))).toBe(250_000);
  });
});

describe('the queue', () => {
  it('runs at most MAX_QUEUED statements and refuses the rest 503', async () => {
    const e = await started();
    const results = await Promise.all(
      Array.from({ length: 300 }, () =>
        e.query('SELECT 1').then(
          () => 'ok',
          (err: unknown) => err,
        ),
      ),
    );
    const ok = results.filter((r) => r === 'ok').length;
    const busy = results.filter((r) => r instanceof HostError && r.status === 503);
    process.stdout.write(`${`queue: ${ok} resolved, ${busy.length} refused`}\n`);
    expect(ok).toBeGreaterThanOrEqual(MAX_QUEUED);
    expect(ok + busy.length).toBe(300);
    expect((busy[0] as HostError).message).toBe('the host is busy');
  });
});

describe('close', () => {
  it('stops a worker whose open was still in flight, and the query rejects 503', async () => {
    const log: string[] = [];
    const dbs = [
      fakeDb(() => new Promise<never>(() => {}), log, 'first'),
      fakeDb(async () => null, log, 'late'),
    ];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let opened = 0;
    const e = await started({
      timeoutMs: 50,
      graceMs: 50,
      open: async () => {
        opened += 1;
        if (opened === 2) await gate; // the restart's open is slow
        return dbs.shift() as NodeDuckDb;
      },
    });
    const pending = rejection(e.query('SELECT 1'));
    while (opened < 2) await new Promise((r) => setTimeout(r, 10));
    await e.close();
    release();
    const error = await pending;
    expect((error as HostError).status).toBe(503);
    expect(log).toContain('terminate late');
  });

  it('is idempotent and later queries reject 503', async () => {
    const e = await started();
    await e.close();
    await e.close();
    const error = await rejection(e.query('SELECT 1'));
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).status).toBe(503);
  });

  it('does not wait for a hung statement', async () => {
    const e = await started({ timeoutMs: 60_000 });
    const long = rejection(
      e.query(
        'SELECT count(*) FROM range(300000000) r1, range(50) r2 WHERE (r1.range * r2.range) % 7919 = 1',
      ),
    );
    await new Promise((r) => setTimeout(r, 100));
    await e.close();
    expect(((await long) as HostError).status).toBe(503);
  });
});

/** A `NodeDuckDb` whose statements the test controls. */
function fakeDb(onPoll: () => Promise<Uint8Array | null>, log: string[], name: string): NodeDuckDb {
  const conn = {
    id: 1,
    query: async () => undefined,
    prepare: async () => ({ close: async () => undefined }),
    close: async () => undefined,
  };
  return {
    startPendingQuery: async () => null,
    pollPendingQuery: onPoll,
    cancelPendingQuery: async () => true,
    fetchQueryResults: async () => null,
    registerFileURL: async () => undefined,
    connect: async () => conn,
    terminate: async () => {
      log.push(`terminate ${name}`);
    },
  };
}

describe('the restart', () => {
  it('measured with the real engine: a hung first worker is replaced by a fresh real one', async () => {
    let opened = 0;
    const open: typeof openNodeDuckDb = async (files) => {
      const db = await openNodeDuckDb(files);
      opened += 1;
      if (opened > 1) return db;
      return {
        ...db,
        startPendingQuery: async () => null,
        pollPendingQuery: () => new Promise<never>(() => {}),
      };
    };
    const e = await started({ timeoutMs: 50, graceMs: 100, open });
    const t0 = performance.now();
    const error = await rejection(e.query('SELECT 1'));
    const total = performance.now() - t0;
    process.stdout.write(
      `real restart: ${(total - 150).toFixed(0)} ms to a fresh worker (504 after ${total.toFixed(0)} ms)\n`,
    );
    expect((error as HostError).status).toBe(504);
    expect(e.restarts).toBe(1);
    expect(count(await e.query('SELECT 1'))).toBe(1);
  });

  it('replaces a worker that stops answering, after the timeout plus the grace', async () => {
    expect(HUNG_GRACE_MS).toBe(5000);
    const log: string[] = [];
    const answer = new Uint8Array([1, 2, 3]);
    const dbs = [
      fakeDb(() => new Promise<never>(() => {}), log, 'first'),
      fakeDb(async () => answer, log, 'second'),
    ];
    const e = await started({ timeoutMs: 50, graceMs: 100, open: async () => dbs.shift() as NodeDuckDb });
    const t0 = performance.now();
    const error = await rejection(e.query('SELECT 1'));
    const ms = performance.now() - t0;
    process.stdout.write(
      `${`restart: 504 and a fresh worker ready after ${ms.toFixed(0)} ms (timeout 50 + grace 100)`}\n`,
    );
    expect((error as HostError).status).toBe(504);
    expect(ms).toBeGreaterThanOrEqual(140);
    expect(e.restarts).toBe(1);
    expect(log).toEqual(['terminate first']);
    expect(await e.query('SELECT 1')).toEqual(answer);
    expect(warnings.some((w) => w.includes('restart'))).toBe(true);
  });

  it('replaces a worker that dies, at once', async () => {
    let die: (reason: string) => void = () => {};
    const exited = new Promise<string>((r) => {
      die = r;
    });
    const log: string[] = [];
    const answer = new Uint8Array([9]);
    const first = { ...fakeDb(() => new Promise<never>(() => {}), log, 'first'), exited };
    const dbs: NodeDuckDb[] = [first, fakeDb(async () => answer, log, 'second')];
    const e = await started({ timeoutMs: 60_000, open: async () => dbs.shift() as NodeDuckDb });
    const pending = rejection(e.query('SELECT 1'));
    await new Promise((r) => setTimeout(r, 20));
    die('worker exited with code 1');
    const error = await pending;
    expect((error as HostError).status).toBe(504);
    expect(e.restarts).toBe(1);
    expect(await e.query('SELECT 1')).toEqual(answer);
  });
});
