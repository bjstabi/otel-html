import type { PanicGuard } from '../format/parquet/stream.js';
import { OtelHtmlError } from '../model/errors.js';

export interface PanicWatch {
  /** Waits for a promise, but rejects as soon as parquet-wasm panics meanwhile. `what` names the file being read. */
  guard: PanicGuard;
  /** Stops watching; call it in a `finally`. */
  stop(): void;
}

/** The global `WebAssembly.RuntimeError` class, which this project's type libraries lack. */
function runtimeErrorClass(): (new (...args: never[]) => Error) | undefined {
  const wasm: unknown = Reflect.get(globalThis, 'WebAssembly');
  const cls: unknown =
    typeof wasm === 'object' && wasm !== null ? Reflect.get(wasm, 'RuntimeError') : undefined;
  return typeof cls === 'function' ? (cls as new (...args: never[]) => Error) : undefined;
}

function isWasmPanic(e: unknown): e is Error {
  const cls = runtimeErrorClass();
  return cls !== undefined && e instanceof cls;
}

/** One failing function per active watch. The listener below is shared, so there is one however many compactions run. */
const active = new Set<(panic: Error) => void>();

function onUncaught(e: unknown): void {
  if (isWasmPanic(e)) {
    for (const fail of [...active]) fail(e);
    return;
  }
  // Not ours. With another listener on the process the host handles it; otherwise it must crash as it would have.
  if (process.listenerCount('uncaughtException') > 1) return;
  uninstall();
  setImmediate(() => {
    throw e;
  });
}

function uninstall(): void {
  process.off('uncaughtException', onUncaught);
}

/** Asks the process, not a flag: something may have removed every listener since the last watch started. */
function install(): void {
  if (process.listeners('uncaughtException').includes(onUncaught)) return;
  // First in line, so a host's `once` listener, which Node removes just before calling it, is still counted when this runs.
  process.prependListener('uncaughtException', onUncaught);
}

/**
 * parquet-wasm does not report a panic (a corrupt row group in a streamed read) through the stream: the stream's
 * pending `read()` never settles, and the panic surfaces only as an uncaught `WebAssembly.RuntimeError`
 * (`uncaughtException` on Node and Bun; checked on Node 24 and Bun 1.4.4). While a watch is on, such an error rejects
 * the guarded wait with `invalid-report`, so the caller fails instead of hanging.
 *
 * - One `uncaughtException` listener is shared by all watches: installed with the first, removed after the last.
 * - A panic cannot be attributed to one stream, so it fails every watch active at that moment, every compaction
 *   running at the same time included. That is accepted: a compaction that fails keeps its flush partitions.
 * - An uncaught error that is not a `WebAssembly.RuntimeError` is left to the host's own listeners when it has any,
 *   and otherwise rethrown, so the process crashes as it would without the watch.
 * - After a panic the wasm instance still served new files in the checks made, but a read that panicked is
 *   abandoned, not resumed; its `cancel()` is started and its outcome ignored.
 */
export function watchWasmPanics(): PanicWatch {
  // The waits still pending, not a reaction added to one long-lived promise per wait: that kept every settled
  // wait's value (a record batch, an output chunk) alive until the watch stopped, so a compaction's memory grew with
  // the data it had read and written.
  const pending = new Set<(e: Error) => void>();
  let panic: Error | undefined;
  const fail = (e: Error): void => {
    panic ??= e;
    for (const reject of [...pending]) reject(e);
  };
  active.add(fail);
  install();
  const guard: PanicGuard = (wait, what) =>
    new Promise((resolve, reject) => {
      const panicked = (e: Error): void => {
        pending.delete(panicked);
        reject(
          new OtelHtmlError('invalid-report', {
            path: what ?? 'data/partitions',
            expected: 'a readable Parquet file',
            actual: `parquet-wasm panicked: ${e.message}`,
          }),
        );
      };
      if (panic !== undefined) {
        wait.catch(() => undefined); // still observed: it may reject later (an abandoned read), which must not be unhandled
        panicked(panic);
        return;
      }
      pending.add(panicked);
      wait.then(
        (value) => {
          pending.delete(panicked);
          resolve(value);
        },
        (error: unknown) => {
          pending.delete(panicked);
          reject(error);
        },
      );
    });
  return {
    guard,
    stop() {
      active.delete(fail);
      if (active.size === 0) uninstall();
    },
  };
}
