import { useCallback, useMemo, useRef } from 'react';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import type { DataSource } from '../data/data-source.js';
import { evaluateFormula, formulaRefs, formulaWidth, parseFormula } from '../data/metric-formula.js';
import type { LoadedMetric } from '../data/metric-load.js';
import {
  type MetricQuery,
  type MetricQueryResult,
  resolveMetric,
  runMetricQuery,
  runMetricQueryAtWidth,
  showOptions,
} from '../data/metric-query.js';
import type { TimeWindow } from '../data/span-query.js';
import type { MetricFormula, MetricPageState } from '../state/metric-state.js';
import { useKeyedAsync } from '../state/use-keyed-async.js';

/** Buckets per chart when the card has not been measured (no layout, as in tests). */
export const DEFAULT_MAX_POINTS = 600;
const MIN_POINTS = 60;
const MAX_POINTS = 2000;

/** About one bucket per pixel of card width. */
export function maxPointsFor(widthPx: number | null): number {
  if (widthPx === null || !Number.isFinite(widthPx) || widthPx <= 0) return DEFAULT_MAX_POINTS;
  return Math.min(MAX_POINTS, Math.max(MIN_POINTS, Math.round(widthPx)));
}

export interface MetricQueries {
  /** Per query and formula id. */
  results: Map<string, MetricQueryResult>;
  /** Per query and formula id: why it has no result (unknown or ambiguous metric, bad formula...). */
  errors: Map<string, string>;
  /** Per query id: the catalog entry it resolved to. */
  entries: Map<string, MetricEntry>;
  /** Per query id: every `show` its metric offers (summary quantiles come from the data). */
  showOptions: Map<string, readonly string[]>;
  /** True while a run is in flight; the previous results stay until it lands. */
  loading: boolean;
  /** A failure of the whole run (the catalog did not load). */
  failure: string | null;
}

interface Input {
  queries: MetricQuery[];
  formulas: MetricFormula[];
  window: TimeWindow;
  maxPoints: number;
}

type Outcome = Omit<MetricQueries, 'loading' | 'failure'>;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function definitionText(q: MetricQuery): string {
  const parts = [q.kind, q.unit === null ? null : `unit ${JSON.stringify(q.unit)}`].filter((p) => p !== null);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

async function run(ds: DataSource, input: Input, signal: AbortSignal): Promise<Outcome> {
  const out: Outcome = { results: new Map(), errors: new Map(), entries: new Map(), showOptions: new Map() };
  const catalog = await ds.metricCatalog();
  const loaded = new Map<string, { m: LoadedMetric; q: MetricQuery }>();
  for (const q of input.queries) {
    signal.throwIfAborted();
    // A pending query (no metric chosen yet) waits for the Explorer to fill it.
    if (q.metric === '') continue;
    const r = resolveMetric(catalog, q);
    if ('missing' in r) {
      out.errors.set(q.id, `no metric named ${q.metric}${definitionText(q)} in this report`);
      continue;
    }
    if ('ambiguous' in r) {
      out.errors.set(q.id, `${q.metric} has ${r.ambiguous.length} definitions: choose one`);
      continue;
    }
    out.entries.set(q.id, r.entry);
    try {
      const m = await ds.metric(r.entry.id);
      signal.throwIfAborted();
      out.showOptions.set(q.id, showOptions(m));
      out.results.set(q.id, runMetricQuery(m, q, input.window, input.maxPoints, signal));
      loaded.set(q.id, { m, q });
    } catch (e) {
      signal.throwIfAborted();
      out.errors.set(q.id, message(e));
    }
  }
  for (const f of input.formulas) {
    signal.throwIfAborted();
    try {
      const ast = parseFormula(f.expr);
      const refs = formulaRefs(ast);
      const missing = refs.find((id) => !loaded.has(id));
      if (missing !== undefined) {
        out.errors.set(f.id, `${f.id} reads query ${missing}, which has no result`);
        continue;
      }
      // Operands must share one bucket width: re-run the finer ones at the coarsest.
      const width = formulaWidth(ast, out.results);
      const operands = new Map<string, MetricQueryResult>();
      for (const id of refs) {
        const r = out.results.get(id);
        const l = loaded.get(id);
        if (r === undefined || l === undefined) continue;
        operands.set(
          id,
          r.widthNs === width ? r : runMetricQueryAtWidth(l.m, l.q, input.window, width, signal),
        );
      }
      out.results.set(f.id, evaluateFormula(ast, operands, f.id));
    } catch (e) {
      signal.throwIfAborted();
      out.errors.set(f.id, message(e));
    }
  }
  return out;
}

const EMPTY: Outcome = { results: new Map(), errors: new Map(), entries: new Map(), showOptions: new Map() };

/**
 * Runs the page's queries and formulas over `window`. Keyed on what changes the numbers (not display, scale,
 * split, alias or hide), so a stale run is aborted and never shown; while a run is in flight the previous results stay.
 * `widthPx` is the chart card's width, which sets the bucket count (`DEFAULT_MAX_POINTS` until measured).
 */
export function useMetricQueries(
  dataSource: DataSource,
  state: MetricPageState,
  window: TimeWindow,
  widthPx: number | null = null,
): MetricQueries {
  const maxPoints = maxPointsFor(widthPx);
  // Alias and hide change only labels and what is drawn, so they do not re-run anything: the engine labels
  // series by metric name and the Explorer relabels them.
  const queries = state.queries.map((q) => ({ ...q, alias: null, hidden: false }));
  const formulas = state.formulas.map((f) => ({ ...f, alias: null, hidden: false }));
  const keyText = JSON.stringify({ q: queries, f: formulas, w: window, p: maxPoints });
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the serialized input, so equal input keeps one key
  const key = useMemo<Input>(() => ({ queries, formulas, window, maxPoints }), [keyText]);
  const load = useCallback(
    (input: Input, signal: AbortSignal) => run(dataSource, input, signal),
    [dataSource],
  );
  const keyed = useKeyedAsync(key, load);
  const last = useRef<Outcome>(EMPTY);
  if (keyed.status === 'ready') last.current = keyed.value;
  const shown = keyed.status === 'error' ? EMPTY : last.current;
  return {
    ...shown,
    loading: keyed.status === 'loading',
    failure: keyed.status === 'error' ? keyed.message : null,
  };
}
