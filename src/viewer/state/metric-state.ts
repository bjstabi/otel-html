import { type MetricPageState, MetricPageStateSchema, type MetricQuery } from '../../query/metric-query.js';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import { DEFAULT_SHOW, kindOf } from '../data/metric-tables.js';

const MAX_ACTUAL = 80;

function pathString(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : `${acc}.${String(p)}`),
    'm',
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

function shown(v: unknown): string {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > MAX_ACTUAL ? `${s.slice(0, MAX_ACTUAL)}...` : s;
}

/** The URL key `m`: JSON text to a state, or one error line naming the offending path (`m.queries[0].where`). */
export function parseMetricParam(
  raw: string,
): { ok: true; state: MetricPageState } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: `m: expected a JSON object, got ${shown(raw)}` };
  }
  const r = MetricPageStateSchema.safeParse(json);
  if (r.success) return { ok: true, state: r.data };
  const issue = r.error.issues[0];
  const path = issue?.path ?? [];
  return {
    ok: false,
    error: `${pathString(path)}: expected ${issue?.message ?? 'a valid value'}, got ${shown(valueAt(json, path))}`,
  };
}

/**
 * One query on the metric (or a pending one for `null`). `show` is the kind's default; a summary keeps the
 * `qmax` placeholder, which the query engine resolves to the highest quantile once the data is loaded.
 */
export function defaultMetricState(entry: MetricEntry | null): MetricPageState {
  const query: MetricQuery = {
    id: 'a',
    metric: entry?.name ?? '',
    kind: null,
    unit: null,
    show: entry === null ? '' : DEFAULT_SHOW[kindOf(entry)],
    by: [],
    where: null,
    fn: [],
    alias: null,
    hidden: false,
  };
  return {
    queries: [query],
    formulas: [],
    display: 'lines',
    scale: 'linear',
    split: false,
    exemplars: false,
  };
}
