import { OtelHtmlError } from '../model/errors.js';

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
