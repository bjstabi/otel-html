import { OtelHtmlError } from '../../model/errors.js';
import type { CmpOp, Expr, Value } from '../../ottl/ast.js';
import { parseCondition, printCondition } from '../../ottl/parse.js';
import type { LogSeverityKey } from '../../rollups/signal-counts.js';

export type FilterToken = {
  /** Canonical OTTL path (or a path-only arithmetic expression such as a duration). */
  key: string;
  op: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'matches' | 'exists' | 'not exists';
  value: string | number | boolean | null;
  /** When true, `value` is an OTTL enum name (`STATUS_CODE_ERROR`) written bare, not a string literal. */
  enum?: true;
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
    case 'matches':
      return {
        type: 'value',
        value: { type: 'call', name: 'IsMatch', args: [left, literal(String(t.value))], from: 0 },
      };
    case '==':
    case '!=':
    case '>':
    case '>=':
    case '<':
    case '<=':
      return {
        type: 'cmp',
        op: t.op,
        left,
        right: t.enum === true ? { type: 'enum', name: String(t.value), from: 0 } : literal(t.value),
      };
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
    if (key === null) return null;
    if (e.right.type === 'enum') return { key, op: e.op, value: e.right.name, enum: true };
    if (e.right.type !== 'literal') return null;
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
    return plain === null
      ? { key, op: 'matches', value: pattern.value }
      : { key, op: 'contains', value: plain };
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

/**
 * Mapping rule: exactly these dotted keys are core fields. Every other key, including bare `name` and `kind`,
 * is a span attribute, so attributes with those names stay addressable. A Map avoids inherited keys such as
 * `constructor`.
 */
const CORE_SPAN_KEYS: ReadonlyMap<string, string> = new Map([
  ['service.name', 'resource.attributes["service.name"]'],
  ['status.code', 'span.status.code'],
  ['span.name', 'span.name'],
  ['span.kind', 'span.kind'],
  ['instrumentation_scope.name', 'instrumentation_scope.name'],
]);

/**
 * Where a facet key lives. `core` looks the key up in the core table and otherwise falls back to a span attribute;
 * `resource` is always `resource.attributes[key]` and `attribute` is always `span.attributes[key]`, so a key's text
 * can never change which field it addresses (an attribute literally named `resource:foo` stays a span attribute).
 */
export type FacetScope = 'core' | 'resource' | 'attribute';

const CORE_LOG_KEYS: ReadonlyMap<string, string> = new Map([
  ['service.name', 'resource.attributes["service.name"]'],
  ['instrumentation_scope.name', 'instrumentation_scope.name'],
  ['event.name', 'log.event_name'],
  ['trace.present', 'log.trace_id.string'],
]);

export type FacetSignal = 'span' | 'log';

function attributePath(root: 'span' | 'log' | 'resource', key: string): string {
  return printCondition({
    type: 'value',
    value: { type: 'path', segments: [root, 'attributes'], keys: [key], from: 0 },
  });
}

export function facetKeyToPath(key: string, signal: FacetSignal, scope: FacetScope = 'core'): string {
  switch (scope) {
    case 'resource':
      return attributePath('resource', key);
    case 'attribute':
      return attributePath(signal, key);
    case 'core':
      return (signal === 'span' ? CORE_SPAN_KEYS : CORE_LOG_KEYS).get(key) ?? attributePath(signal, key);
  }
}

export const SEVERITY_PATH = 'log.severity_number';

/** First and last OTTL severity enum of each band (`severityKey` ranges): a band is `>= first and <= last`. */
export const SEVERITY_BOUNDS: Record<LogSeverityKey, { first: string; last: string }> = {
  unspecified: { first: 'SEVERITY_NUMBER_UNSPECIFIED', last: 'SEVERITY_NUMBER_UNSPECIFIED' },
  trace: { first: 'SEVERITY_NUMBER_TRACE', last: 'SEVERITY_NUMBER_TRACE4' },
  debug: { first: 'SEVERITY_NUMBER_DEBUG', last: 'SEVERITY_NUMBER_DEBUG4' },
  info: { first: 'SEVERITY_NUMBER_INFO', last: 'SEVERITY_NUMBER_INFO4' },
  warn: { first: 'SEVERITY_NUMBER_WARN', last: 'SEVERITY_NUMBER_WARN4' },
  error: { first: 'SEVERITY_NUMBER_ERROR', last: 'SEVERITY_NUMBER_ERROR4' },
  fatal: { first: 'SEVERITY_NUMBER_FATAL', last: 'SEVERITY_NUMBER_FATAL4' },
};

/** The tokens for `min` ... `max` bands (null drops that side): the single source for severity range writes. */
export function severityRangeTokens(min: LogSeverityKey | null, max: LogSeverityKey | null): FilterToken[] {
  const out: FilterToken[] = [];
  if (min !== null) out.push({ key: SEVERITY_PATH, op: '>=', value: SEVERITY_BOUNDS[min].first, enum: true });
  if (max !== null) out.push({ key: SEVERITY_PATH, op: '<=', value: SEVERITY_BOUNDS[max].last, enum: true });
  return out;
}

/** Rollup display value to OTTL enum name, for the core facets whose OTTL field is an enum-typed int. */
const CORE_ENUM_VALUES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    'status.code',
    new Map([
      ['unset', 'STATUS_CODE_UNSET'],
      ['ok', 'STATUS_CODE_OK'],
      ['error', 'STATUS_CODE_ERROR'],
    ]),
  ],
  [
    'span.kind',
    new Map([
      ['unspecified', 'SPAN_KIND_UNSPECIFIED'],
      ['internal', 'SPAN_KIND_INTERNAL'],
      ['server', 'SPAN_KIND_SERVER'],
      ['client', 'SPAN_KIND_CLIENT'],
      ['producer', 'SPAN_KIND_PRODUCER'],
      ['consumer', 'SPAN_KIND_CONSUMER'],
    ]),
  ],
]);

/** Value type recorded by the rollup for a facet key (`FacetCounts.kind`). */
export type FacetValueKind = 'string' | 'int' | 'double' | 'bool' | 'mixed';

/** Whether "only"/"exclude" can build a correctly typed filter for a key with this value type. */
export function facetFilterable(kind: FacetValueKind | undefined): boolean {
  return kind !== 'mixed';
}

/**
 * The filter token for a facet value, typed to match the data: core enum facets become enum values, numeric and
 * boolean attributes become numeric and boolean literals. Fails fast when no exact filter exists (a `mixed` key,
 * a value that does not parse as its recorded type, an unknown core enum value).
 */
export function facetToken(
  key: string,
  scope: FacetScope,
  value: string,
  op: '==' | '!=',
  kind: FacetValueKind = 'string',
  signal: FacetSignal = 'span',
): FilterToken {
  const path = facetKeyToPath(key, signal, scope);
  const fail = (expected: string): never => {
    throw new OtelHtmlError('usage', {
      path: `facet ${key}`,
      expected,
      actual: JSON.stringify(value),
    });
  };
  if (signal === 'log' && scope === 'core' && key === 'trace.present') {
    if (value !== 'yes' && value !== 'no') return fail('yes or no');
    // `yes` means a non-empty trace id: `!= ""`; `no` is the inverse, and `!=` flips either.
    const present = (value === 'yes') === (op === '==');
    return { key: path, op: present ? '!=' : '==', value: '' };
  }
  const enums = scope === 'core' && signal === 'span' ? CORE_ENUM_VALUES.get(key) : undefined;
  if (enums !== undefined) {
    const name = enums.get(value);
    if (name === undefined) return fail(`one of ${[...enums.keys()].join(', ')}`);
    return { key: path, op, value: name, enum: true };
  }
  switch (kind) {
    case 'string':
      return { key: path, op, value };
    case 'mixed':
      return fail('a facet key with a single value type; this key holds more than one, so use the query bar');
    case 'bool':
      if (value !== 'true' && value !== 'false') return fail('true or false');
      return { key: path, op, value: value === 'true' };
    case 'int': {
      const n = Number(value);
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n)) return fail('a safe integer');
      return { key: path, op, value: n };
    }
    case 'double': {
      const n = Number(value);
      if (!Number.isFinite(n)) return fail('a finite number');
      return { key: path, op, value: n };
    }
  }
}
