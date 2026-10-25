import type { SyntaxNode, Tree } from '@lezer/common';
import { OtelHtmlError } from '../model/errors.js';
import type { CmpOp, Expr, MathOp, Value } from './ast.js';
import { parser } from './parser.gen.js';

const MAX_DEPTH = 1000;
const MAX_CHAIN = 1000;
const MAX_ACTUAL_LEN = 24;

function fail(col: number, expected: string, actual: string): never {
  throw new OtelHtmlError('invalid-ottl', { path: `col ${col}`, expected, actual });
}

// ---------------------------------------------------------------------------
// Token scan (linear, no regex). Used only to word syntax errors precisely.
// ---------------------------------------------------------------------------

interface Tok {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly kind: 'string' | 'word' | 'punct';
  /** Number of unclosed '(' before this token. */
  readonly depth: number;
}

function isWordChar(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
}

function scanTokens(src: string): { toks: Tok[]; unterminatedAt: number } {
  const toks: Tok[] = [];
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    const start = i;
    if (c === '"') {
      i++;
      let closed = false;
      while (i < src.length) {
        const d = src.charAt(i);
        if (d === '\n') break;
        if (d === '\\') {
          i += 2;
          continue;
        }
        i++;
        if (d === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) return { toks, unterminatedAt: start };
      toks.push({ start, end: i, text: src.slice(start, i), kind: 'string', depth });
      continue;
    }
    if (isWordChar(c)) {
      while (i < src.length && isWordChar(src.charAt(i))) i++;
      toks.push({ start, end: i, text: src.slice(start, i), kind: 'word', depth });
      continue;
    }
    const two = src.slice(i, i + 2);
    const len = two === '==' || two === '!=' || two === '<=' || two === '>=' ? 2 : 1;
    i += len;
    toks.push({ start, end: i, text: src.slice(start, i), kind: 'punct', depth });
    if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
  }
  return { toks, unterminatedAt: -1 };
}

function describeTok(t: Tok | undefined): string {
  if (t === undefined) return 'end of input';
  const text = t.text.length > MAX_ACTUAL_LEN ? `${t.text.slice(0, MAX_ACTUAL_LEN)}...` : t.text;
  return `'${text}'`;
}

function endsOperand(t: Tok): boolean {
  if (t.kind === 'punct') return t.text === ')' || t.text === ']';
  return t.text !== 'and' && t.text !== 'or' && t.text !== 'not';
}

function syntaxError(src: string, pos: number, toks: readonly Tok[]): never {
  let idx = toks.findIndex((t) => t.end > pos);
  if (idx < 0) idx = toks.length;
  const cur = toks[idx];
  const prev = idx > 0 ? toks[idx - 1] : undefined;
  const col = (cur === undefined ? src.length : Math.max(cur.start, pos)) + 1;
  const depth =
    cur?.depth ??
    (prev === undefined ? 0 : prev.depth + (prev.text === '(' ? 1 : prev.text === ')' ? -1 : 0));
  let expected: string;
  if (prev === undefined || !endsOperand(prev)) {
    expected =
      prev?.text === '[' ? 'string or integer key' : prev?.text === '.' ? 'identifier' : 'expression';
  } else if (cur !== undefined && cur.text === ')' && depth === 0) {
    expected = 'end of input';
  } else if (cur === undefined && depth > 0) {
    expected = "')'";
  } else {
    expected = depth > 0 ? "operator or ')'" : 'operator or end of input';
  }
  return fail(col, expected, describeTok(cur));
}

function firstErrorPos(tree: Tree): number {
  let pos = -1;
  tree.iterate({
    enter: (n) => {
      if (pos >= 0) return false;
      if (n.type.isError) {
        pos = n.from;
        return false;
      }
      return true;
    },
  });
  return pos;
}

// ---------------------------------------------------------------------------
// Tree -> AST
// ---------------------------------------------------------------------------

type Lowered = { k: 'value'; v: Value; what: string } | { k: 'bool'; e: Expr; what: string; from: number };

class Lowerer {
  constructor(private readonly src: string) {}

  private text(n: SyntaxNode): string {
    return this.src.slice(n.from, n.to);
  }

  private kids(n: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    for (let c = n.firstChild; c !== null; c = c.nextSibling) if (isLetter(c.name.charAt(0))) out.push(c); // skip punctuation tokens
    return out;
  }

  /** Children of a flat operator chain (operand, op, operand, ...), bounded to keep the AST shallow. */
  private chain(n: SyntaxNode): SyntaxNode[] {
    const kids = this.kids(n);
    if (kids.length > 2 * MAX_CHAIN - 1) {
      return fail(n.from + 1, `at most ${MAX_CHAIN} chained operands`, `${(kids.length + 1) / 2} operands`);
    }
    return kids;
  }

  private child(n: SyntaxNode, i: number): SyntaxNode {
    const c = this.kids(n)[i];
    if (c === undefined) return fail(n.from + 1, `child ${i} of ${n.name}`, 'nothing');
    return c;
  }

  expr(n: SyntaxNode, depth = 0): Expr {
    return this.toExpr(this.lower(n, depth), n);
  }

  private toExpr(l: Lowered, n: SyntaxNode): Expr {
    if (l.k === 'bool') return l.e;
    const v = l.v;
    const ok =
      v.type === 'path' || v.type === 'call' || (v.type === 'literal' && typeof v.value === 'boolean');
    if (!ok) return fail(n.from + 1, 'boolean expression', l.what);
    return { type: 'value', value: v };
  }

  private toValue(l: Lowered): Value {
    if (l.k === 'value') return l.v;
    return fail(l.from + 1, 'value', l.what);
  }

  private lower(n: SyntaxNode, depth: number): Lowered {
    if (depth > MAX_DEPTH)
      return fail(n.from + 1, `nesting of at most ${MAX_DEPTH} levels`, 'deeper nesting');
    const d = depth + 1;
    const val = (v: Value, what: string): Lowered => ({ k: 'value', v, what });
    const bool = (e: Expr, what: string): Lowered => ({ k: 'bool', e, what, from: n.from });
    switch (n.name) {
      case 'Condition':
        return this.lower(this.child(n, 0), d);
      case 'Paren': {
        const inner = this.lower(this.child(n, 0), d);
        return inner.k === 'bool' ? { ...inner, from: n.from } : inner;
      }
      case 'Or':
      case 'And': {
        const type = n.name === 'Or' ? 'or' : 'and';
        const kids = this.chain(n);
        const first = kids[0];
        if (first === undefined) return fail(n.from + 1, 'expression', 'nothing');
        let acc = this.toExpr(this.lower(first, d), first);
        for (let i = 2; i < kids.length; i += 2) {
          const c = kids[i];
          if (c === undefined) break;
          acc = { type, left: acc, right: this.toExpr(this.lower(c, d), c) };
        }
        return bool(acc, 'boolean expression');
      }
      case 'Not': {
        const c = this.child(n, 1);
        return bool({ type: 'not', expr: this.toExpr(this.lower(c, d), c) }, 'boolean expression');
      }
      case 'Cmp': {
        const lc = this.child(n, 0);
        const rc = this.child(n, 2);
        const left = this.toValue(this.lower(lc, d));
        const right = this.toValue(this.lower(rc, d));
        const op = this.text(this.child(n, 1)) as CmpOp;
        return bool({ type: 'cmp', op, left, right }, 'comparison');
      }
      case 'Math': {
        const kids = this.chain(n);
        const first = kids[0];
        if (first === undefined) return fail(n.from + 1, 'value', 'nothing');
        let acc = this.toValue(this.lower(first, d));
        for (let i = 2; i < kids.length; i += 2) {
          const c = kids[i];
          const opNode = kids[i - 1];
          if (c === undefined || opNode === undefined) break;
          const op = this.text(opNode) as MathOp;
          acc = { type: 'math', op, left: acc, right: this.toValue(this.lower(c, d)) };
        }
        return val(acc, 'arithmetic');
      }
      case 'Neg': {
        const sign = this.child(n, 0);
        if (this.text(sign) !== '-') return fail(sign.from + 1, "'-'", `'${this.text(sign)}'`);
        const c = this.child(n, 1);
        const inner = this.toValue(this.lower(c, d));
        if (
          inner.type === 'literal' &&
          (typeof inner.value === 'bigint' || typeof inner.value === 'number')
        ) {
          return val({ type: 'literal', value: -inner.value }, 'number');
        }
        return fail(n.from + 1, 'number after unary minus', 'non-numeric operand');
      }
      case 'Call': {
        const kids = this.kids(n);
        const nameNode = kids[0];
        if (nameNode === undefined) return fail(n.from + 1, 'converter name', 'nothing');
        const args = kids.slice(1).map((a) => this.toValue(this.lower(a, d)));
        return val({ type: 'call', name: this.text(nameNode), args, from: n.from }, 'converter call');
      }
      case 'Path': {
        const segments: string[] = [];
        const keys: (string | number)[] = [];
        for (const k of this.kids(n)) {
          if (k.name === 'Ident') segments.push(this.text(k));
          else if (k.name === 'Key') keys.push(this.key(k));
          else return fail(k.from + 1, 'path element', k.name);
        }
        return val({ type: 'path', segments, keys, from: n.from }, 'path');
      }
      case 'Enum': {
        const name = this.text(n);
        if (!isEnumName(name))
          return fail(n.from + 1, 'enum (UPPER_SNAKE_CASE) or converter call', `'${name}'`);
        return val({ type: 'enum', name, from: n.from }, 'enum');
      }
      case 'String':
        return val({ type: 'literal', value: this.string(n) }, 'string');
      case 'Int':
        return val({ type: 'literal', value: BigInt(this.text(n)) }, 'integer');
      case 'Float': {
        const f = Number(this.text(n));
        if (!Number.isFinite(f)) return fail(n.from + 1, 'finite float', `'${this.text(n)}'`);
        return val({ type: 'literal', value: f }, 'float');
      }
      case 'True':
        return val({ type: 'literal', value: true }, 'boolean');
      case 'False':
        return val({ type: 'literal', value: false }, 'boolean');
      case 'Nil':
        return val({ type: 'literal', value: null }, 'nil');
      default:
        return fail(n.from + 1, 'expression', `${n.name} '${this.text(n)}'`);
    }
  }

  private key(k: SyntaxNode): string | number {
    const c = this.child(k, 0);
    if (c.name === 'String') return this.string(c);
    const n = Number(this.text(c));
    if (!Number.isSafeInteger(n)) return fail(c.from + 1, 'safe integer key', `'${this.text(c)}'`);
    return n;
  }

  private string(n: SyntaxNode): string {
    const s = this.src;
    const end = n.to - 1;
    let out = '';
    let i = n.from + 1;
    while (i < end) {
      const c = s.charAt(i);
      if (c !== '\\') {
        out += c;
        i++;
        continue;
      }
      const e = s.charAt(i + 1);
      switch (e) {
        case '"':
        case '\\':
        case '/':
          out += e;
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'u': {
          const hex = s.slice(i + 2, i + 6);
          if (hex.length !== 4 || !isHex(hex))
            return fail(i + 1, 'valid escape (\\uXXXX needs 4 hex digits)', `'${s.slice(i, i + 6)}'`);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          return fail(i + 1, 'valid escape (\\" \\\\ \\/ \\n \\r \\t \\b \\f \\uXXXX)', `'\\${e}'`);
      }
      i += 2;
    }
    return out;
  }
}

function isLetter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function isHex(s: string): boolean {
  for (const c of s) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
  }
  return true;
}

function isEnumName(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    const upper = c >= 'A' && c <= 'Z';
    if (i === 0 ? !upper : !(upper || c === '_' || (c >= '0' && c <= '9'))) return false;
  }
  return s.length > 0;
}

export function parseCondition(src: string): Expr {
  const { toks, unterminatedAt } = scanTokens(src);
  if (unterminatedAt >= 0)
    return fail(
      unterminatedAt + 1,
      `closing '"'`,
      src.indexOf('\n', unterminatedAt) >= 0 ? 'end of line' : 'end of input',
    );
  const tree = parser.parse(src);
  const errPos = firstErrorPos(tree);
  if (errPos >= 0) return syntaxError(src, errPos, toks);
  return new Lowerer(src).expr(tree.topNode.firstChild ?? tree.topNode);
}

// ---------------------------------------------------------------------------
// Printer (canonical OTTL)
// ---------------------------------------------------------------------------

function printString(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = ch.charCodeAt(0);
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
      }
    }
  }
  return `${out}"`;
}

function printFloat(n: number): string {
  if (Object.is(n, -0)) return '-0.0';
  const s = String(n);
  const e = s.indexOf('e');
  const mant = e < 0 ? s : s.slice(0, e);
  const exp = e < 0 ? '' : s.slice(e);
  return `${mant.includes('.') ? mant : `${mant}.0`}${exp}`;
}

const MATH_LEVEL: Record<MathOp, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

function printValue(v: Value, min: number): string {
  switch (v.type) {
    case 'path':
      return (
        v.segments.join('.') +
        v.keys.map((k) => (typeof k === 'number' ? `[${k}]` : `[${printString(k)}]`)).join('')
      );
    case 'literal': {
      const x = v.value;
      if (x === null) return 'nil';
      if (typeof x === 'string') return printString(x);
      if (typeof x === 'bigint') return x.toString();
      if (typeof x === 'number') return printFloat(x);
      return x ? 'true' : 'false';
    }
    case 'enum':
      return v.name;
    case 'call':
      return `${v.name}(${v.args.map((a) => printValue(a, 0)).join(', ')})`;
    case 'math': {
      const lvl = MATH_LEVEL[v.op];
      const s = `${printValue(v.left, lvl)} ${v.op} ${printValue(v.right, lvl + 1)}`;
      return lvl < min ? `(${s})` : s;
    }
  }
}

function printExpr(e: Expr, min: number): string {
  switch (e.type) {
    case 'or':
    case 'and': {
      const lvl = e.type === 'or' ? 1 : 2;
      const s = `${printExpr(e.left, lvl)} ${e.type} ${printExpr(e.right, lvl + 1)}`;
      return lvl < min ? `(${s})` : s;
    }
    case 'not': {
      const s = `not ${printExpr(e.expr, 3)}`;
      return 3 < min ? `(${s})` : s;
    }
    case 'cmp': {
      const s = `${printValue(e.left, 0)} ${e.op} ${printValue(e.right, 0)}`;
      return 4 < min ? `(${s})` : s;
    }
    case 'value':
      return printValue(e.value, 0);
  }
}

export function printCondition(e: Expr): string {
  return printExpr(e, 0);
}
