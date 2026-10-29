import { OtelHtmlError } from '../../model/errors.js';
import { type FormulaAst, formulaRefs } from '../../query/metric-formula.js';
import type { MetricQueryResult, SeriesPoints } from './metric-query.js';

function operands(ast: FormulaAst, results: ReadonlyMap<string, MetricQueryResult>): MetricQueryResult[] {
  return formulaRefs(ast).map((id) => {
    const r = results.get(id);
    if (r === undefined)
      throw new OtelHtmlError('usage', {
        path: 'formula',
        expected: 'a query id',
        actual: JSON.stringify(id),
      });
    return r;
  });
}

/** The coarsest bucket width among the formula's operands: the width to re-run them at when they differ. */
export function formulaWidth(ast: FormulaAst, results: ReadonlyMap<string, MetricQueryResult>): number {
  return Math.max(0, ...operands(ast, results).map((r) => r.widthNs));
}

/** null is a gap: any gap operand, a group missing from an operand, or division by zero. */
function evalAt(n: FormulaAst, value: (id: string) => number | null): number | null {
  switch (n.type) {
    case 'num':
      return n.value;
    case 'ref':
      return value(n.id);
    case 'bin': {
      const l = evalAt(n.left, value);
      const r = evalAt(n.right, value);
      if (l === null || r === null) return null;
      const v = n.op === '+' ? l + r : n.op === '-' ? l - r : n.op === '*' ? l * r : r === 0 ? null : l / r;
      return v === null || !Number.isFinite(v) ? null : v;
    }
  }
}

/** Sums and differences keep a shared unit; products and quotients keep the unit of a non-numeric side only. */
function unitOf(n: FormulaAst, unit: (id: string) => string | null): string | null {
  switch (n.type) {
    case 'num':
      return null;
    case 'ref':
      return unit(n.id);
    case 'bin': {
      const l = unitOf(n.left, unit);
      const r = unitOf(n.right, unit);
      if (l === null || r === null) return l ?? r;
      return (n.op === '+' || n.op === '-') && l === r ? l : '';
    }
  }
}

/**
 * Evaluates a formula over query results, aligned on bucket time and group key. All operands must share
 * `widthNs`; when they do not, re-run them at `formulaWidth` (`runMetricQueryAtWidth`).
 */
export function evaluateFormula(
  ast: FormulaAst,
  results: ReadonlyMap<string, MetricQueryResult>,
  id: string,
): MetricQueryResult {
  const refs = formulaRefs(ast);
  const ops = operands(ast, results);
  const widths = [...new Set(ops.map((r) => r.widthNs))];
  if (widths.length > 1)
    throw new OtelHtmlError('usage', {
      path: 'formula',
      expected: 'operands at one bucket width',
      actual: widths.join(', '),
      hint: 're-run the operands at the coarsest width',
    });
  const byRef = new Map(refs.map((r, k) => [r, new Map((ops[k]?.series ?? []).map((s) => [s.key, s]))]));
  const keys: string[] = [];
  const firstOf = new Map<string, SeriesPoints>();
  for (const r of ops)
    for (const s of r.series)
      if (!firstOf.has(s.key)) {
        firstOf.set(s.key, s);
        keys.push(s.key);
      }

  const series: SeriesPoints[] = keys.map((key) => {
    const valuesOf = new Map(
      refs.map((r) => {
        const s = byRef.get(r)?.get(key);
        return [r, s === undefined ? null : new Map(s.points)] as const;
      }),
    );
    const times = [...new Set(refs.flatMap((r) => [...(valuesOf.get(r)?.keys() ?? [])]))].sort(
      (a, b) => a - b,
    );
    const points = times.map((t): [number, number | null] => [
      t,
      evalAt(ast, (r) => valuesOf.get(r)?.get(t) ?? null),
    ]);
    const first = firstOf.get(key);
    const unit = unitOf(ast, (r) => byRef.get(r)?.get(key)?.unit ?? null) ?? '';
    return {
      key,
      label: first?.label ?? key,
      group: first?.group ?? {},
      unit,
      points,
      resourceService: first?.resourceService ?? null,
    };
  });
  return {
    queryId: id,
    widthNs: widths[0] ?? 0,
    series,
    exemplars: [],
    heat: null,
    distribution: null,
    notes: [...new Set(ops.flatMap((r) => r.notes))],
  };
}
