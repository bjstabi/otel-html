import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { acquireLock } from '../../src/writer/lock.js';
import { createProcess, createTestWriter } from '../../test-support/writer-deps.js';

const LOCK = 'r/data/state/lock.json';

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('acquireLock', () => {
  test('writes pid, hostname and startedAt, and release removes the file', async () => {
    const w = createTestWriter();
    const lock = await acquireLock(w.deps, LOCK);
    expect(JSON.parse(w.fs.snapshot().get(LOCK) ?? '')).toEqual({
      pid: 4242,
      hostname: 'host-a',
      startedAt: '2023-11-14T22:13:20.000Z',
    });
    await lock.release();
    expect(w.fs.snapshot().has(LOCK)).toBe(false);
    await (await acquireLock(w.deps, LOCK)).release();
  });

  test('refuses while a live process holds it, with the one-writer hint', async () => {
    const w = createTestWriter();
    await acquireLock(w.deps, LOCK);
    const other = createProcess(777);
    other.alive.add(4242);
    const e = await failure(acquireLock({ ...w.deps, process: other }, LOCK));
    expect(e.code).toBe('report-locked');
    expect(e.message).toContain('pid 4242');
    expect(e.hint).toBe(
      'one writer per folder: send data to `otel-html serve` or combine reports with `otel-html merge`',
    );
    expect(w.fs.snapshot().has(LOCK)).toBe(true);
  });

  test('a second acquire from the same live process is also refused', async () => {
    const w = createTestWriter();
    await acquireLock(w.deps, LOCK);
    expect((await failure(acquireLock(w.deps, LOCK))).code).toBe('report-locked');
  });

  test('reclaims a stale lock from a dead pid on the same host with a warning', async () => {
    const w = createTestWriter();
    await acquireLock(w.deps, LOCK); // pid 4242 "dies" below
    const successor = createProcess(900);
    const lock = await acquireLock({ ...w.deps, process: successor }, LOCK);
    const warn = w.logs.filter((l) => l.level === 'warn');
    expect(warn).toHaveLength(1);
    expect(warn[0]?.msg).toContain('stale');
    expect(warn[0]?.attrs).toMatchObject({ pid: 4242 });
    expect(JSON.parse(w.fs.snapshot().get(LOCK) ?? '').pid).toBe(900);
    await lock.release();
  });

  test('never reclaims a lock from another host, even if the pid looks dead', async () => {
    const w = createTestWriter();
    await acquireLock(w.deps, LOCK);
    const elsewhere = createProcess(900, 'host-b');
    const e = await failure(acquireLock({ ...w.deps, process: elsewhere }, LOCK));
    expect(e.code).toBe('report-locked');
    expect(e.message).toContain('host-a');
  });

  test('refuses an unreadable lock file rather than overwriting it', async () => {
    const w = createTestWriter();
    await w.fs.mkdirp('r/data/state');
    await w.fs.writeTextAtomic(LOCK, 'not json');
    const e = await failure(acquireLock(w.deps, LOCK));
    expect(e.code).toBe('report-locked');
    expect(w.fs.snapshot().get(LOCK)).toBe('not json');
  });
});
