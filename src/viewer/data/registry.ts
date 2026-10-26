import { OtelHtmlError } from '../../model/errors.js';

/** The `window.__OH__` global every data file registers into: `__OH__.push("<key>", <payload>);`. */
export interface OhGlobal {
  /** Pushes made before the registry was installed, drained by `installRegistry`. */
  q: [string, unknown][];
  push(key: string, payload: unknown): void;
}

declare global {
  interface Window {
    __OH__?: OhGlobal;
  }
}

export interface Registry {
  /** Resolves with the payload registered under `key` (now or later) and forgets it. */
  take(key: string): Promise<unknown>;
  /**
   * The payload of a data file loaded by a static `<script>` that precedes the viewer script (the manifest).
   * Classic scripts run in order, so by now it has either registered or failed (missing file, load error, script
   * error); waiting would hang forever, so a missing payload throws naming `file`.
   */
  takeStatic(key: string, file: string): unknown;
}

/**
 * Replace the inline bootstrap queue with the live registry, draining what was pushed so far.
 * index.html runs the bootstrap before any data script, so a missing one is a broken report.
 */
export function installRegistry(win: Window): Registry {
  const boot = win.__OH__;
  if (boot === undefined) {
    throw new OtelHtmlError('invalid-report', {
      path: 'index.html',
      expected: 'the inline `window.__OH__` bootstrap before any data script',
      actual: 'window.__OH__ is not defined',
    });
  }
  const values = new Map<string, unknown>();
  const waiters = new Map<string, ((payload: unknown) => void)[]>();

  const push = (key: string, payload: unknown): void => {
    const waiting = waiters.get(key);
    if (waiting === undefined) {
      values.set(key, payload);
      return;
    }
    waiters.delete(key);
    for (const resolve of waiting) resolve(payload);
  };

  for (const [key, payload] of boot.q) push(key, payload);
  win.__OH__ = { q: [], push };

  return {
    takeStatic(key, file) {
      if (!values.has(key)) {
        throw new OtelHtmlError('invalid-report', {
          path: file,
          expected: `${file} to load and register "${key}" before the viewer starts`,
          actual: 'nothing registered (the file is missing, was not uploaded, or failed to run)',
          hint: 'check that the data/ folder sits next to index.html and was copied completely',
        });
      }
      const payload = values.get(key);
      values.delete(key);
      return payload;
    },
    take(key) {
      if (values.has(key)) {
        const payload = values.get(key);
        values.delete(key);
        return Promise.resolve(payload);
      }
      return new Promise((resolve) => {
        waiters.set(key, [...(waiters.get(key) ?? []), resolve]);
      });
    },
  };
}
