import type { EChartsOption } from 'echarts';
import type { Measure } from '../../dashboards/schema.js';
import type { FacetCounts } from '../../rollups/facets.js';
import type { GroupDurations } from '../../rollups/span-rollups.js';
import { formatDuration } from '../../semconv/formatters.js';
import { type ColorAssigner, seriesVar } from '../theme/palette.js';

/** Most groups drawn before the rest collapse into one neutral "Other" slice. */
export const MAX_GROUPS = 7;
export const OTHER_LABEL = 'Other';
/** The grouping key used when none is chosen. */
export const DEFAULT_GROUP_KEY = 'service.name';

/** What the facet views read from a signal's query result; spans and logs both carry one. */
export interface FacetSource {
  facets: FacetCounts;
  /** Per-group duration histograms; only a span query asked to `measureBy` a key carries them. */
  groups?: GroupDurations | null;
}

export interface FacetViewContext {
  groupBy: string | null;
  /** What each bar measures; `count` (the default) is the facet count. */
  measure?: Measure;
  colors: ColorAssigner;
}

export interface Slice {
  /** The real facet value (Other for the remainder slice is `other: true`); `name` is display only. */
  key: string;
  name: string;
  value: number;
  other: boolean;
  color: string;
}

/** Top `MAX_GROUPS` values of a facet key plus the exact remainder as "Other"; colours follow the entity. */
export function groupSlices(facets: FacetCounts, key: string, colors: ColorAssigner): Slice[] {
  const top = facets.top(key, MAX_GROUPS);
  const slices: Slice[] = top.map((t) => ({
    key: t.value,
    // A real group literally named "Other" must not collide with the remainder slice.
    name: t.value === OTHER_LABEL ? `${OTHER_LABEL} (value)` : t.value,
    value: t.count,
    other: false,
    color: seriesVar(colors.colorFor(t.value)),
  }));
  const rest = facets.total(key) - top.reduce((a, t) => a + t.count, 0);
  if (rest > 0)
    slices.push({
      key: OTHER_LABEL,
      name: OTHER_LABEL,
      value: rest,
      other: true,
      color: 'var(--oh-series-other)',
    });
  return slices;
}

/** The header of a duration measure's column. */
export const MEASURE_LABELS: Record<Exclude<Measure, 'count'>, string> = {
  'duration.sum': 'Total',
  'duration.avg': 'Average',
  'duration.max': 'Max',
  'duration.p95': 'p95',
  'duration.p99': 'p99',
};

/**
 * One slice per top group, valued by a duration measure of its histogram, largest first. There is no "Other" slice:
 * a remainder has no meaningful maximum or percentile, so it is left out for every measure.
 */
export function measuredSlices(
  groups: GroupDurations,
  facets: FacetCounts,
  key: string,
  measure: Exclude<Measure, 'count'>,
  colors: ColorAssigner,
): Slice[] {
  const slices: Slice[] = [];
  for (const t of facets.top(key, MAX_GROUPS)) {
    const h = groups.get(t.value);
    if (h === undefined) continue;
    let value: number;
    switch (measure) {
      case 'duration.sum':
        value = h.sum;
        break;
      case 'duration.avg':
        value = h.count === 0 ? 0 : h.sum / h.count;
        break;
      case 'duration.max':
        value = h.max;
        break;
      case 'duration.p95':
        value = h.quantile(0.95);
        break;
      case 'duration.p99':
        value = h.quantile(0.99);
        break;
      default: {
        const unreachable: never = measure;
        return unreachable;
      }
    }
    slices.push({
      key: t.value,
      name: t.value === OTHER_LABEL ? `${OTHER_LABEL} (value)` : t.value,
      value,
      other: false,
      color: seriesVar(colors.colorFor(t.value)),
    });
  }
  return slices.sort((a, b) => b.value - a.value);
}

/** The slices a view draws for `measure`: facet counts, or per-group durations when the result carries them. */
export function sliceSet(result: FacetSource, key: string, measure: Measure, colors: ColorAssigner): Slice[] {
  if (measure === 'count' || result.groups == null) return groupSlices(result.facets, key, colors);
  return measuredSlices(result.groups, result.facets, key, measure, colors);
}

function datum(s: Slice): { name: string; value: number; itemStyle: { color: string } } {
  return { name: s.name, value: s.value, itemStyle: { color: s.color } };
}

function slicesOf(result: FacetSource, ctx: FacetViewContext): Slice[] {
  return groupSlices(result.facets, ctx.groupBy ?? DEFAULT_GROUP_KEY, ctx.colors);
}

export function toplist(result: FacetSource, ctx: FacetViewContext): EChartsOption {
  const measure = ctx.measure ?? 'count';
  const slices = sliceSet(result, ctx.groupBy ?? DEFAULT_GROUP_KEY, measure, ctx.colors);
  const timed = measure !== 'count';
  const format = (v: number): string => formatDuration(v);
  return {
    animation: false,
    grid: { left: 120, right: timed ? 56 : 24, top: 8, bottom: 24 },
    tooltip: timed ? { trigger: 'item', valueFormatter: (v) => format(Number(v)) } : { trigger: 'item' },
    xAxis: timed ? { type: 'value', axisLabel: { formatter: format } } : { type: 'value', minInterval: 1 },
    yAxis: { type: 'category', inverse: true, data: slices.map((s) => s.name) },
    series: [
      {
        type: 'bar',
        data: slices.map(datum),
        label: timed
          ? { show: true, position: 'right', formatter: (p) => format(Number(p.value)) }
          : { show: true, position: 'right' },
      },
    ],
  };
}

export function bar(result: FacetSource, ctx: FacetViewContext): EChartsOption {
  const slices = slicesOf(result, ctx);
  return {
    animation: false,
    grid: { left: 48, right: 8, top: 16, bottom: 48 },
    tooltip: { trigger: 'item' },
    xAxis: { type: 'category', data: slices.map((s) => s.name), axisLabel: { interval: 0, rotate: 20 } },
    yAxis: { type: 'value', minInterval: 1 },
    series: [{ type: 'bar', data: slices.map(datum) }],
  };
}

export function pie(result: FacetSource, ctx: FacetViewContext): EChartsOption {
  const slices = slicesOf(result, ctx);
  return {
    animation: false,
    tooltip: { trigger: 'item' },
    legend: { bottom: 0 },
    series: [
      {
        type: 'pie',
        radius: ['40%', '68%'],
        // Slice borders keep adjacent categorical colours distinguishable without relying on hue alone.
        itemStyle: { borderWidth: 2 },
        label: { formatter: '{b}: {c}' },
        data: slices.map(datum),
      },
    ],
  };
}

export function treemap(result: FacetSource, ctx: FacetViewContext): EChartsOption {
  const slices = slicesOf(result, ctx);
  return {
    animation: false,
    tooltip: { trigger: 'item' },
    series: [{ type: 'treemap', roam: false, breadcrumb: { show: false }, data: slices.map(datum) }],
  };
}
