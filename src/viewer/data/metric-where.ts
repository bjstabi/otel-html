import type { UnixNanos } from '../../model/ids.js';
import type {
  MetricPointRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
} from '../../model/records.js';
import { type CompiledCondition, compileCondition } from '../../ottl/compile.js';
import type { DatapointTarget, OttlValue } from '../../ottl/contexts.js';
import { parseCondition } from '../../ottl/parse.js';
import { compileBy, pathsOf, readsIdentity, rejectPerPointPaths } from '../../query/metric-paths.js';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import type { LoadedSeries } from './metric-load.js';

// A query's `where` and `by`, evaluated per series (never per point).

function display(v: OttlValue): string {
  if (v === null) return '(none)';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v instanceof Uint8Array) return [...v].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (v instanceof Map) return `{${[...v].map(([k, x]) => `${k}: ${display(x)}`).join(', ')}}`;
  return `[${[...v.values()].map(display).join(', ')}]`;
}

/** A type-tagged form of a value for group keys: int 1 and string "1" stay apart. */
function typed(v: OttlValue): unknown {
  if (v === null) return ['nil'];
  if (typeof v === 'string') return ['s', v];
  if (typeof v === 'bigint') return ['i', v.toString()];
  if (typeof v === 'number') return ['d', String(v)];
  if (typeof v === 'boolean') return ['b', v];
  if (v instanceof Uint8Array) return ['y', display(v)];
  if (v instanceof Map) return ['m', [...v].map(([k, x]) => [k, typed(x)])];
  return ['a', [...v.values()].map(typed)];
}

/** The `other` series' value for every `by` path; no real value encodes to it. */
const OTHER_VALUE = ['other'];

export interface SeriesGroup {
  /** Identity of the group: the `by` paths with their type-tagged values. */
  key: string;
  /** The values as displayed, in `by` order. */
  shown: string[];
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
  /** The group of a series; `null` is the folded `other` series. */
  groupOf(t: DatapointTarget | null): SeriesGroup;
  /** Whether `where` or `by` reads series identity (attributes, resource, scope), which `other` cannot answer. */
  readsIdentity: boolean;
}

/** Compiles `where` (datapoint context, no time paths) and `by` (datapoint paths) once per query. */
export function compileSelector(where: string | null, by: readonly string[]): SeriesSelector {
  let cond: CompiledCondition<'datapoint'> | null = null;
  let identity = false;
  if (where !== null && where.trim() !== '') {
    const paths = pathsOf(parseCondition(where));
    rejectPerPointPaths(paths);
    cond = compileCondition(where, 'datapoint');
    identity = readsIdentity(paths);
  }
  const compiled = by.map(compileBy);
  return {
    test: cond === null ? null : (t) => cond.test(t),
    by,
    groupOf(t) {
      const values = compiled.map((b) => (t === null ? null : b.accessor.get(t, b.keys)));
      return {
        key: JSON.stringify(
          compiled.map((b, i) => [b.src, t === null ? OTHER_VALUE : typed(values[i] ?? null)]),
        ),
        shown: values.map((v) => (t === null ? 'other' : display(v))),
      };
    },
    readsIdentity: identity || compiled.some((b) => b.identity),
  };
}
