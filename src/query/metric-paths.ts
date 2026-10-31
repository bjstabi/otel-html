import { OtelHtmlError } from '../model/errors.js';
import type { Expr, Value } from '../ottl/ast.js';
import { CONTEXTS, type DatapointTarget, type PathAccessor } from '../ottl/contexts.js';
import { parseCondition } from '../ottl/parse.js';

// The paths a metric query's `where` and `by` may read: shared by the viewer, which evaluates them per series, and
// the schema, which rejects a path the viewer could not run.

const DATAPOINT = CONTEXTS.datapoint;
/** Per-point fields: a series has no single value for them, so `where`/`by` reject them. */
const PER_POINT_PATHS: ReadonlyMap<string, string> = new Map([
  ['time_unix_nano', 'time filters use the time range'],
  ['start_time_unix_nano', 'time filters use the time range'],
  ['flags', 'flags is a per-point field; metric filters select whole series'],
]);
const IDENTITY_ROOTS = new Set(['attributes', 'resource', 'instrumentation_scope']);

type PathValue = Extract<Value, { type: 'path' }>;

function canonical(p: PathValue): string[] {
  return p.segments.length > 1 && p.segments[0] === DATAPOINT.prefix ? p.segments.slice(1) : [...p.segments];
}

export function pathsOf(e: Expr): PathValue[] {
  const out: PathValue[] = [];
  const exprs: Expr[] = [e];
  const values: Value[] = [];
  for (let x = exprs.pop(); x !== undefined; x = exprs.pop()) {
    switch (x.type) {
      case 'and':
      case 'or':
        exprs.push(x.left, x.right);
        break;
      case 'not':
        exprs.push(x.expr);
        break;
      case 'cmp':
        values.push(x.left, x.right);
        break;
      case 'value':
        values.push(x.value);
        break;
    }
  }
  for (let v = values.pop(); v !== undefined; v = values.pop()) {
    if (v.type === 'path') out.push(v);
    else if (v.type === 'call') values.push(...v.args);
    else if (v.type === 'math') values.push(v.left, v.right);
  }
  return out;
}

export function rejectPerPointPaths(paths: readonly PathValue[]): void {
  for (const p of paths) {
    const why = PER_POINT_PATHS.get(canonical(p).join('.'));
    if (why !== undefined) throw new OtelHtmlError('invalid-ottl', { message: `col ${p.from + 1}: ${why}` });
  }
}

/** Whether any path reads a series' identity (attributes, resource, scope), which `other` cannot answer. */
export const readsIdentity = (paths: readonly PathValue[]): boolean =>
  paths.some((p) => IDENTITY_ROOTS.has(canonical(p)[0] ?? ''));

export interface CompiledBy {
  src: string;
  accessor: PathAccessor<DatapointTarget>;
  keys: readonly (string | number)[];
  identity: boolean;
}

export function compileBy(src: string): CompiledBy {
  const e = parseCondition(src);
  const v = e.type === 'value' ? e.value : null;
  if (v === null || v.type !== 'path')
    throw new OtelHtmlError('invalid-ottl', {
      path: `by ${JSON.stringify(src)}`,
      expected: 'a datapoint path',
    });
  rejectPerPointPaths([v]);
  const accessor = DATAPOINT.paths.get(canonical(v).join('.'));
  if (accessor === undefined)
    throw new OtelHtmlError('invalid-ottl', {
      path: `by ${JSON.stringify(src)}`,
      expected: 'a datapoint path',
      actual: JSON.stringify(v.segments.join('.')),
    });
  return { src, accessor, keys: v.keys, identity: readsIdentity([v]) };
}
