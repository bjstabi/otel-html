import { assertNever, OtelHtmlError } from '../../model/errors.js';
import type { Expr, Value } from '../../ottl/ast.js';
import { compileCondition } from '../../ottl/compile.js';
import type { OttlContextName } from '../../ottl/contexts.js';
import { parseCondition } from '../../ottl/parse.js';
import type { MetricQuery } from '../data/metric-query.js';
import type { TimeWindow } from '../data/span-query.js';
import { defaultMetricState } from './metric-state.js';
import { PAGE_OPTIONS, type Page } from './page-options.js';
import { type SelectionData, selectionToUrlState } from './selection.js';
import { formatWindow, URL_KEYS, type UrlKey, type UrlState } from './url-state.js';

export interface DroppedParam {
  key: 'q';
  value: string;
  /** Why it does not apply on the target page (the OTTL compile error). */
  reason: string;
}

/**
 * The cross-signal carry-over rule. Within one page everything is kept. Between explorers only `t`, `text` and a
 * `q` that compiles in the target's OTTL context come along; mode, group, view, sort, trace, span, log and tabs
 * reset. Metrics takes `t` and seeds its first query's `where` from `q`; Dashboards has no OTTL context yet, so it keeps everything.
 */
export function carryTo(
  s: SelectionData,
  from: Page | null,
  to: Page,
): { url: UrlState; dropped: DroppedParam[] } {
  if (from === to) return { url: selectionToUrlState(s), dropped: [] };
  switch (to) {
    case 'dashboards':
      return { url: selectionToUrlState(s), dropped: [] };
    case 'metrics': {
      // Metrics has no `text` and no `q`: a compiling `q` seeds the first query's `where` instead.
      const url: UrlState = {};
      if (s.window !== null) url.t = formatWindow(s.window);
      const { condition, dropped } = conditionFor(s.condition, 'datapoint');
      if (condition !== null) {
        const seed = defaultMetricState(null);
        url.m = { ...seed, queries: seed.queries.map((q) => ({ ...q, where: condition })) };
      }
      return { url, dropped };
    }
    case 'traces':
    case 'logs': {
      const url: UrlState = {};
      if (s.text !== '') url.text = s.text;
      if (s.window !== null) url.t = formatWindow(s.window);
      const { condition, dropped } = conditionFor(s.condition, PAGE_OPTIONS[to].context);
      if (condition !== null) url.q = condition;
      return { url, dropped };
    }
  }
}

/** The condition when it compiles in the target's context, else a dropped-param entry saying why not. */
function conditionFor(
  condition: string | null,
  context: OttlContextName,
): { condition: string | null; dropped: DroppedParam[] } {
  if (condition === null) return { condition: null, dropped: [] };
  try {
    compileCondition(condition, context);
    return { condition, dropped: [] };
  } catch (e) {
    if (!(e instanceof OtelHtmlError && e.code === 'invalid-ottl')) throw e;
    return { condition: null, dropped: [{ key: 'q', value: condition, reason: e.message }] };
  }
}

function valuePaths(v: Value, out: Value[]): void {
  switch (v.type) {
    case 'path':
      out.push(v);
      return;
    case 'call':
      for (const a of v.args) valuePaths(a, out);
      return;
    case 'math':
      valuePaths(v.left, out);
      valuePaths(v.right, out);
      return;
    case 'literal':
    case 'enum':
      return;
    default:
      assertNever(v, 'ottl value');
  }
}

function exprPaths(e: Expr, out: Value[]): void {
  switch (e.type) {
    case 'or':
    case 'and':
      exprPaths(e.left, out);
      exprPaths(e.right, out);
      return;
    case 'not':
      exprPaths(e.expr, out);
      return;
    case 'cmp':
      valuePaths(e.left, out);
      valuePaths(e.right, out);
      return;
    case 'value':
      valuePaths(e.value, out);
      return;
    default:
      assertNever(e, 'ottl expression');
  }
}

/**
 * A metric chart's click-menu link to Traces or Logs: the clicked bucket's window and the query's `where`. The
 * `where` carries only when every path in it is `resource.attributes[...]` (the one thing a data point shares with
 * a span or log) and it compiles in the target context. A point-attribute path would compile there, but it would
 * mean something else, so it is dropped with a reason.
 */
export function metricWindowLink(
  q: MetricQuery,
  window: TimeWindow,
  to: 'traces' | 'logs',
): { url: UrlState; dropped: DroppedParam[] } {
  const url: UrlState = { t: formatWindow(window) };
  if (q.where === null) return { url, dropped: [] };
  const paths: Value[] = [];
  exprPaths(parseCondition(q.where), paths);
  const foreign = paths.find(
    (p) => p.type === 'path' && !(p.segments[0] === 'resource' && p.segments[1] === 'attributes'),
  );
  if (foreign !== undefined) {
    const kind = foreign.type === 'path' && foreign.segments[0] === 'attributes' ? 'attributes' : 'fields';
    return {
      url,
      dropped: [{ key: 'q', value: q.where, reason: `data point ${kind} don't apply to ${to}` }],
    };
  }
  const { condition, dropped } = conditionFor(q.where, PAGE_OPTIONS[to].context);
  if (condition !== null) url.q = condition;
  return { url, dropped };
}

/** URL changes applied on top of a carried state: a value sets the key, `null` removes it. */
export type UrlPatch = { [K in keyof UrlState]?: UrlState[K] | null };

function patchKey<K extends UrlKey>(out: UrlState, k: K, v: UrlState[K] | null | undefined): void {
  if (v === null) delete out[k];
  else if (v !== undefined) out[k] = v;
}

export function applyPatch(url: UrlState, patch: UrlPatch): UrlState {
  const out: UrlState = { ...url };
  for (const k of URL_KEYS) patchKey(out, k, patch[k]);
  return out;
}
