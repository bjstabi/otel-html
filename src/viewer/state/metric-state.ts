import { type MetricPageState, MetricPageStateSchema, type MetricQuery } from '../../query/metric-query.js';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import { DEFAULT_SHOW, kindOf } from '../data/metric-tables.js';
import { paramError, shown } from './param-error.js';

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
  // Every issue, so a hand-edited `m` with several mistakes is fixed in one go.
  return { ok: false, error: r.error.issues.map((issue) => paramError('m', json, issue)).join('; ') };
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
