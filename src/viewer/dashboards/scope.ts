import { andConditions, traceCondition } from '../../dashboards/conditions.js';
import type { Dashboard, Widget, WidgetType } from '../../dashboards/schema.js';
import type { TraceId } from '../../model/ids.js';
import {
  type FacetSignal,
  type FacetValueKind,
  facetToken,
  tokensToOttl,
} from '../components/filter-tokens.js';
import type { TimeWindow } from '../data/span-query.js';
import type { DashboardPageState } from '../state/dashboard-state.js';

export interface VariableBinding {
  key: string;
  value: string;
  kind: FacetValueKind;
}

/**
 * The variables as one condition: `resource.attributes["k"] == "v"` per binding, typed by the facet's value kind.
 * A data point's resource path is the same text as a span's, so `datapoint` uses the span form.
 */
export function variableCondition(
  bindings: readonly VariableBinding[],
  signal: FacetSignal | 'datapoint',
): string | null {
  const facetSignal: FacetSignal = signal === 'datapoint' ? 'span' : signal;
  return tokensToOttl(bindings.map((b) => facetToken(b.key, 'resource', b.value, '==', b.kind, facetSignal)));
}

export interface WidgetScope {
  window: TimeWindow | null;
  /** The selection drawn as a band or brush instead of narrowing the window. */
  band: TimeWindow | null;
  /** The trace whose records the widget is narrowed to (its condition carries it). */
  traceFilter: TraceId | null;
  /** The trace the widget highlights (rows, exemplars) without narrowing records. */
  highlightTrace: TraceId | null;
  /** The widget's own query, the variables and the trace filter, joined with `and`. */
  condition: string | null;
  /** The selection window does not overlap the page's time range, so it is not applied. */
  outside: boolean;
}

/** Spec §6.2 as data. `window` is what a following widget uses; the timeline is always on. */
export const WIDGET_SCOPE: Record<
  WidgetType,
  { window: 'page' | 'selection'; band: boolean; trace: 'none' | 'filter' | 'highlight' | 'resources' }
> = {
  timeline: { window: 'page', band: true, trace: 'none' },
  traces: { window: 'selection', band: false, trace: 'highlight' },
  logs: { window: 'selection', band: false, trace: 'filter' },
  metric: { window: 'page', band: true, trace: 'resources' },
  toplist: { window: 'selection', band: false, trace: 'filter' },
  table: { window: 'selection', band: false, trace: 'filter' },
};

/** Whether the widget follows the selection: the URL override, else the config. The timeline never does. */
export function following(widget: Widget, state: DashboardPageState): boolean {
  if (widget.type === 'timeline') return false;
  return state.follow[widget.id] ?? widget.follow;
}

/** Each variable's value: the URL's (`null` is all), else the config default; unset and all are left out. */
export function bindings(
  dashboard: Dashboard,
  state: DashboardPageState,
  values: Readonly<Record<string, { kind: FacetValueKind }>>,
): VariableBinding[] {
  return dashboard.variables.flatMap((v) => {
    const value = Object.hasOwn(state.vars, v.key) ? state.vars[v.key] : v.default;
    if (value === null || value === undefined) return [];
    return [{ key: v.key, value, kind: values[v.key]?.kind ?? 'string' }];
  });
}

function intersect(a: TimeWindow | null, b: TimeWindow | null): TimeWindow | null | 'empty' {
  if (a === null) return b;
  if (b === null) return a;
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start > end ? 'empty' : { start, end };
}

function signalOf(widget: Widget): FacetSignal | 'datapoint' {
  switch (widget.type) {
    case 'timeline':
    case 'traces':
      return 'span';
    case 'logs':
      return 'log';
    case 'metric':
      return 'datapoint';
    case 'toplist':
    case 'table':
      return widget.signal === 'logs' ? 'log' : 'span';
  }
}

function ownQuery(widget: Widget): string | null {
  switch (widget.type) {
    case 'traces':
    case 'logs':
    case 'toplist':
    case 'table':
      return widget.query;
    case 'timeline':
    case 'metric':
      return null;
  }
}

/** What a widget queries and draws, from the page range, the selection and the variables (spec §6.2). */
export function scopeFor(
  widget: Widget,
  ctx: {
    page: TimeWindow | null;
    sel: { t: TimeWindow | null; trace: TraceId | null };
    following: boolean;
    vars: readonly VariableBinding[];
  },
): WidgetScope {
  const rule = WIDGET_SCOPE[widget.type];
  const on = widget.type === 'timeline' || ctx.following;
  const own = andConditions(ownQuery(widget), variableCondition(ctx.vars, signalOf(widget)));
  if (!on) {
    return {
      window: ctx.page,
      band: null,
      traceFilter: null,
      highlightTrace: null,
      condition: own,
      outside: false,
    };
  }
  const merged = intersect(ctx.sel.t, ctx.page);
  const outside = merged === 'empty';
  const selected = merged === 'empty' ? null : merged;
  const traceFilter = rule.trace === 'filter' ? ctx.sel.trace : null;
  return {
    window: rule.window === 'selection' && !outside && ctx.sel.t !== null ? selected : ctx.page,
    band: rule.band && !outside ? ctx.sel.t : null,
    traceFilter,
    highlightTrace: rule.trace === 'highlight' || rule.trace === 'resources' ? ctx.sel.trace : null,
    condition: andConditions(own, traceFilter === null ? null : traceCondition(traceFilter)),
    outside,
  };
}
