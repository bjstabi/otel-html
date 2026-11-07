import type { PanicGuard } from '../format/parquet/stream.js';
import { OtelHtmlError } from '../model/errors.js';

export interface PanicWatch {
  /** Waits for a promise, but rejects as soon as parquet-wasm panics meanwhile. */
  guard: PanicGuard;
  /** Stops watching; call it in a `finally`. */
  stop(): void;
}

/** A `WebAssembly.RuntimeError` (the global is not in this project's type libraries, so it is recognised by name). */
function isWasmPanic(e: unknown): e is Error {
  return e instanceof Error && e.name === 'RuntimeError';
}

/**
 * parquet-wasm does not report a panic (a corrupt row group in a streamed read) through the stream: the stream's
 * pending `read()` never settles, and the panic surfaces as an uncaught `WebAssembly.RuntimeError` (an
 * `uncaughtException` on Node and Bun). While a watch is on, such an error rejects the guarded wait with
 * `invalid-report`, so the caller fails instead of hanging. Any other uncaught error is rethrown as it would have
 * been. After a panic the wasm instance still served new files in the checks made (Node 24, Bun 1.4.4), but a read
 * that panicked is abandoned, not resumed.
 */
export function watchWasmPanics(): PanicWatch {
  let fail: (e: Error) => void = () => undefined;
  const panicked = new Promise<never>((_, reject) => {
    fail = reject;
  });
  panicked.catch(() => undefined); // only a guarded wait observes it
  const onError = (e: unknown): void => {
    if (isWasmPanic(e)) {
      fail(
        new OtelHtmlError('invalid-report', {
          path: 'data/partitions',
          expected: 'a readable Parquet file',
          actual: `parquet-wasm panicked: ${e.message}`,
        }),
      );
      return;
    }
    stop();
    setImmediate(() => {
      throw e;
    });
  };
  const stop = (): void => {
    process.off('uncaughtException', onError);
    process.off('unhandledRejection', onError);
  };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return { guard: (wait) => Promise.race([wait, panicked]), stop };
}
