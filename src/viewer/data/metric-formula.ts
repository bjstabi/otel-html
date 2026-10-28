import { OtelHtmlError } from '../../model/errors.js';
import type { MetricQueryResult, SeriesPoints } from './metric-query.js';

export type FormulaOp = '+' | '-' | '*' | '/';
export type FormulaAst =
  | { type: 'num'; value: number }
  | { type: 'ref'; id: string }
  | { type: 'bin'; op: FormulaOp; left: FormulaAst; right: FormulaAst };

/** Parentheses deeper than this are rejected, so parsing and evaluation never recurse further. */
const MAX_DEPTH = 64;

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; id: string }
  | { kind: 'op'; op: FormulaOp | '(' | ')' };

/** `×`, `÷` and `−` are accepted as the display forms of `*`, `/` and `-`. */
const OPS: Readonly<Record<string, FormulaOp | '(' | ')'>> = {
  '+': '+',
  '-': '-',
  '−': '-',
  '*': '*',
  '×': '*',
  '/': '/',
  '÷': '/',
  '(': '(',
  ')': ')',
};

function fail(col: number, expected: string, actual: string): never {
  throw new OtelHtmlError('usage', { path: `col ${col}`, expected, actual });
}

function tokenize(src: string): { tok: Token; col: number }[] {
  const out: { tok: Token; col: number }[] = [];
  const re = /\s+|(\d+(?:\.\d+)?|\.\d+)|([a-z])|(.)/gsy;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const col = m.index + 1;
    const [, num, ref, other] = m;
    if (num !== undefined) out.push({ tok: { kind: 'num', value: Number(num) }, col });
    else if (ref !== undefined) out.push({ tok: { kind: 'ref', id: ref }, col });
    else if (other !== undefined) {
      const op = OPS[other];
      if (op === undefined)
        fail(col, 'a query id [a-z], a number, an operator or a parenthesis', JSON.stringify(other));
      out.push({ tok: { kind: 'op', op }, col });
    }
  }
  return out;
}

const describe = (t: Token | undefined): string =>
  t === undefined
    ? 'end of input'
    : t.kind === 'num'
      ? String(t.value)
      : t.kind === 'ref'
        ? t.id
        : `'${t.op}'`;

/** Parses `+ - * /`, parentheses, numbers and query ids `[a-z]`. A bad expression fails with `usage` at its column. */
export function parseFormula(expr: string): FormulaAst {
  const toks = tokenize(expr);
  let i = 0;
  const endCol = expr.length + 1;
  const colAt = (k: number): number => toks[k]?.col ?? endCol;
  const peekOp = (...ops: string[]): FormulaOp | null => {
    const t = toks[i]?.tok;
    return t?.kind === 'op' && ops.includes(t.op) && t.op !== '(' && t.op !== ')' ? t.op : null;
  };

  const primary = (depth: number): FormulaAst => {
    const cur = toks[i];
    const t = cur?.tok;
    if (t?.kind === 'num' || t?.kind === 'ref') {
      i++;
      return t.kind === 'num' ? { type: 'num', value: t.value } : { type: 'ref', id: t.id };
    }
    if (t?.kind === 'op' && t.op === '(') {
      if (depth >= MAX_DEPTH) fail(colAt(i), `at most ${MAX_DEPTH} nested parentheses`, 'more');
      i++;
      const inner = sum(depth + 1);
      const close = toks[i]?.tok;
      if (close?.kind !== 'op' || close.op !== ')') fail(colAt(i), "')'", describe(close));
      i++;
      return inner;
    }
    return fail(colAt(i), 'a query id, a number or "("', describe(t));
  };
  const product = (depth: number): FormulaAst => {
    let left = primary(depth);
    for (let op = peekOp('*', '/'); op !== null; op = peekOp('*', '/')) {
      i++;
      left = { type: 'bin', op, left, right: primary(depth) };
    }
    return left;
  };
  const sum = (depth: number): FormulaAst => {
    let left = product(depth);
    for (let op = peekOp('+', '-'); op !== null; op = peekOp('+', '-')) {
      i++;
      left = { type: 'bin', op, left, right: product(depth) };
    }
    return left;
  };

  const ast = sum(0);
  if (i < toks.length) fail(colAt(i), 'an operator', describe(toks[i]?.tok));
  return ast;
}

/** The query ids a formula reads, in first-use order. */
export function formulaRefs(ast: FormulaAst): string[] {
  const out: string[] = [];
  const stack = [ast];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (n.type === 'ref') {
      if (!out.includes(n.id)) out.push(n.id);
    } else if (n.type === 'bin') stack.push(n.right, n.left);
  }
  return out;
}

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
