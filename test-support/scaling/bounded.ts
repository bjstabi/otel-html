import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { OtelHtmlError } from '../../src/model/errors.js';

/** How long one step of the measurement may take before it counts as hung. */
export const STEP_TIMEOUT_MS = 60_000;

/** How long a worker waits for another's lock: longer than the holder's step, so a slow holder does not fail its waiters first. */
export const WAIT_TIMEOUT_MS = 2 * STEP_TIMEOUT_MS;

/** `work`, or an error naming `what` once `ms` have passed (the work itself is not cancelled). */
export async function bounded<T>(work: Promise<T>, what: string, ms = STEP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OtelHtmlError('usage', { message: `${what} did not finish in ${ms / 1000} s` })),
      ms,
    );
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The holder of a lock: its process and its worker thread (under the threads pool every worker has one pid). */
const holderFile = (lock: string): string => join(lock, 'holder');

/** Takes the lock folder `lock` (true), or says another worker holds it (false). The holder's pid and thread go in it. */
export async function takeLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  await writeFile(holderFile(lock), `${process.pid}:${threadId}`);
  return true;
}

/** Who holds the lock, as the file says; `pid` 0 when it is not written yet (the holder is between `mkdir` and `writeFile`). */
async function holderOf(lock: string): Promise<{ pid: number; thread: number }> {
  const [pid = 0, thread = 0] = (await readFile(holderFile(lock), 'utf8').catch(() => '0:0'))
    .split(':')
    .map(Number);
  return { pid: pid || 0, thread: thread || 0 };
}

/**
 * Waits 100 ms for the worker holding `lock`. Fails naming `what` when the holder's process is gone (a crashed worker
 * never releases its lock: Node 24.22's V8 aborts now and then when a DuckDB worker thread ends) or after `ms` (twice a
 * step's bound: a holder near its own bound must not fail its waiters at the same moment). A process can be probed, a
 * thread of it cannot: when the holder is another thread of this very process (the threads pool), only `ms` ends the
 * wait, and the error names that thread.
 */
export async function waitTurn(
  since: number,
  what: string,
  lock: string,
  ms = WAIT_TIMEOUT_MS,
): Promise<void> {
  const { pid, thread } = await holderOf(lock);
  const otherThread = pid === process.pid && thread !== threadId;
  if (pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH')
        throw new OtelHtmlError('usage', {
          message: `${what}: the worker holding the lock (pid ${pid}) died`,
        });
    }
  }
  if (performance.now() - since > ms)
    throw new OtelHtmlError('usage', {
      message: `${what}: waited ${ms / 1000} s for another worker${otherThread ? ` (thread ${thread} of pid ${pid}, which cannot be probed)` : ''}`,
    });
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

/**
 * Makes something once for all the workers of a run: `done()` says what exists (undefined when nothing does); the
 * first worker to take `lock` calls `make()`, the others wait and then read what it left. `done()` is asked again once
 * the lock is held, because the previous holder may have finished between the first look and the lock.
 */
export async function shareOnce<T>(opts: {
  lock: string;
  what: string;
  done: () => Promise<T | undefined>;
  make: () => Promise<T>;
  /** How long a waiter waits for the holder: `make` may run longer than a step, and the waiter must outlast it. */
  waitMs?: number;
}): Promise<T> {
  const since = performance.now();
  for (;;) {
    const first = await opts.done();
    if (first !== undefined) return first;
    if (!(await takeLock(opts.lock))) {
      // another worker makes it; if it failed, the lock is gone and this one takes over
      await waitTurn(since, opts.what, opts.lock, opts.waitMs);
      continue;
    }
    try {
      return (await opts.done()) ?? (await opts.make());
    } finally {
      await rm(opts.lock, { recursive: true, force: true });
    }
  }
}
