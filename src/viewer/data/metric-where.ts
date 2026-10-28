import { OtelHtmlError } from '../../model/errors.js';
import type { UnixNanos } from '../../model/ids.js';
import type {
  MetricPointRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
} from '../../model/records.js';
import type { Expr, Value } from '../../ottl/ast.js';
import { type CompiledCondition, compileCondition } from '../../ottl/compile.js';
import { CONTEXTS, type DatapointTarget, type OttlValue, type PathAccessor } from '../../ottl/contexts.js';
import { parseCondition } from '../../ottl/parse.js';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import type { LoadedSeries } from './metric-load.js';

// A query's `where` and `by`, evaluated per series (never per point).

const DATAPOINT = CONTEXTS.datapoint;
const TIME_PATHS = new Set(['time_unix_nano', 'start_time_unix_nano']);
const IDENTITY_ROOTS = new Set(['attributes', 'resource', 'instrumentation_scope']);

type PathValue = Extract<Value, { type: 'path' }>;

function canonical(p: PathValue): string[] {
  return p.segments.length > 1 && p.segments[0] === DATAPOINT.prefix ? p.segments.slice(1) : [...p.segments];
}

function pathsOf(e: Expr): PathValue[] {
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

function rejectTimePaths(paths: readonly PathValue[]): void {
  const time = paths.find((p) => TIME_PATHS.has(canonical(p).join('.')));
  if (time !== undefined)
    throw new OtelHtmlError('invalid-ottl', {
      message: `col ${time.from + 1}: time filters use the time range`,
    });
}

/** Whether any path reads a series' identity (attributes, resource, scope), which `other` cannot answer. */
const readsIdentity = (paths: readonly PathValue[]): boolean =>
  paths.some((p) => IDENTITY_ROOTS.has(canonical(p)[0] ?? ''));

interface CompiledBy {
  src: string;
  accessor: PathAccessor<DatapointTarget>;
  keys: readonly (string | number)[];
  identity: boolean;
}

function compileBy(src: string): CompiledBy {
  const e = parseCondition(src);
  const v = e.type === 'value' ? e.value : null;
  if (v === null || v.type !== 'path')
    throw new OtelHtmlError('invalid-ottl', {
      path: `by ${JSON.stringify(src)}`,
      expected: 'a datapoint path',
    });
  rejectTimePaths([v]);
  const accessor = DATAPOINT.paths.get(canonical(v).join('.'));
  if (accessor === undefined)
    throw new OtelHtmlError('invalid-ottl', {
      path: `by ${JSON.stringify(src)}`,
      expected: 'a datapoint path',
      actual: JSON.stringify(v.segments.join('.')),
    });
  return { src, accessor, keys: v.keys, identity: readsIdentity([v]) };
}

function display(v: OttlValue): string {
  if (v === null) return '(none)';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v instanceof Uint8Array) return [...v].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (v instanceof Map) return `{${[...v].map(([k, x]) => `${k}: ${display(x)}`).join(', ')}}`;
  return `[${[...v.values()].map(display).join(', ')}]`;
}

const EMPTY_RESOURCE: ResourceRecord = { attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' };
const EMPTY_SCOPE: ScopeRecord = {
  name: '',
  version: '',
  attributes: new Map(),
  droppedAttributesCount: 0,
  schemaUrl: '',
};

/** A per-series target: the series' identity with no point values (where/by never read times or values). */
export function targetOf(e: MetricEntry, s: LoadedSeries): DatapointTarget {
  return {
    resource: s.resource ?? EMPTY_RESOURCE,
    scope: s.scope ?? EMPTY_SCOPE,
    epoch: 0n as UnixNanos,
    point: {
      name: e.name,
      description: e.description,
      unit: e.unit,
      type: e.type,
      temporality: e.temporality,
      monotonic: e.monotonic,
      start: null,
      time: 0 as MetricPointRecord['time'],
      attributes: s.def.attributes,
      flags: 0,
      point: null,
      resource: s.def.resource as ResourceRef,
      scope: s.def.scope as ScopeRef,
    },
  };
}

export interface SeriesSelector {
  /** Null when the query has no `where`. */
  test: ((t: DatapointTarget) => boolean) | null;
  /** The `by` paths, in query order. */
  by: readonly string[];
  /** The `by` values of a series, displayed. */
  groupOf(t: DatapointTarget): string[];
  /** Whether `where` or `by` reads series identity (attributes, resource, scope), which `other` cannot answer. */
  readsIdentity: boolean;
}

/** Compiles `where` (datapoint context, no time paths) and `by` (datapoint paths) once per query. */
export function compileSelector(where: string | null, by: readonly string[]): SeriesSelector {
  let cond: CompiledCondition<'datapoint'> | null = null;
  let identity = false;
  if (where !== null && where.trim() !== '') {
    const paths = pathsOf(parseCondition(where));
    rejectTimePaths(paths);
    cond = compileCondition(where, 'datapoint');
    identity = readsIdentity(paths);
  }
  const compiled = by.map(compileBy);
  return {
    test: cond === null ? null : (t) => cond.test(t),
    by,
    groupOf: (t) => compiled.map((b) => display(b.accessor.get(t, b.keys))),
    readsIdentity: identity || compiled.some((b) => b.identity),
  };
}
