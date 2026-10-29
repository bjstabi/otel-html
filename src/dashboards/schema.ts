import { z } from 'zod';
import { OtelHtmlError } from '../model/errors.js';
import { compileCondition } from '../ottl/compile.js';
import type { OttlContextName } from '../ottl/contexts.js';
import { formulaRefs, parseFormula } from '../query/metric-formula.js';
import {
  MAX_METRIC_QUERIES,
  type MetricFormula,
  MetricFormulaSchema,
  type MetricPageState,
  MetricPageStateSchema,
  type MetricQuery,
  type MetricQueryInput,
  MetricQuerySchema,
} from '../query/metric-query.js';
import { PAGE_OPTIONS } from '../query/pages.js';

// Explicit input/output interfaces keep `isolatedDeclarations` satisfied, as in config/schema.ts.
// The output is what the viewer reads; the input also accepts the output, so a resolved dashboard
// in the report manifest re-validates with the same schema (idempotence).

export type WidgetType = 'timeline' | 'traces' | 'logs' | 'metric' | 'toplist' | 'table';

export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WidgetBase extends WidgetLayout {
  id: string;
  title: string | null;
}
interface Followable extends WidgetBase {
  follow: boolean;
}
export type Widget =
  | (WidgetBase & { type: 'timeline' })
  | (Followable & { type: 'traces'; query: string | null; text: string; mode: 'traces' | 'spans' })
  | (Followable & { type: 'logs'; query: string | null; text: string; context: boolean })
  | (Followable & {
      type: 'metric';
      queries: MetricQuery[] | null;
      formulas: MetricFormula[];
      display: 'lines' | 'area' | 'bars' | 'heatmap';
      scale: 'linear' | 'log';
      exemplars: boolean;
      echarts: Record<string, unknown> | null;
    })
  | (Followable & {
      type: 'toplist';
      signal: 'spans' | 'logs';
      query: string | null;
      text: string;
      groupBy: string;
      echarts: Record<string, unknown> | null;
    })
  | (Followable & {
      type: 'table';
      signal: 'spans' | 'logs';
      query: string | null;
      text: string;
      groupBy: string;
    });

export interface Variable {
  key: string;
  label: string;
  default: string | null;
}

export interface Dashboard {
  id: string;
  title: string;
  description: string;
  variables: Variable[];
  widgets: Widget[];
}

export interface View {
  id: string;
  title: string;
  page: 'traces' | 'logs' | 'metrics';
  query: string | null;
  text: string;
  mode: string | null;
  groupBy: string | null;
  view: string | null;
  sort: string | null;
  metrics: MetricPageState | null;
}

interface WidgetBaseInput extends WidgetLayout {
  id?: string | undefined;
  title?: string | null | undefined;
}
interface FollowableInput extends WidgetBaseInput {
  follow?: boolean | undefined;
}
// The metric query, formula and page-state schemas are `z.ZodType<Out>` (input `unknown`), so their inputs are too.

/** The input type of one widget. */
export type WidgetInput =
  | (WidgetBaseInput & { type: 'timeline' })
  | (FollowableInput & {
      type: 'traces';
      query?: string | null | undefined;
      text?: string | undefined;
      mode?: 'traces' | 'spans' | undefined;
    })
  | (FollowableInput & {
      type: 'logs';
      query?: string | null | undefined;
      text?: string | undefined;
      context?: boolean | undefined;
    })
  | (FollowableInput & {
      type: 'metric';
      queries?: MetricQueryInput[] | null | undefined;
      formulas?: unknown[] | undefined;
      display?: 'lines' | 'area' | 'bars' | 'heatmap' | undefined;
      scale?: 'linear' | 'log' | undefined;
      exemplars?: boolean | undefined;
      echarts?: Record<string, unknown> | null | undefined;
    })
  | (FollowableInput & {
      type: 'toplist';
      signal: 'spans' | 'logs';
      query?: string | null | undefined;
      text?: string | undefined;
      groupBy: string;
      echarts?: Record<string, unknown> | null | undefined;
    })
  | (FollowableInput & {
      type: 'table';
      signal: 'spans' | 'logs';
      query?: string | null | undefined;
      text?: string | undefined;
      groupBy: string;
    });

export type VariableInput =
  | string
  | { key: string; label?: string | undefined; default?: string | null | undefined };

export interface DashboardInput {
  id: string;
  title: string;
  description?: string | undefined;
  variables?: VariableInput[] | undefined;
  widgets: WidgetInput[];
}

export interface ViewInput {
  id: string;
  title: string;
  page: 'traces' | 'logs' | 'metrics';
  query?: string | null | undefined;
  text?: string | undefined;
  mode?: string | null | undefined;
  groupBy?: string | null | undefined;
  view?: string | null | undefined;
  sort?: string | null | undefined;
  metrics?: unknown;
}

export const RESERVED_DASHBOARD_IDS: readonly ['fusion'] = ['fusion'];

const MAX_VARIABLES = 8;
const MAX_WIDGETS = 50;
/** The grid's width in columns, and the size bounds a widget layout must keep (the viewer's edit mode shares them). */
export const GRID_COLUMNS = 12;
export const WIDGET_MIN_W = 1;
export const WIDGET_MIN_H = 2;
export const WIDGET_MAX_H = 40;

const CONTEXT_NOUN: Record<OttlContextName, string> = {
  span: 'spans',
  log_record: 'log records',
  datapoint: 'data points',
};

/** A message when `src` does not compile in `context`, else null. Only OTTL failures are caught. */
function conditionIssue(src: string, context: OttlContextName): string | null {
  try {
    compileCondition(src, context);
    return null;
  } catch (e) {
    if (!(e instanceof OtelHtmlError && e.code === 'invalid-ottl')) throw e;
    return `an OTTL condition valid for ${CONTEXT_NOUN[context]} (${e.message})`;
  }
}

const dashboardId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'an id of lowercase letters, digits and dashes');
const widgetId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'an id starting with a lowercase letter');
const nullableString = z.string().nullable().default(null);
const echarts = z.record(z.string(), z.unknown()).nullable().default(null).meta({
  description: "Unstable: passed through to ECharts as is; compatibility is ECharts', not otel-html's.",
});

const layout = {
  id: widgetId.optional(),
  title: nullableString,
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(WIDGET_MIN_W),
  h: z.number().int().min(WIDGET_MIN_H).max(WIDGET_MAX_H),
};
const follow = { follow: z.boolean().default(true) };
const signalBase = {
  ...layout,
  ...follow,
  query: nullableString,
  text: z.string().default(''),
};

const MetricWidgetQuerySchema: z.ZodType<MetricQuery, MetricQueryInput> = MetricQuerySchema.superRefine(
  (q, ctx) => {
    if (q.metric === '') ctx.addIssue({ code: 'custom', path: ['metric'], message: 'a metric name' });
    if (q.show === '') ctx.addIssue({ code: 'custom', path: ['show'], message: 'a field to show' });
  },
);

const WidgetSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('timeline'), ...layout }),
    z.strictObject({
      type: z.literal('traces'),
      ...signalBase,
      mode: z.enum(['traces', 'spans']).default('traces'),
    }),
    z.strictObject({ type: z.literal('logs'), ...signalBase, context: z.boolean().default(false) }),
    z.strictObject({
      type: z.literal('metric'),
      ...layout,
      ...follow,
      queries: z.array(MetricWidgetQuerySchema).min(1).max(MAX_METRIC_QUERIES).nullable().default(null),
      formulas: z.array(MetricFormulaSchema).default([]),
      display: z.enum(['lines', 'area', 'bars', 'heatmap']).default('lines'),
      scale: z.enum(['linear', 'log']).default('linear'),
      exemplars: z.boolean().default(true),
      echarts,
    }),
    z.strictObject({
      type: z.literal('toplist'),
      ...signalBase,
      signal: z.enum(['spans', 'logs']),
      groupBy: z.string().min(1),
      echarts,
    }),
    z.strictObject({
      type: z.literal('table'),
      ...signalBase,
      signal: z.enum(['spans', 'logs']),
      groupBy: z.string().min(1),
    }),
  ])
  .superRefine((w, ctx) => {
    if (w.x + w.w > GRID_COLUMNS) {
      ctx.addIssue({ code: 'custom', path: ['x'], message: `x + w at most ${GRID_COLUMNS}` });
    }
    const context: OttlContextName | null =
      w.type === 'traces'
        ? 'span'
        : w.type === 'logs'
          ? 'log_record'
          : w.type === 'toplist' || w.type === 'table'
            ? w.signal === 'spans'
              ? 'span'
              : 'log_record'
            : null;
    if (context !== null && 'query' in w && w.query !== null) {
      const message = conditionIssue(w.query, context);
      if (message !== null) ctx.addIssue({ code: 'custom', path: ['query'], message });
    }
    if (w.type !== 'metric') return;
    if (w.queries === null) {
      if (w.formulas.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['formulas'], message: 'formulas only together with queries' });
      }
      return;
    }
    const ids = w.queries.map((q) => q.id);
    ids.forEach((id, i) => {
      if (ids.indexOf(id) !== i)
        ctx.addIssue({ code: 'custom', path: ['queries', i, 'id'], message: 'unique query ids' });
    });
    w.formulas.forEach((f, i) => {
      try {
        for (const ref of formulaRefs(parseFormula(f.expr))) {
          if (!ids.includes(ref)) {
            ctx.addIssue({
              code: 'custom',
              path: ['formulas', i, 'expr'],
              message: `only existing query ids (${ref} is not one of ${ids.join(', ')})`,
            });
          }
        }
      } catch (e) {
        if (!(e instanceof OtelHtmlError)) throw e;
        ctx.addIssue({ code: 'custom', path: ['formulas', i, 'expr'], message: e.message });
      }
    });
  });

const VariableSchema = z
  .union([
    z.string().min(1),
    z.strictObject({
      key: z.string().min(1),
      label: z.string().optional(),
      default: z.string().nullable().default(null),
    }),
  ])
  .transform(
    (v): Variable =>
      typeof v === 'string' ? { key: v, label: v, default: null } : { ...v, label: v.label ?? v.key },
  );

function overlaps(a: WidgetLayout, b: WidgetLayout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export const DashboardSchema: z.ZodType<Dashboard, DashboardInput> = z
  .strictObject({
    id: dashboardId,
    title: z.string().min(1),
    description: z.string().default(''),
    variables: z.array(VariableSchema).max(MAX_VARIABLES, `at most ${MAX_VARIABLES} variables`).default([]),
    widgets: z.array(WidgetSchema).min(1).max(MAX_WIDGETS, `at most ${MAX_WIDGETS} widgets`),
  })
  .transform((d, ctx): Dashboard => {
    const widgets = d.widgets.map((w, i): Widget => ({ ...w, id: w.id ?? `w${i + 1}` }));
    d.variables.forEach((v, i) => {
      if (d.variables.findIndex((o) => o.key === v.key) !== i) {
        ctx.issues.push({
          code: 'custom',
          input: v,
          path: ['variables', i, 'key'],
          message: 'unique variable keys',
        });
      }
    });
    widgets.forEach((w, j) => {
      if (widgets.findIndex((o) => o.id === w.id) !== j) {
        ctx.issues.push({
          code: 'custom',
          input: w,
          path: ['widgets', j, 'id'],
          message: 'unique widget ids',
        });
      }
      const i = widgets.findIndex((o, k) => k < j && overlaps(o, w));
      const other = widgets[i];
      if (other !== undefined) {
        ctx.issues.push({
          code: 'custom',
          input: w,
          path: ['widgets', j],
          message: `does not overlap widgets[${i}] (${other.id})`,
        });
      }
    });
    return { ...d, widgets };
  });

/** Flag repeated and reserved ids; `pathOf` places each issue (the list's `[i, 'id']` by default). */
export function listIssues(
  ids: readonly string[],
  reserved: readonly string[],
  ctx: z.RefinementCtx<unknown>,
  pathOf: (i: number) => PropertyKey[] = (i) => [i, 'id'],
): void {
  ids.forEach((id, i) => {
    if (ids.indexOf(id) !== i) ctx.addIssue({ code: 'custom', path: pathOf(i), message: 'unique ids' });
    if (reserved.includes(id))
      ctx.addIssue({ code: 'custom', path: pathOf(i), message: `"${id}" is reserved` });
  });
}

export const DashboardListSchema: z.ZodType<Dashboard[], DashboardInput[]> = z
  .array(DashboardSchema)
  .superRefine((ds, ctx) =>
    listIssues(
      ds.map((d) => d.id),
      RESERVED_DASHBOARD_IDS,
      ctx,
    ),
  );

const nullableText = z.string().nullable().default(null);

export const ViewSchema: z.ZodType<View, ViewInput> = z
  .strictObject({
    id: dashboardId,
    title: z.string().min(1),
    page: z.enum(['traces', 'logs', 'metrics']),
    query: nullableText,
    text: z.string().default(''),
    mode: nullableText,
    groupBy: nullableText,
    view: nullableText,
    sort: nullableText,
    metrics: MetricPageStateSchema.nullable().default(null),
  })
  .superRefine((v, ctx) => {
    const opts = PAGE_OPTIONS[v.page];
    const bad = (path: string, message: string): void =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const modes: readonly string[] = opts.modes;
    const views: readonly string[] = opts.views;
    if (v.mode !== null && !modes.includes(v.mode)) {
      bad('mode', modes.length === 0 ? 'not offered on this page' : `one of ${modes.join(', ')}`);
    }
    if (v.view !== null && !views.includes(v.view)) {
      bad('view', views.length === 0 ? 'not offered on this page' : `one of ${views.join(', ')}`);
    }
    if (v.page === 'metrics') {
      if (v.query !== null) bad('query', 'not offered on this page');
      if (v.text !== '') bad('text', 'not offered on this page');
    } else {
      if (v.metrics !== null) bad('metrics', 'only on the metrics page');
      if (v.query !== null) {
        const message = conditionIssue(v.query, opts.context);
        if (message !== null) bad('query', message);
      }
    }
  });

export const ViewListSchema: z.ZodType<View[], ViewInput[]> = z.array(ViewSchema).superRefine((vs, ctx) =>
  listIssues(
    vs.map((v) => v.id),
    [],
    ctx,
  ),
);
