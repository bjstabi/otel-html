import type { EChartsOption } from 'echarts';
import type { FacetCounts } from '../../rollups/facets.js';
import { type ColorAssigner, OTHER_INDEX } from '../theme/palette.js';

/** Most groups drawn before the rest collapse into one neutral "Other" slice. */
export const MAX_GROUPS = 7;
export const OTHER_LABEL = 'Other';
/** The grouping key used when none is chosen. */
export const DEFAULT_GROUP_KEY = 'service.name';

/** What the facet views read from a signal's query result; spans and logs both carry one. */
export interface FacetSource {
  facets: FacetCounts;
}

export interface FacetViewContext {
  groupBy: string | null;
  colors: ColorAssigner;
}

/** Colour references are `var(--oh-*)` strings so the builders stay pure; `resolveCssVars` swaps in the theme. */
function seriesVar(index: number): string {
  return index >= OTHER_INDEX ? 'var(--oh-series-other)' : `var(--oh-series-${index + 1})`;
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
      color: seriesVar(OTHER_INDEX),
    });
  return slices;
}

function datum(s: Slice): { name: string; value: number; itemStyle: { color: string } } {
  return { name: s.name, value: s.value, itemStyle: { color: s.color } };
}

function slicesOf(result: FacetSource, ctx: FacetViewContext): Slice[] {
  return groupSlices(result.facets, ctx.groupBy ?? DEFAULT_GROUP_KEY, ctx.colors);
}

export function toplist(result: FacetSource, ctx: FacetViewContext): EChartsOption {
  const slices = slicesOf(result, ctx);
  return {
    animation: false,
    grid: { left: 120, right: 24, top: 8, bottom: 24 },
    tooltip: { trigger: 'item' },
    xAxis: { type: 'value', minInterval: 1 },
    yAxis: { type: 'category', inverse: true, data: slices.map((s) => s.name) },
    series: [{ type: 'bar', data: slices.map(datum), label: { show: true, position: 'right' } }],
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
