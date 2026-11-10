import { OtelHtmlError } from '../../model/errors.js';
import type { Registry } from './registry.js';

export interface ScriptLoader {
  /** Load the classic script at `path` (relative to index.html) and resolve with what it registers as `key`. */
  load(path: string, key: string): Promise<unknown>;
}

export const SCRIPT_TIMEOUT_MS = 30_000;

function failure(path: string, actual: string): OtelHtmlError {
  return new OtelHtmlError('invalid-report', {
    path,
    expected: 'a data script that registers its payload',
    actual,
  });
}

export function createDomScriptLoader(doc: Document, registry: Registry): ScriptLoader {
  return {
    load(path, key) {
      return new Promise((resolve, reject) => {
        const script = doc.createElement('script');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const abandoned = new AbortController();
        const fail = (actual: string): void => {
          settled = true;
          abandoned.abort(); // a script that runs after this registers into a registry nobody waits on
          clearTimeout(timer);
          script.remove();
          reject(failure(path, actual));
        };
        timer = setTimeout(() => fail(`no registration within ${SCRIPT_TIMEOUT_MS} ms`), SCRIPT_TIMEOUT_MS);
        script.addEventListener('error', () => fail('the script failed to load'));
        // A script's registration happens while it runs, so a load that settled nothing registered nothing.
        script.addEventListener('load', () => {
          if (!settled) fail(`the script ran but did not register "${key}"`);
        });
        // A payload left by the late script of an earlier load of this key is not this load's.
        registry.discard(key);
        registry.take(key, abandoned.signal).then((payload) => {
          settled = true;
          clearTimeout(timer);
          script.remove();
          resolve(payload);
        }, reject);
        script.src = path;
        doc.head.append(script);
      });
    },
  };
}
