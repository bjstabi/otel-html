import { sha256Hex } from '../model/sha256.js';
import type { Expr, Value } from '../ottl/ast.js';
import { compileCondition } from '../ottl/compile.js';
import { CONVERTERS } from '../ottl/converters.js';
import { parseCondition } from '../ottl/parse.js';
import type { ResolvedDashboard } from './schema.js';

/**
 * A condition with its whitespace outside string literals collapsed to one space and its ends trimmed, so the same
 * query laid out differently has one id. A literal keeps its text and escapes (`\"` does not end it).
 */
export function normalizeCondition(source: string): string {
  let out = '';
  let inString = false;
  let pendingSpace = false;
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < source.length) out += source.charAt(++i);
      else if (c === '"') inString = false;
      continue;
    }
    if (/\s/.test(c)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += ' ';
    pendingSpace = false;
    out += c;
    if (c === '"') inString = true;
  }
  return out;
}

/**
 * The version of the OTTL evaluation that decides which traces a condition matches: the writer's evaluator
 * (`compileCondition`) when it writes the `widget_traces` index, and `translateCondition` when the viewer scans.
 * Bump it whenever either changes what a condition matches, so that both sides agree: a merge computes again an
 * index written by another version, and the viewer scans a partition whose index was.
 */
export const WIDGET_INDEX_EVALUATOR = 1;

/** The id a `widget_traces` row carries: the first 16 hex digits of the SHA-256 of the normalized condition. */
export function conditionId(source: string): string {
  return sha256Hex(normalizeCondition(source)).slice(0, 16);
}

export interface WidgetTraceIndexSpec {
  /** The distinct indexed conditions, normalized, sorted by id. */
  conditions: { id: string; source: string }[];
  /** The variable keys of the dashboards holding an indexed traces widget; sorted, distinct. */
  variables: string[];
  /** The sources calling a converter that is not row local; they are not indexed. */
  notRowLocal: string[];
}

function callsOf(v: Value, out: Set<string>): void {
  switch (v.type) {
    case 'call':
      out.add(v.name);
      for (const a of v.args) callsOf(a, out);
      return;
    case 'math':
      callsOf(v.left, out);
      callsOf(v.right, out);
      return;
    case 'path':
    case 'literal':
    case 'enum':
      return;
  }
}

function exprCalls(e: Expr, out: Set<string>): void {
  switch (e.type) {
    case 'and':
    case 'or':
      exprCalls(e.left, out);
      exprCalls(e.right, out);
      return;
    case 'not':
      exprCalls(e.expr, out);
      return;
    case 'cmp':
      callsOf(e.left, out);
      callsOf(e.right, out);
      return;
    case 'value':
      callsOf(e.value, out);
      return;
  }
}

/**
 * The conditions of the dashboards' traces widgets that a report indexes per partition (`widget_traces`): every
 * `type: 'traces'` widget with a `query` that parses and compiles against spans. A condition that does not is left to
 * the config's own validation; one that calls a converter that is not row local is listed in `notRowLocal` instead.
 */
export function widgetTraceConditions(dashboards: readonly ResolvedDashboard[]): WidgetTraceIndexSpec {
  const byId = new Map<string, string>();
  const variables = new Set<string>();
  const notRowLocal = new Set<string>();
  for (const d of dashboards) {
    for (const w of d.dashboard.widgets) {
      if (w.type !== 'traces' || w.query === null) continue;
      const source = normalizeCondition(w.query);
      let calls: Set<string>;
      try {
        compileCondition(source, 'span');
        calls = new Set();
        exprCalls(parseCondition(source), calls);
      } catch {
        continue;
      }
      if ([...calls].some((name) => CONVERTERS.get(name)?.rowLocal === false)) {
        notRowLocal.add(source);
        continue;
      }
      byId.set(conditionId(source), source);
      for (const v of d.dashboard.variables) variables.add(v.key);
    }
  }
  return {
    conditions: [...byId]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, source]) => ({ id, source })),
    variables: [...variables].sort(),
    notRowLocal: [...notRowLocal].sort(),
  };
}
