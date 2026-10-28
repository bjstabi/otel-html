import { z } from 'zod';
import { OtelHtmlError } from '../../model/errors.js';
import { compileCondition } from '../../ottl/compile.js';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import type { MetricQuery } from '../data/metric-query.js';
import { DEFAULT_SHOW, kindOf } from '../data/metric-tables.js';

export const MAX_METRIC_QUERIES = 10;

export const METRIC_DISPLAYS = ['lines', 'area', 'bars', 'heatmap', 'distribution'] as const;
export const METRIC_SCALES = ['linear', 'log'] as const;

export interface MetricFormula {
  id: string;
  expr: string;
  alias: string | null;
  hidden: boolean;
}

/** The Metrics page's whole state; it lives in the URL as the single key `m` (JSON). */
export interface MetricPageState {
  queries: MetricQuery[];
  formulas: MetricFormula[];
  display: (typeof METRIC_DISPLAYS)[number];
  scale: (typeof METRIC_SCALES)[number];
  split: boolean;
  exemplars: boolean;
}

const POINT_TYPES = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'] as const;
const positiveInt = z.number().int().positive();

const metricFn = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rate') }),
  z.object({ op: z.literal('increase') }),
  z.object({ op: z.literal('rollup'), agg: z.enum(['avg', 'min', 'max', 'sum']), intervalMs: positiveInt }),
  z.object({ op: z.enum(['top', 'bottom']), n: positiveInt, by: z.enum(['avg', 'max', 'last']) }),
]);

/**
 * Only `id`, `metric` and `show` are required; the rest default so a hand-written URL stays short. An empty
 * `metric` and `show` mean "not chosen yet" (a query seeded by carry-over); the Explorer asks for them.
 */
const metricQuery = z
  .object({
    id: z.string().regex(/^[a-z]$/, 'a query id of one letter a-z'),
    metric: z.string(),
    kind: z.enum(POINT_TYPES).nullable().default(null),
    unit: z.string().nullable().default(null),
    show: z.string(),
    by: z.array(z.string().min(1)).default([]),
    where: z.string().min(1).nullable().default(null),
    fn: z.array(metricFn).default([]),
    alias: z.string().nullable().default(null),
    hidden: z.boolean().default(false),
  })
  .superRefine((q, ctx) => {
    if (q.where === null) return;
    try {
      compileCondition(q.where, 'datapoint');
    } catch (e) {
      if (!(e instanceof OtelHtmlError && e.code === 'invalid-ottl')) throw e;
      ctx.addIssue({
        code: 'custom',
        path: ['where'],
        message: `an OTTL condition valid for data points (${e.message})`,
      });
    }
  });

const metricFormula = z.object({
  id: z.string().regex(/^f[1-9]\d*$/, 'a formula id f1, f2, ...'),
  expr: z.string().min(1),
  alias: z.string().nullable().default(null),
  hidden: z.boolean().default(false),
});

function duplicates(ids: readonly string[]): number[] {
  return ids.flatMap((id, i) => (ids.indexOf(id) === i ? [] : [i]));
}

export const MetricPageStateSchema: z.ZodType<MetricPageState> = z
  .object({
    queries: z.array(metricQuery).max(MAX_METRIC_QUERIES, `at most ${MAX_METRIC_QUERIES} queries`),
    formulas: z.array(metricFormula).default([]),
    display: z.enum(METRIC_DISPLAYS).default('lines'),
    scale: z.enum(METRIC_SCALES).default('linear'),
    split: z.boolean().default(false),
    exemplars: z.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    for (const i of duplicates(s.queries.map((q) => q.id))) {
      ctx.addIssue({ code: 'custom', path: ['queries', i, 'id'], message: 'unique query ids' });
    }
    for (const i of duplicates(s.formulas.map((f) => f.id))) {
      ctx.addIssue({ code: 'custom', path: ['formulas', i, 'id'], message: 'unique formula ids' });
    }
  });

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
