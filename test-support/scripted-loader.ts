import { installRegistry } from '../src/viewer/data/registry.js';
import type { ScriptLoader } from '../src/viewer/data/script-loader.js';

export interface ScriptedLoader extends ScriptLoader {
  /** Every `load` call's path, in call order. */
  readonly calls: readonly string[];
  reset(): void;
}

/** Report files keyed by report-relative path (`data/chunks/spans/000000.js`), from a memory-fs snapshot. */
export function reportFilesFromSnapshot(
  snapshot: ReadonlyMap<string, string>,
  out: string,
): Map<string, string> {
  const prefix = `${out}/`;
  const files = new Map<string, string>();
  for (const [path, text] of snapshot)
    if (path.startsWith(prefix)) files.set(path.slice(prefix.length), text);
  return files;
}

/**
 * Serves report files like the browser does: the data script is executed against a real registry
 * (`__OH__.push`), so payloads pass through the same take/unwrap path as in the viewer.
 */
export function createScriptedLoader(reportFiles: ReadonlyMap<string, string>): ScriptedLoader {
  const calls: string[] = [];
  const win: { __OH__: { q: [string, unknown][]; push(k: string, p: unknown): void } } = {
    __OH__: {
      q: [],
      push(k, p) {
        this.q.push([k, p]);
      },
    },
  };
  // The registry only touches `__OH__`, so this minimal stand-in is all a script needs.
  const registry = installRegistry(win as unknown as Window);
  return {
    calls,
    reset() {
      calls.length = 0;
    },
    async load(path, key) {
      calls.push(path);
      const text = reportFiles.get(path);
      if (text === undefined) throw new Error(`scripted loader: no file ${path} in the report`);
      const taken = registry.take(key);
      new Function('__OH__', text)(win.__OH__);
      return taken;
    },
  };
}
