import { z } from 'zod';
import { OtelHtmlError } from '../model/errors.js';
import type { Clock, FileSystem, Logger, ProcessInfo } from './ports.js';

export interface LockHandle {
  release(): Promise<void>;
}

export interface LockDeps {
  fs: FileSystem;
  process: ProcessInfo;
  clock: Clock;
  logger: Logger;
}

const LockSchema = z.strictObject({
  pid: z.number().int().positive(),
  hostname: z.string(),
  startedAt: z.string(),
});

const HINT =
  'one writer per folder: send data to `otel-html serve` or combine reports with `otel-html merge`';

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '.' : p.slice(0, i);
}

function locked(path: string, detail: string): OtelHtmlError {
  return new OtelHtmlError('report-locked', {
    path,
    expected: 'an unlocked report folder',
    actual: detail,
    hint: HINT,
  });
}

/**
 * Take the folder's writer lock (`{ pid, hostname, startedAt }`, created exclusively). A lock held by a live
 * process, or by an unknown host, is refused with `report-locked`. A lock left by a dead process on this host
 * is reclaimed with a warning. Anything unreadable is refused rather than overwritten.
 */
export async function acquireLock(deps: LockDeps, path: string): Promise<LockHandle> {
  const { fs, process, clock, logger } = deps;
  await fs.mkdirp(dirOf(path));
  const mine = JSON.stringify({
    pid: process.pid,
    hostname: process.hostname,
    startedAt: new Date(Number(clock.nowUnixNano() / 1_000_000n)).toISOString(),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await fs.createExclusive(path, mine)) {
      return {
        async release() {
          await fs.remove(path);
        },
      };
    }
    let text: string;
    try {
      text = await fs.readText(path);
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'ENOENT') continue; // released in between: retry
      throw e;
    }
    let held: z.infer<typeof LockSchema>;
    try {
      held = LockSchema.parse(JSON.parse(text));
    } catch {
      throw locked(path, `an unreadable lock file; remove ${path} if no writer is running`);
    }
    if (held.hostname !== process.hostname) {
      throw locked(path, `held by pid ${held.pid} on host ${held.hostname} since ${held.startedAt}`);
    }
    if (process.isAlive(held.pid)) {
      throw locked(path, `held by pid ${held.pid} since ${held.startedAt}`);
    }
    logger.warn('reclaiming stale writer lock from a dead process', {
      path,
      pid: held.pid,
      startedAt: held.startedAt,
    });
    // Re-read before removing so a lock another process just reclaimed is not removed by mistake.
    if ((await fs.readText(path).catch(() => null)) === text) await fs.remove(path);
  }
  throw locked(path, 'the lock kept changing while it was being acquired');
}
