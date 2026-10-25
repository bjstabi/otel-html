import type { UnixNanos } from '../src/model/ids.js';
import type { Clock } from '../src/writer/ports.js';

export function createFixedClock(start: UnixNanos): Clock & { advance(ns: bigint): void } {
  let now: bigint = start;
  return {
    nowUnixNano: () => now as UnixNanos,
    monotonicMs: () => Number(now / 1_000_000n),
    advance(ns) {
      now += ns;
    },
  };
}
