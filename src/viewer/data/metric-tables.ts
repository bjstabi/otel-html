import { assertNever, OtelHtmlError } from '../../model/errors.js';
import type { MetricDef, MetricEntry } from './metric-catalog.js';

/** The metric query engine's domain rules, as data (spec §6.1). */

export type MetricKind = 'counter' | 'number' | 'hist' | 'exp' | 'summary';

export function kindOf(e: MetricDef): MetricKind {
  switch (e.type) {
    case 'gauge':
      return 'number';
    case 'sum':
      return e.monotonic ? 'counter' : 'number';
    case 'histogram':
      return 'hist';
    case 'exponentialHistogram':
      return 'exp';
    case 'summary':
      return 'summary';
    default:
      return assertNever(e.type, 'metric.type');
  }
}

const HIST_SHOW = ['p50', 'p75', 'p90', 'p95', 'p99', 'count', 'sum', 'avg'] as const;

/** Summary quantile options are `q<quantile>` per quantile present (`showOptions`); listed here are the fixed ones. */
export const SHOW_BY_KIND: Record<MetricKind, readonly string[]> = {
  counter: ['rate', 'increase', 'sum'],
  number: ['avg', 'min', 'max', 'last'],
  hist: HIST_SHOW,
  exp: HIST_SHOW,
  summary: ['count', 'sum'],
};

/** `qmax` is the highest quantile present, resolved when the query runs; `defaultShow(m)` gives the concrete `q…`. */
export const SUMMARY_TOP_QUANTILE = 'qmax';

export const DEFAULT_SHOW: Record<MetricKind, string> = {
  counter: 'rate',
  number: 'avg',
  hist: 'p95',
  exp: 'p95',
  summary: SUMMARY_TOP_QUANTILE,
};

/**
 * The `show` a metric opens with: `DEFAULT_SHOW`, except a summary's highest quantile made concrete from its show
 * `options` (`count` when it has none).
 */
export function defaultShowOf(kind: MetricKind, options: readonly string[]): string {
  if (kind !== 'summary') return DEFAULT_SHOW[kind];
  return options.filter((o) => QUANTILE_SHOW.test(o)).at(-1) ?? 'count';
}

export const PERCENTILES: Readonly<Record<string, number>> = {
  p50: 0.5,
  p75: 0.75,
  p90: 0.9,
  p95: 0.95,
  p99: 0.99,
};

export const NOTES = {
  boundsDiffer: 'histogram bounds differ',
  heatBoundsDiffer: 'histogram bounds differ across series: no heatmap or distribution',
  summariesNotCombined: 'summaries are not combined',
  summaryCoarse: 'summary quantiles from the last point per bucket',
  resets: (n: number) => `${n} counter reset${n === 1 ? '' : 's'} in range`,
  residual: (term: string) => `Evaluated in the browser: ${term}`,
  exemplarsCapped: 'exemplars capped: the oldest 5 000 exemplar points are shown',
  noValue: (n: number) => `${n} point${n === 1 ? '' : 's'} had no value`,
  conflicting: (e: Pick<MetricEntry, 'name' | 'type' | 'unit'>) =>
    `${e.name} has conflicting definitions: showing ${e.type}${e.unit === '' ? '' : ` (${e.unit})`}`,
} as const;

const QUANTILE_SHOW = /^q(0(?:\.\d+)?|1(?:\.0+)?)$/;

export function checkShow(kind: MetricKind, show: string): void {
  const ok =
    SHOW_BY_KIND[kind].includes(show) ||
    (kind === 'summary' && (show === SUMMARY_TOP_QUANTILE || QUANTILE_SHOW.test(show)));
  if (!ok) {
    const options = kind === 'summary' ? ['q<quantile>', ...SHOW_BY_KIND.summary] : SHOW_BY_KIND[kind];
    throw new OtelHtmlError('usage', {
      path: 'show',
      expected: `one of ${options.join(', ')}`,
      actual: show,
    });
  }
}

/** The badge a metric definition shows (picker, Catalog): its point type, a monotonic sum told apart. */
type MetricTypeBadge = MetricDef['type'] | 'monotonicSum';

const METRIC_TYPE_LABELS: Record<MetricTypeBadge, string> = {
  histogram: 'HIST',
  exponentialHistogram: 'EXP HIST',
  sum: 'SUM',
  monotonicSum: 'SUM · monotonic',
  gauge: 'GAUGE',
  summary: 'SUMMARY',
};

export function metricTypeLabel(d: Pick<MetricDef, 'type' | 'monotonic'>): string {
  return METRIC_TYPE_LABELS[d.type === 'sum' && d.monotonic ? 'monotonicSum' : d.type];
}
