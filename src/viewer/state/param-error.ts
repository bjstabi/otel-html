import type { z } from 'zod';

const MAX_ACTUAL = 80;

function pathString(root: string, path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : `${acc}.${String(p)}`),
    root,
  );
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur = root;
  for (const p of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = Reflect.get(cur, p);
  }
  return cur;
}

/** JSON text of a value for an error line, cut at 80 characters. */
export function shown(v: unknown): string {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > MAX_ACTUAL ? `${s.slice(0, MAX_ACTUAL)}...` : s;
}

/** One error line for a JSON URL key: `<root>.<path>: expected <what>, got <value>`. */
export function paramError(root: string, json: unknown, issue: z.core.$ZodIssue | undefined): string {
  if (issue?.code === 'unrecognized_keys') {
    const key = issue.keys[0] ?? '';
    const path = [...issue.path, key];
    return `${pathString(root, path)}: expected a known key, got ${shown(valueAt(json, path))}`;
  }
  const path = issue?.path ?? [];
  return `${pathString(root, path)}: expected ${issue?.message ?? 'a valid value'}, got ${shown(valueAt(json, path))}`;
}
