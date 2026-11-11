import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OtelHtmlError } from '../../src/model/errors.js';

/** How long one step of the measurement may take before it counts as hung. */
export const STEP_TIMEOUT_MS = 60_000;

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

/** Takes the lock folder `lock` (true), or says another worker holds it (false). The holder's pid goes in it. */
export async function takeLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  await writeFile(join(lock, 'pid'), String(process.pid));
  return true;
}

/**
 * Waits 100 ms for the worker holding `lock`. Fails naming `what` when the holder's process is gone (a crashed worker
 * never releases its lock: Node 24.22's V8 aborts now and then when a DuckDB worker thread ends) or after `ms`.
 */
export async function waitTurn(
  since: number,
  what: string,
  lock: string,
  ms = STEP_TIMEOUT_MS,
): Promise<void> {
  const pid = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => '0'));
  if (pid > 0) {
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
    throw new OtelHtmlError('usage', { message: `${what}: waited ${ms / 1000} s for another worker` });
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}
