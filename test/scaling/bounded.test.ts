import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { bounded, takeLock, waitTurn } from '../../test-support/scaling/bounded.js';

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
    await writeFile(join(lock, 'pid'), '2147483646');
    await expect(waitTurn(performance.now(), 'metrics.query.short on 2-2-2-dense', lock)).rejects.toThrow(
      /metrics\.query\.short on 2-2-2-dense: the worker holding the lock \(pid 2147483646\) died/,
    );
  });

  test('a waiter gives up after the bound, naming what it waits for', async () => {
    const lock = join(await tmp(), 'x.lock');
    expect(await takeLock(lock)).toBe(true);
    await expect(waitTurn(performance.now() - 500, 'the report 4-2-4-dense', lock, 100)).rejects.toThrow(
      /the report 4-2-4-dense: waited 0.1 s/,
    );
  });

  test('a step that never ends fails with its name', async () => {
    await expect(bounded(new Promise<never>(() => {}), 'a statement', 50)).rejects.toThrow(
      /a statement did not finish/,
    );
    await expect(bounded(Promise.resolve(3), 'a statement', 50)).resolves.toBe(3);
  });
});
