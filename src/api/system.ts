import { hostname } from 'node:os';
import { parseUnixNanos } from '../model/ids.js';
import type { Clock, Logger, ProcessInfo, Timers } from '../writer/ports.js';

/** `setTimeout` that is unref'd: an idle session must not keep the process alive. */
export function createSystemTimers(): Timers {
  return {
    after(ms, fn) {
      const t = setTimeout(fn, ms);
      t.unref();
      return () => clearTimeout(t);
    },
  };
}

/** Wall clock anchored once at creation and advanced by the monotonic clock, so it never jumps backwards. */
export function createSystemClock(): Clock {
  const wall0 = BigInt(Date.now()) * 1_000_000n;
  const mono0 = process.hrtime.bigint();
  return {
    nowUnixNano: () => parseUnixNanos(wall0 + (process.hrtime.bigint() - mono0), 'clock'),
    monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  };
}

export function createProcessInfo(): ProcessInfo {
  return {
    pid: process.pid,
    hostname: hostname(),
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        // EPERM: the process exists but belongs to someone else.
        return e instanceof Error && 'code' in e && e.code === 'EPERM';
      }
    },
  };
}

/** Warnings and errors to stderr, with `info` too; `debug` is dropped. */
export function createConsoleLogger(): Logger {
  const write =
    (level: string) =>
    (msg: string, attrs?: Record<string, unknown>): void => {
      const tail = attrs === undefined ? '' : ` ${JSON.stringify(attrs)}`;
      process.stderr.write(`otel-html ${level}: ${msg}${tail}\n`);
    };
  return { debug: () => undefined, info: write('info'), warn: write('warn'), error: write('error') };
}
