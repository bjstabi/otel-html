import type { z } from 'zod';
import { OtelHtmlError } from '../model/errors.js';

function describe(v: unknown): string {
  if (v === undefined) return 'nothing (missing)';
  const s = JSON.stringify(v);
  return s === undefined ? typeof v : s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

function joinPath(root: string, segs: readonly PropertyKey[]): string {
  let out = root;
  for (const seg of segs) {
    out = typeof seg === 'number' ? `${out}[${seg}]` : out === '' ? String(seg) : `${out}.${String(seg)}`;
  }
  return out === '' ? '(root)' : out;
}

/** Parse `input` with a Zod schema, reporting the first problem as an `invalid-report` error with a path. */
export function parseWith<T>(schema: z.ZodType<T>, input: unknown, root: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (issue === undefined)
    throw new OtelHtmlError('invalid-report', { path: root, expected: 'a valid value' });
  const path = joinPath(root, issue.path);
  const actual = describe(valueAt(input, issue.path));
  switch (issue.code) {
    case 'invalid_value':
      throw new OtelHtmlError('invalid-report', {
        path,
        expected: issue.values.map((v) => JSON.stringify(v)).join(' | '),
        actual,
      });
    case 'invalid_type':
      throw new OtelHtmlError('invalid-report', { path, expected: issue.expected, actual });
    case 'unrecognized_keys':
      throw new OtelHtmlError('invalid-report', {
        path,
        expected: 'no unknown keys',
        actual: issue.keys.map((k) => JSON.stringify(k)).join(', '),
      });
    default:
      throw new OtelHtmlError('invalid-report', { path, expected: issue.message, actual });
  }
}
