import { OtelHtmlError } from '../../model/errors.js';
import type { CmpOp, Expr, Value } from '../../ottl/ast.js';
import { parseCondition, printCondition } from '../../ottl/parse.js';

export type FilterToken = {
  /** Canonical OTTL path (or a path-only arithmetic expression such as a duration). */
  key: string;
  op: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'exists' | 'not exists';
  value: string | number | boolean | null;
};

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_META, '\\$&');
}

/** Inverse of `escapeRegex`; null when `re` has an unescaped metacharacter (i.e. is a real pattern). */
function unescapeRegex(re: string): string | null {
  let out = '';
  for (let i = 0; i < re.length; i++) {
    const c = re.charAt(i);
    if (c === '\\') {
      const next = re.charAt(i + 1);
      if (next === '' || !/[.*+?^${}()|[\]\\]/.test(next)) return null;
      out += next;
      i++;
    } else if (/[.*+?^${}()|[\]]/.test(c)) {
      return null;
    } else {
      out += c;
    }
  }
  return out;
}

function keyValue(key: string): Value {
  let e: Expr;
  try {
    e = parseCondition(`${key} == nil`);
  } catch (cause) {
    throw new OtelHtmlError('invalid-ottl', {
      path: 'filter token key',
      expected: 'an OTTL path or path arithmetic',
      actual: JSON.stringify(key),
      ...(cause instanceof Error ? { hint: cause.message } : {}),
    });
  }
  if (e.type !== 'cmp' || e.right.type !== 'literal' || (e.left.type !== 'path' && e.left.type !== 'math')) {
    throw new OtelHtmlError('invalid-ottl', {
      path: 'filter token key',
      expected: 'an OTTL path or path arithmetic',
      actual: JSON.stringify(key),
    });
  }
  return e.left;
}

function literal(v: string | number | boolean | null): Value {
  if (typeof v === 'number' && Number.isInteger(v)) return { type: 'literal', value: BigInt(v) };
  return { type: 'literal', value: v };
}

function tokenExpr(t: FilterToken): Expr {
  const left = keyValue(t.key);
  switch (t.op) {
    case 'exists':
      return { type: 'cmp', op: '!=', left, right: literal(null) };
    case 'not exists':
      return { type: 'cmp', op: '==', left, right: literal(null) };
    case 'contains':
      return {
        type: 'value',
        value: {
          type: 'call',
          name: 'IsMatch',
          args: [left, literal(escapeRegex(String(t.value)))],
          from: 0,
        },
      };
    case '==':
    case '!=':
    case '>':
    case '>=':
    case '<':
    case '<=':
      return { type: 'cmp', op: t.op, left, right: literal(t.value) };
  }
}

export function tokensToOttl(tokens: readonly FilterToken[]): string | null {
  const [first, ...rest] = tokens;
  if (first === undefined) return null;
  let expr = tokenExpr(first);
  for (const t of rest) expr = { type: 'and', left: expr, right: tokenExpr(t) };
  return printCondition(expr);
}

function flatten(e: Expr, out: Expr[]): void {
  if (e.type === 'and') {
    flatten(e.left, out);
    flatten(e.right, out);
  } else {
    out.push(e);
  }
}

function keyOf(v: Value): string | null {
  if (v.type !== 'path' && v.type !== 'math') return null;
  if (v.type === 'math' && (!isKeyPart(v.left) || !isKeyPart(v.right))) return null;
  return printCondition({ type: 'value', value: v });
}

function isKeyPart(v: Value): boolean {
  return v.type === 'path' || (v.type === 'math' && isKeyPart(v.left) && isKeyPart(v.right));
}

function termToToken(e: Expr): FilterToken | null {
  if (e.type === 'cmp') {
    const key = keyOf(e.left);
    if (key === null || e.right.type !== 'literal') return null;
    const v = e.right.value;
    if (v === null) {
      if (e.op === '!=') return { key, op: 'exists', value: null };
      return e.op === '==' ? { key, op: 'not exists', value: null } : null;
    }
    const op: CmpOp = e.op;
    if (typeof v === 'bigint') {
      const n = Number(v);
      return Number.isSafeInteger(n) ? { key, op, value: n } : null;
    }
    return { key, op, value: v };
  }
  if (e.type === 'value' && e.value.type === 'call' && e.value.name === 'IsMatch') {
    const [target, pattern, ...extra] = e.value.args;
    if (target === undefined || pattern === undefined || extra.length > 0) return null;
    const key = keyOf(target);
    if (key === null || pattern.type !== 'literal' || typeof pattern.value !== 'string') return null;
    const plain = unescapeRegex(pattern.value);
    return plain === null ? null : { key, op: 'contains', value: plain };
  }
  return null;
}

/** Null when `src` is not a flat `and` of token shapes (or does not parse); the bar then shows raw OTTL. */
export function ottlToTokens(src: string): FilterToken[] | null {
  let e: Expr;
  try {
    e = parseCondition(src);
  } catch {
    return null;
  }
  const terms: Expr[] = [];
  flatten(e, terms);
  const tokens: FilterToken[] = [];
  for (const term of terms) {
    const t = termToToken(term);
    if (t === null) return null;
    tokens.push(t);
  }
  return tokens;
}

const CORE_SPAN_KEYS: Readonly<Record<string, string>> = {
  'service.name': 'resource.attributes["service.name"]',
  'status.code': 'span.status.code',
  'span.name': 'span.name',
  name: 'span.name',
  kind: 'span.kind',
};

export function facetKeyToPath(key: string, signal: 'span'): string {
  switch (signal) {
    case 'span':
      return (
        CORE_SPAN_KEYS[key] ??
        printCondition({
          type: 'value',
          value: { type: 'path', segments: ['span', 'attributes'], keys: [key], from: 0 },
        })
      );
  }
}
