import type { Timers } from '../src/writer/ports.js';

/** Timers that run only when `fire()` is called: every armed, uncancelled callback once, in arming order. */
export function createFakeTimers(): Timers & { fire(): number; readonly pending: number } {
  let armed: Array<{ fn: () => void }> = [];
  return {
    after(_ms, fn) {
      const entry = { fn };
      armed.push(entry);
      return () => {
        armed = armed.filter((e) => e !== entry);
      };
    },
    fire() {
      const batch = armed;
      armed = [];
      for (const e of batch) e.fn();
      return batch.length;
    },
    get pending() {
      return armed.length;
    },
  };
}
