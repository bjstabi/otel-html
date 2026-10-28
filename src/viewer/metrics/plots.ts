import { formulaRefs, parseFormula } from '../../query/metric-formula.js';
import type { MetricFormula, MetricPageState } from '../../query/metric-query.js';
import { kindOf, type MetricQuery, type MetricQueryResult } from '../data/metric-query.js';
import type { MetricQueries } from './use-metric-query.js';

/**
 * One charted query or formula. The engine labels an ungrouped series by its metric name (`useMetricQueries` runs
 * without aliases); here every series is labelled by its query (`a · p99`, or the alias) so queries on one metric
 * differ.
 */
export interface Plot {
  id: string;
  title: string;
  result: MetricQueryResult;
  histogram: boolean;
}

export const queryPrefix = (q: MetricQuery): string => q.alias ?? `${q.id} · ${q.show}`;
export const formulaPrefix = (f: MetricFormula): string => f.alias ?? `${f.id} · ${f.expr}`;

function relabel(r: MetricQueryResult, prefix: string, bases: ReadonlySet<string>): MetricQueryResult {
  return {
    ...r,
    series: r.series.map((s) => ({ ...s, label: bases.has(s.label) ? prefix : `${prefix} · ${s.label}` })),
  };
}

/** The metric names a formula's ungrouped series may carry as labels (its operands'). */
function formulaBases(f: MetricFormula, queries: readonly MetricQuery[]): Set<string> {
  let refs: string[] = [];
  try {
    refs = formulaRefs(parseFormula(f.expr));
  } catch {
    // A formula that does not parse has no result to label.
  }
  return new Set(queries.filter((q) => refs.includes(q.id)).map((q) => q.metric));
}

/** The visible queries and formulas that have a result, in row order. */
export function buildPlots(state: MetricPageState, run: Pick<MetricQueries, 'results' | 'entries'>): Plot[] {
  const out: Plot[] = [];
  for (const q of state.queries) {
    const r = run.results.get(q.id);
    if (q.hidden || r === undefined) continue;
    const e = run.entries.get(q.id);
    const kind = e === undefined ? null : kindOf(e);
    out.push({
      id: q.id,
      title: q.alias ?? `${q.metric} · ${q.show}`,
      result: relabel(r, queryPrefix(q), new Set([q.metric])),
      histogram: kind === 'hist' || kind === 'exp',
    });
  }
  for (const f of state.formulas) {
    const r = run.results.get(f.id);
    if (f.hidden || r === undefined) continue;
    out.push({
      id: f.id,
      title: f.alias ?? f.expr,
      result: relabel(r, formulaPrefix(f), formulaBases(f, state.queries)),
      histogram: false,
    });
  }
  return out;
}

/** Built from bucket counts, so only a histogram query can draw them. */
const HISTOGRAM_DISPLAYS: ReadonlySet<MetricPageState['display']> = new Set(['heatmap', 'distribution']);

export interface ChartLayout {
  /** The display drawn: Lines when the stored one needs a histogram and none is visible. */
  display: MetricPageState['display'];
  histogramDisplay: boolean;
  mixedUnits: boolean;
  histogramVisible: boolean;
  /** The plots of each chart card. */
  cards: Plot[][];
}

/**
 * One chart for every plot, or one per plot when split. A heatmap or distribution is one histogram per chart
 * (the other plots draw lines), and plots with different units never share a y-axis (spec §6.2).
 */
export function layoutCharts(plots: Plot[], state: MetricPageState): ChartLayout {
  const units = new Set(plots.flatMap((p) => p.result.series.map((s) => s.unit)));
  const mixedUnits = units.size > 1;
  const histogramVisible = plots.some((p) => p.histogram);
  const display = HISTOGRAM_DISPLAYS.has(state.display) && !histogramVisible ? 'lines' : state.display;
  const histogramDisplay = HISTOGRAM_DISPLAYS.has(display);
  const split = state.split || mixedUnits || histogramDisplay;
  const cards = split ? plots.map((p) => [p]) : plots.length === 0 ? [] : [plots];
  return { display, histogramDisplay, mixedUnits, histogramVisible, cards };
}
