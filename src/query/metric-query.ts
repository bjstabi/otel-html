import { z } from 'zod';
import { OtelHtmlError } from '../model/errors.js';
import type { MetricPointRecord } from '../model/records.js';
import { compileCondition } from '../ottl/compile.js';
import { parseFormula } from './metric-formula.js';

/** Whether `expr` parses as a formula (`parseFormula`); the schema says so before the Explorer tries it. */
function parses(expr: string): boolean {
  try {
    parseFormula(expr);
    return true;
  } catch {
    return false;
  }
}

export type MetricFn =
  | { op: 'rate' }
  | { op: 'increase' }
  | { op: 'rollup'; agg: 'avg' | 'min' | 'max' | 'sum'; intervalMs: number }
  | { op: 'top' | 'bottom'; n: number; by: 'avg' | 'max' | 'last' };

export interface MetricQuery {
  id: string;
  metric: string;
  kind: MetricPointRecord['type'] | null;
  unit: string | null;
  show: string;
  /** OTTL paths: `resource.attributes["…"]`, `attributes["…"]`. */
  by: string[];
  where: string | null;
  fn: MetricFn[];
  alias: string | null;
  hidden: boolean;
}

/** What `MetricQuerySchema` accepts: `id`, `metric` and `show`, and any of the rest. */
export type MetricQueryInput = Pick<MetricQuery, 'id' | 'metric' | 'show'> & {
  [K in Exclude<keyof MetricQuery, 'id' | 'metric' | 'show'>]?: MetricQuery[K] | undefined;
};

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

export const POINT_TYPES = ['gauge', 'sum', 'histogram', 'exponentialHistogram', 'summary'] as const;
const positiveInt = z.number().int().positive();

const MetricFnSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rate') }),
  z.object({ op: z.literal('increase') }),
  z.object({ op: z.literal('rollup'), agg: z.enum(['avg', 'min', 'max', 'sum']), intervalMs: positiveInt }),
  z.object({ op: z.enum(['top', 'bottom']), n: positiveInt, by: z.enum(['avg', 'max', 'last']) }),
]);

/**
 * Only `id`, `metric` and `show` are required; the rest default so a hand-written URL stays short. An empty
 * `metric` and `show` mean "not chosen yet" (a query seeded by carry-over); the Explorer asks for them.
 */
export const MetricQuerySchema: z.ZodType<MetricQuery, MetricQueryInput> = z
  .object({
    id: z.string().regex(/^[a-z]$/, 'a query id of one letter a-z'),
    metric: z.string(),
    kind: z.enum(POINT_TYPES).nullable().default(null),
    unit: z.string().nullable().default(null),
    show: z.string(),
    by: z.array(z.string().min(1)).default([]),
    where: z.string().min(1).nullable().default(null),
    fn: z.array(MetricFnSchema).default([]),
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

export const MetricFormulaSchema: z.ZodType<MetricFormula> = z.object({
  id: z.string().regex(/^f[1-9]\d*$/, 'a formula id f1, f2, ...'),
  expr: z.string().min(1).refine(parses, { message: 'a formula over query ids, such as b / a' }),
  alias: z.string().nullable().default(null),
  hidden: z.boolean().default(false),
});

function duplicates(ids: readonly string[]): number[] {
  return ids.flatMap((id, i) => (ids.indexOf(id) === i ? [] : [i]));
}

export const MetricPageStateSchema: z.ZodType<MetricPageState> = z
  .object({
    queries: z.array(MetricQuerySchema).max(MAX_METRIC_QUERIES, `at most ${MAX_METRIC_QUERIES} queries`),
    formulas: z.array(MetricFormulaSchema).default([]),
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
