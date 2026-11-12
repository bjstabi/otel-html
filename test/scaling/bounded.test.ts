import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { afterEach, describe, expect, test } from 'vitest';
import {
  bounded,
  STEP_TIMEOUT_MS,
  shareOnce,
  takeLock,
  WAIT_TIMEOUT_MS,
  waitTurn,
} from '../../test-support/scaling/bounded.js';

describe('the bounds of the scaling workers', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  const tmp = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'otel-bounded-'));
    dirs.push(d);
    return d;
  };

  test('a lock is taken once, and a waiter on a live holder waits', async () => {
    const lock = join(await tmp(), 'x.lock');
    expect(await takeLock(lock)).toBe(true);
    expect(await takeLock(lock)).toBe(false);
    await expect(waitTurn(performance.now(), 'x', lock)).resolves.toBeUndefined();
  });

  test('a waiter fails at once when the holder process is gone', async () => {
    const lock = join(await tmp(), 'x.lock');
    expect(await takeLock(lock)).toBe(true);
    // a pid that is not a process: the largest the kernel hands out is below 2^22
    await writeFile(join(lock, 'holder'), '2147483646:0');
    await expect(waitTurn(performance.now(), 'metrics.query.short on 2-2-2-dense', lock)).rejects.toThrow(
      /metrics\.query\.short on 2-2-2-dense: the worker holding the lock \(pid 2147483646\) died/,
    );
  });

  test('the lock records the pid and the thread of its holder', async () => {
    const lock = join(await tmp(), 'x.lock');
    expect(await takeLock(lock)).toBe(true);
    expect(await readFile(join(lock, 'holder'), 'utf8')).toBe(`${process.pid}:${threadId}`);
  });

  test('a holder thread of a live process cannot be probed: the waiter waits for the bound and names it', async () => {
    const lock = join(await tmp(), 'x.lock');
    expect(await takeLock(lock)).toBe(true);
    // the same process, another thread (the threads pool): the pid is alive whether or not that thread is
    await writeFile(join(lock, 'holder'), `${process.pid}:${threadId + 7}`);
    await expect(waitTurn(performance.now(), 'x', lock)).resolves.toBeUndefined();
    await expect(waitTurn(performance.now() - 500, 'x', lock, 100)).rejects.toThrow(
      new RegExp(`waited 0.1 s.*thread ${threadId + 7} of pid ${process.pid}`),
    );
  });

  test('a waiter gives up after the bound, naming what it waits for', async () => {
    const lock = join(await tmp(), 'x.lock');
    expect(await takeLock(lock)).toBe(true);
    await expect(waitTurn(performance.now() - 500, 'the report 4-2-4-dense', lock, 100)).rejects.toThrow(
      /the report 4-2-4-dense: waited 0.1 s/,
    );
  });

  test('the default wait outlasts a step: it is the holder that fails first', async () => {
    expect(WAIT_TIMEOUT_MS).toBeGreaterThan(STEP_TIMEOUT_MS);
    const lock = join(await tmp(), 'x.lock');
    expect(await takeLock(lock)).toBe(true);
    // a waiter that has waited one step's bound plus a second is still waiting; past the default bound it gives up
    await expect(waitTurn(performance.now() - STEP_TIMEOUT_MS - 1000, 'x', lock)).resolves.toBeUndefined();
    await expect(waitTurn(performance.now() - WAIT_TIMEOUT_MS - 1000, 'x', lock)).rejects.toThrow(
      /waited 120 s/,
    );
  });

  test('a step that never ends fails with its name', async () => {
    await expect(bounded(new Promise<never>(() => {}), 'a statement', 50)).rejects.toThrow(
      /a statement did not finish/,
    );
    await expect(bounded(Promise.resolve(3), 'a statement', 50)).resolves.toBe(3);
  });

  test('shareOnce makes once, and does not make again what appeared while it waited for the lock', async () => {
    const lock = join(await tmp(), 'x.lock');
    let made = 0;
    let exists: string | undefined;
    let looks = 0;
    // the first look finds nothing; the previous holder finishes before the lock is taken: the second look finds it
    const value = await shareOnce({
      lock,
      what: 'x',
      done: async () => {
        looks++;
        if (looks === 2) exists = 'from the other worker';
        return exists;
      },
      make: async () => {
        made++;
        return 'mine';
      },
    });
    expect(value).toBe('from the other worker');
    expect(made).toBe(0);
    // and the lock is released
    expect(await takeLock(lock)).toBe(true);
  });

  test('shareOnce makes what nobody has made, and releases the lock when it fails', async () => {
    const lock = join(await tmp(), 'x.lock');
    await expect(
      shareOnce({
        lock,
        what: 'x',
        done: async () => undefined,
        make: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    const value = await shareOnce({ lock, what: 'x', done: async () => undefined, make: async () => 7 });
    expect(value).toBe(7);
  });
});

describe('the waiter of shareOnce', () => {
  test('is given the bound the caller names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otel-bounded-'));
    try {
      const lock = join(dir, 'x.lock');
      // another thread of this process holds the lock and never lets go
      await mkdir(lock);
      await writeFile(join(lock, 'holder'), `${process.pid}:${threadId + 7}`);
      await expect(
        shareOnce({ lock, what: 'x', waitMs: 150, done: async () => undefined, make: async () => 1 }),
      ).rejects.toThrow(/x: waited 0.15 s/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
