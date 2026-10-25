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
        const fail = (actual: string): void => {
          settled = true;
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
        registry.take(key).then((payload) => {
          settled = true;
          clearTimeout(timer);
          resolve(payload);
        }, reject);
        script.src = path;
        doc.head.append(script);
      });
    },
  };
}
