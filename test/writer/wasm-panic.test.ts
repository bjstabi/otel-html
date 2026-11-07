import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { watchWasmPanics } from '../../src/writer/wasm-panic.js';

type Listener = NodeJS.UncaughtExceptionListener;

const emit = (e: unknown): void => {
  (process as unknown as { emit(event: string, ...args: unknown[]): boolean }).emit(
    'uncaughtException',
    e,
    'uncaughtException',
  );
};

const runtimeError = (message: string): Error => {
  const wasm: unknown = Reflect.get(globalThis, 'WebAssembly');
  const cls = Reflect.get(wasm as object, 'RuntimeError') as new (m: string) => Error;
  return new cls(message);
};

const count = (): number => process.listenerCount('uncaughtException');

// The test runner has its own uncaughtException listeners; take them off while a test owns the event.
let saved: Listener[] = [];
beforeEach(() => {
  saved = process.listeners('uncaughtException') as Listener[];
  process.removeAllListeners('uncaughtException');
});
afterEach(() => {
  process.removeAllListeners('uncaughtException');
  for (const l of saved) process.on('uncaughtException', l);
  vi.restoreAllMocks();
});

const never = (): Promise<never> => new Promise(() => undefined);

describe('watchWasmPanics', () => {
  test('listens on uncaughtException only, and a rejection the host handles is unaffected', async () => {
    const rejections = process.listenerCount('unhandledRejection');
    const w = watchWasmPanics();
    expect(process.listenerCount('unhandledRejection')).toBe(rejections);
    const handled = Promise.reject(new Error('handled by the host'));
    await expect(w.guard(handled)).rejects.toThrow('handled by the host');
    await expect(w.guard(Promise.resolve(7))).resolves.toBe(7);
    w.stop();
  });

  test('nested watches share one listener, installed with the first and removed after the last', () => {
    expect(count()).toBe(0);
    const a = watchWasmPanics();
    const b = watchWasmPanics();
    expect(count()).toBe(1);
    a.stop();
    expect(count()).toBe(1);
    b.stop();
    expect(count()).toBe(0);
    b.stop(); // stopping twice is harmless
    expect(count()).toBe(0);
  });

  test('a panic rejects the guarded wait of every active watch, naming the file being read', async () => {
    const a = watchWasmPanics();
    const b = watchWasmPanics();
    const waits = [a.guard(never(), 'data/partitions/000001/logs.parquet'), b.guard(never())];
    emit(runtimeError('unreachable'));
    await expect(waits[0]).rejects.toMatchObject({ code: 'invalid-report' });
    await expect(waits[0]).rejects.toThrow('parquet-wasm panicked: unreachable');
    await expect(waits[1]).rejects.toMatchObject({ code: 'invalid-report' });
    a.stop();
    b.stop();
  });

  test('an error that is not a panic goes to the host listener once, and does not crash', async () => {
    const seen: unknown[] = [];
    process.on('uncaughtException', (e) => seen.push(e));
    const w = watchWasmPanics();
    const boom = new Error('host business');
    const thrown = vi.spyOn(globalThis, 'setImmediate');
    emit(boom);
    expect(seen).toEqual([boom]);
    expect(thrown).not.toHaveBeenCalled();
    expect(count()).toBe(2); // the host's and the watch's
    w.stop();
    expect(count()).toBe(1);
  });

  test('a plain Error named RuntimeError is not swallowed: with no host listener it is rethrown', () => {
    const w = watchWasmPanics();
    const lookalike = Object.assign(new Error('not a panic'), { name: 'RuntimeError' });
    const later: (() => void)[] = [];
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((fn: () => void) => {
      later.push(fn);
      return 0 as never;
    }) as never);
    let rejected = false;
    void w.guard(never()).catch(() => {
      rejected = true;
    });
    emit(lookalike);
    expect(rejected).toBe(false);
    expect(count()).toBe(0); // the watch removed itself
    expect(later).toHaveLength(1);
    expect(() => later[0]?.()).toThrow(lookalike);
    w.stop();
    expect(count()).toBe(0);
  });

  test('a host listener added with once still handles a non-panic error: nothing is rethrown', () => {
    const w = watchWasmPanics();
    const seen: unknown[] = [];
    process.once('uncaughtException', (e) => seen.push(e));
    const later = vi.spyOn(globalThis, 'setImmediate');
    const boom = new Error('first');
    emit(boom);
    expect(seen).toEqual([boom]);
    expect(later).not.toHaveBeenCalled();
    w.stop();
  });

  test('a watch started after something removed every listener installs it again', async () => {
    const a = watchWasmPanics();
    process.removeAllListeners('uncaughtException');
    const b = watchWasmPanics();
    expect(count()).toBe(1);
    const wait = b.guard(never(), 'f');
    emit(runtimeError('unreachable'));
    await expect(wait).rejects.toMatchObject({ code: 'invalid-report' });
    a.stop();
    b.stop();
    expect(count()).toBe(0);
  });
});
