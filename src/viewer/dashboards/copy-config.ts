import { stringify } from 'yaml';
import type {
  Dashboard,
  Variable,
  Widget,
  WidgetInput,
  WidgetLayout,
  WidgetType,
} from '../../dashboards/schema.js';

/**
 * What the schema fills in when a widget field is left out, per type: Copy config omits a field that equals its
 * default, so the YAML holds only what the author chose (and pastes back into a config unchanged in meaning).
 */
export const WIDGET_DEFAULTS: Record<WidgetType, Readonly<Record<string, unknown>>> = {
  timeline: { title: null },
  traces: { title: null, follow: true, query: null, text: '', mode: 'traces' },
  logs: { title: null, follow: true, query: null, text: '', context: false },
  metric: {
    title: null,
    follow: true,
    queries: null,
    formulas: [],
    display: 'lines',
    scale: 'linear',
    exemplars: true,
    echarts: null,
  },
  toplist: { title: null, follow: true, query: null, text: '', echarts: null },
  table: { title: null, follow: true, query: null, text: '' },
};

/** The grid size (columns × rows) a widget of each type gets when copied out of an explorer. */
export const WIDGET_DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  timeline: { w: 12, h: 6 },
  traces: { w: 7, h: 13 },
  logs: { w: 5, h: 13 },
  metric: { w: 6, h: 8 },
  toplist: { w: 4, h: 8 },
  table: { w: 4, h: 8 },
};

/** Fields written first, in this order, so the YAML reads type, title, position, then the rest. */
const LEAD = ['type', 'id', 'title', 'x', 'y', 'w', 'h'] as const;

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One widget as YAML input: its default id (`w<n>`), nulls and defaulted fields left out. */
function widgetInput(w: Widget, layout: WidgetLayout, index: number): Record<string, unknown> {
  const defaults = WIDGET_DEFAULTS[w.type];
  const { id, ...rest } = w;
  const merged: Record<string, unknown> = { ...rest, ...layout, ...(id === `w${index + 1}` ? {} : { id }) };
  const out: Record<string, unknown> = {};
  const keys = [...LEAD, ...Object.keys(merged).filter((k) => !LEAD.some((l) => l === k))];
  for (const k of keys) {
    if (!Object.hasOwn(merged, k)) continue;
    const v = merged[k];
    if (v === null || v === undefined) continue;
    if (Object.hasOwn(defaults, k) && sameValue(defaults[k], v)) continue;
    out[k] = v;
  }
  return out;
}

function variableInput(v: Variable): string | Record<string, string> {
  if (v.label === v.key && v.default === null) return v.key;
  return {
    key: v.key,
    ...(v.label === v.key ? {} : { label: v.label }),
    ...(v.default === null ? {} : { default: v.default }),
  };
}

/**
 * The dashboard with its current layout as a `dashboards:` YAML document, ready to paste into a config. Fusion is
 * renamed (`fusion-copy`) because its id is reserved. `layout[i]` is the position of `d.widgets[i]`.
 */
export function dashboardToYaml(d: Dashboard, layout: readonly WidgetLayout[]): string {
  const fusion = d.id === 'fusion';
  const input = {
    id: fusion ? 'fusion-copy' : d.id,
    title: fusion ? 'Fusion (copy)' : d.title,
    ...(d.description === '' ? {} : { description: d.description }),
    ...(d.variables.length === 0 ? {} : { variables: d.variables.map(variableInput) }),
    widgets: d.widgets.map((w, i) => widgetInput(w, layout[i] ?? w, i)),
  };
  return stringify({ dashboards: [input] });
}

/** One widget, as pasted under `widgets:` of a dashboard. */
export function widgetToYaml(w: WidgetInput): string {
  return stringify({ widgets: [w] });
}
