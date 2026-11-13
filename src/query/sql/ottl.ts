import {
  and,
  coalesce,
  column,
  contains,
  type ExprNode,
  eq,
  gt,
  gte,
  isNull,
  literal,
  lower,
  lt,
  lte,
  neq,
  not,
  or,
  regexp_matches,
  sql,
  verbatim,
} from '@uwdata/mosaic-sql';
import type { CmpOp, Expr, Value } from '../../ottl/ast.js';
import { compileCondition } from '../../ottl/compile.js';
import { CONTEXTS, ENUMS } from '../../ottl/contexts.js';
import { parseCondition, printCondition } from '../../ottl/parse.js';
import {
  bindOnce,
  jsonAt,
  jsonKind,
  jsonNumber,
  PATH_COLUMNS,
  type PathColumn,
  type SqlContext,
} from './columns.js';

export { toSql } from './columns.js';

/** Statistics key to the values a matching row must have (strings as R16 stores them). */
export type PruneHints = ReadonlyMap<string, ReadonlySet<string>>;

export interface Translation {
  /** The translatable terms of the top-level `and`, or null when none. */
  predicate: ExprNode | null;
  /** The untranslatable terms as one OTTL condition (printed with printCondition), or null when everything translated. */
  residual: string | null;
  /**
   * Equality terms that bound the partitions a matching row can live in. Two equality terms on one key intersect,
   * so an empty set means no row can match.
   */
  hints: PruneHints;
  /**
   * What the translated terms read, in the statistics-key grammar: a column name, `resource:<key>` / `attr:<key>`, and
   * `resource:*` / `attr:*` when a term reads a whole map (or a key that is not a string). Untranslated (residual)
   * terms are not listed; the browser reads whole rows for them.
   */
  reads: ReadonlySet<string>;
}

/** A term (or part of one) SQL cannot express with the semantics of `compileCondition`; it goes to the residual. */
class Untranslatable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Untranslatable';
  }
}

type Const = string | bigint | number | boolean | null;
const SAFE = 2 ** 53;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const TRUE = literal(true);
const FALSE = literal(false);

const OPS: Readonly<Record<'<' | '<=' | '>' | '>=', (a: ExprNode, b: ExprNode) => ExprNode>> = {
  '<': lt,
  '<=': lte,
  '>': gt,
  '>=': gte,
};
const FLIP: Readonly<Record<CmpOp, CmpOp>> = {
  '==': '==',
  '!=': '!=',
  '<': '>',
  '<=': '>=',
  '>': '<',
  '>=': '<=',
};

function untranslatable(reason: string): never {
  throw new Untranslatable(reason);
}

// ---------------------------------------------------------------------------
// Operands
// ---------------------------------------------------------------------------

interface Operand {
  readonly canon: string;
  readonly pc: PathColumn;
  readonly keys: readonly (string | number)[];
}

function constOf(v: Value): Const | undefined {
  if (v.type === 'literal') return v.value;
  if (v.type === 'enum') return ENUMS.get(v.name);
  return undefined;
}

const DIFF = 'end_time_unix_nano - start_time_unix_nano';

/**
 * `end_time_unix_nano - start_time_unix_nano` of a span: the signed difference of the two columns, not `duration_ns`
 * (the writer clamps that to 0 when end < start). Both are non-negative int64, so the difference cannot overflow.
 */
function durationOf(v: Value, context: SqlContext): Operand | undefined {
  if (v.type !== 'math' || v.op !== '-' || context !== 'span') return undefined;
  const l = pathOf(v.left, context);
  const r = pathOf(v.right, context);
  if (l?.canon !== 'end_time_unix_nano' || r?.canon !== 'start_time_unix_nano') return undefined;
  if (l.keys.length > 0 || r.keys.length > 0) return undefined;
  return { canon: DIFF, pc: { column: DIFF, kind: 'int' }, keys: [] };
}

/** Where `pathOf` notes what it reads while one term is translated (see `Translation.reads`). */
let readSink: Set<string> | null = null;

function readKey(column: string, keys: readonly (string | number)[]): string {
  const first = keys[0];
  const key = typeof first === 'string' ? first : '*';
  if (column === 'resource_attributes') {
    return key === 'service.name' ? 'service_name' : `resource:${key}`;
  }
  if (column === 'attributes') return `attr:${key}`;
  return column;
}

function pathOf(v: Value, context: SqlContext): Operand | undefined {
  if (v.type !== 'path') return undefined;
  const spec = CONTEXTS[context];
  const segs = v.segments.length > 1 && v.segments[0] === spec.prefix ? v.segments.slice(1) : v.segments;
  const canon = segs.join('.');
  const pc = PATH_COLUMNS[context].get(canon);
  if (pc === undefined) return untranslatable(`path ${canon} has no column`);
  readSink?.add(readKey(pc.column, v.keys));
  return { canon, pc, keys: v.keys };
}

function operandOf(v: Value, context: SqlContext): Operand | undefined {
  return pathOf(v, context) ?? durationOf(v, context);
}

const isTime = (o: Operand): boolean => o.canon !== DIFF && o.canon.endsWith('_time_unix_nano');

/**
 * The JSON value at an operand's keys. Refused (so the term stays in the browser): keys whose JSON Pointer reading
 * differs from OTTL's (digit-only and `-` segments index arrays in a pointer; a first attribute key must be a
 * string) and keys that the writer stores as a `{"$m":[[k,v],...]}` map (`$`-prefixed or `__proto__`).
 * A map elsewhere in a row that has such a key is stored as `$m` too; `jsonAt` reads both forms. A numeric key reads
 * arrays only (a map gives OTTL nil). More than MAX_JSON_KEYS keys stay in the browser.
 */
const MAX_JSON_KEYS = 32;

function jsonOperand(o: Operand): ExprNode {
  if (o.canon === 'body.string')
    return untranslatable('body.string: the JSON text differs from its display string');
  if (o.keys.length > MAX_JSON_KEYS) return untranslatable('path deeper than 32 keys');
  const first = o.keys[0];
  if (first !== undefined && typeof first !== 'string' && o.canon !== 'body')
    return untranslatable('a numeric first attribute key');
  for (const k of o.keys) {
    if (typeof k === 'string' && (/^(\d+|-)$/.test(k) || k.startsWith('$') || k === '__proto__'))
      return untranslatable(`key ${JSON.stringify(k)} reads differently in a JSON pointer`);
  }
  return jsonAt(o.pc.column, o.keys);
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

const jsonType = (at: ExprNode): ExprNode => sql`json_type(${at})`;
const int64 = (n: bigint): ExprNode => verbatim(`${n}::BIGINT`);

function compare(op: CmpOp, a: ExprNode, b: ExprNode): ExprNode {
  if (op === '==') return eq(a, b);
  if (op === '!=') return neq(a, b);
  return OPS[op](a, b);
}

/** OTTL: values of different kinds are unequal and unordered; `nil` equals only `nil`. */
const mismatch = (op: CmpOp): ExprNode => (op === '!=' ? TRUE : FALSE);

function cmpColumn(op: CmpOp, o: Operand, c: Const): ExprNode {
  if (o.keys.length > 0) return untranslatable('keys on a scalar path');
  const col =
    o.canon === DIFF
      ? sql`(CAST(${column('end_time_unix_nano')} AS BIGINT) - CAST(${column('start_time_unix_nano')} AS BIGINT))`
      : column(o.pc.column);
  if (o.pc.kind === 'string') {
    if (o.canon === 'body.string') return untranslatable('body.string');
    if (typeof c !== 'string') return mismatch(op);
    return compare(op, o.pc.nullAsEmpty ? coalesce(col, literal('')) : col, literal(c));
  }
  if (o.pc.kind === 'int') {
    if (typeof c === 'bigint') {
      if (c < INT64_MIN || c > INT64_MAX) return untranslatable('integer literal beyond int64');
      const abs = isTime(o) ? sql`CAST(${col} AS BIGINT)` : col;
      return compare(op, o.pc.nullAsEmpty ? coalesce(abs, literal(0)) : abs, int64(c));
    }
    if (typeof c === 'number') {
      // Exact int vs double ordering is not expressible past 2^53; times are always past it.
      if (isTime(o) || !Number.isFinite(c) || Math.abs(c) >= SAFE)
        return untranslatable('double against an integer column');
      return compare(op, sql`CAST(${col} AS DOUBLE)`, literal(c));
    }
    return mismatch(op);
  }
  return untranslatable(`${o.pc.kind} column`);
}

/** Every leaf is a non-NULL boolean, so `not` and `!=` read as OTTL does for a missing key. */
function cmpJson(op: CmpOp, o: Operand, c: Const): ExprNode {
  const at = jsonOperand(o);
  const same = (positive: ExprNode): ExprNode =>
    op === '!=' ? not(coalesce(positive, FALSE)) : coalesce(positive, FALSE);
  const pos: CmpOp = op === '!=' ? '==' : op;
  if (typeof c === 'string') {
    // json_extract_string also renders numbers and booleans as text; OTTL compares strings to strings only.
    return same(
      bindOnce(at, 'v', (v) =>
        and(
          eq(jsonType(v), literal('VARCHAR')),
          compare(pos, sql`json_extract_string(${v}, '$')`, literal(c)),
        ),
      ),
    );
  }
  if (typeof c === 'bigint' || typeof c === 'number') {
    const n = Number(c);
    if (!Number.isFinite(n) || Math.abs(n) >= SAFE) return untranslatable('number beyond 2^53');
    // DuckDB orders NaN above everything and equal to itself; OTTL leaves it unordered.
    return same(
      bindOnce(jsonNumber(at), 'd', (d) => and(not(sql`isnan(${d})`), compare(pos, d, literal(n)))),
    );
  }
  if (typeof c === 'boolean') {
    if (pos !== '==') return op === '!=' ? TRUE : FALSE;
    return same(eq(at, verbatim(`'${c}'::JSON`)));
  }
  // nil: a missing key and a JSON null both read as nil.
  if (pos !== '==') return op === '!=' ? same(isNil(at)) : FALSE;
  return same(isNil(at));
}

const isNil = (at: ExprNode): ExprNode =>
  bindOnce(at, 'v', (v) => or(isNull(v), eq(jsonType(v), literal('NULL'))));

function translateCmp(e: Extract<Expr, { type: 'cmp' }>, context: SqlContext): ExprNode {
  let op = e.op;
  let path = operandOf(e.left, context);
  let c = constOf(e.right);
  if (path === undefined || c === undefined) {
    path = operandOf(e.right, context);
    c = constOf(e.left);
    op = FLIP[e.op];
  }
  if (path === undefined || c === undefined) return untranslatable('comparison is not path against constant');
  return path.pc.kind === 'json' ? cmpJson(op, path, c) : cmpColumn(op, path, c);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * JS (`u` flag) patterns that RE2 reads the same way: no lookaround, backreferences, `\s`, `\u`, `\x`, `\p`, no inline
 * group but `(?:` and a leading `(?i)`/`(?s)`, no repeat count past RE2's 1000. Known gap, accepted: `.` also stops
 * at `\r`, U+2028 and U+2029 in JS but only at `\n` in RE2.
 */
function re2Compatible(pattern: string): boolean {
  const body = pattern.replace(/^\(\?[is]+\)/, '');
  if (/\[[^\]]*\\b/.test(body)) return false; // `[\b]` is a backspace in JS, an error in RE2
  if (/\\[^dDwWbBnrtfv.\\^$|?*+()[\]{}/-]/.test(body)) return false;
  if (/\(\?(?!:)/.test(body)) return false;
  for (const m of body.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    if (Number(m[1]) > 1000 || Number(m[2] ?? 0) > 1000) return false;
  }
  return true;
}

function translateCall(v: Extract<Value, { type: 'call' }>, context: SqlContext): ExprNode {
  if (v.name === 'IsRootSpan') {
    if (context !== 'span') return untranslatable('IsRootSpan outside spans');
    return isNull(column('parent_span_id'));
  }
  const arg = v.args[0];
  if (arg === undefined) return untranslatable(`${v.name} without arguments`);
  const o = pathOf(arg, context);
  if (o === undefined) return untranslatable(`${v.name} of a non-path`);
  if (v.name === 'IsMatch') {
    const pattern = v.args[1];
    const re = pattern === undefined ? undefined : constOf(pattern);
    if (typeof re !== 'string' || !re2Compatible(re)) return untranslatable('IsMatch pattern');
    if (o.pc.kind === 'string') {
      if (o.canon === 'body.string') return untranslatable('body.string');
      if (o.keys.length > 0) return untranslatable('keys on a scalar path');
      return regexp_matches(coalesce(column(o.pc.column), literal('')), literal(re));
    }
    if (o.pc.kind === 'json') {
      return coalesce(
        bindOnce(jsonOperand(o), 'v', (v) =>
          and(
            eq(jsonType(v), literal('VARCHAR')),
            regexp_matches(sql`json_extract_string(${v}, '$')`, literal(re)),
          ),
        ),
        FALSE,
      );
    }
    return FALSE; // OTTL: a non-string subject never matches
  }
  const kinds: Readonly<Record<string, string>> = {
    IsString: 'string',
    IsInt: 'int',
    IsDouble: 'double',
    IsBool: 'bool',
    IsMap: 'map',
    IsList: 'list',
  };
  const kind = kinds[v.name];
  if (kind === undefined) return untranslatable(`converter ${v.name}`);
  if (o.pc.kind === 'json') {
    if (o.canon === 'body.string') return untranslatable('body.string');
    return coalesce(eq(jsonKind(jsonOperand(o)), literal(kind)), FALSE);
  }
  if (o.keys.length > 0) return untranslatable('keys on a scalar path');
  return o.pc.kind === (kind === 'string' ? 'string' : kind === 'int' ? 'int' : '') ? TRUE : FALSE;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function translateExpr(e: Expr, context: SqlContext): ExprNode {
  switch (e.type) {
    case 'and':
      return and(translateExpr(e.left, context), translateExpr(e.right, context));
    case 'or':
      return or(translateExpr(e.left, context), translateExpr(e.right, context));
    case 'not':
      return not(translateExpr(e.expr, context));
    case 'cmp':
      return translateCmp(e, context);
    case 'value': {
      const v = e.value;
      if (v.type === 'call') return translateCall(v, context);
      if (v.type === 'literal' && typeof v.value === 'boolean') return v.value ? TRUE : FALSE;
      const o = pathOf(v, context);
      if (o?.pc.kind === 'json') return cmpJson('==', o, true);
      return untranslatable('bare value');
    }
  }
}

function topTerms(e: Expr, out: Expr[] = []): Expr[] {
  if (e.type === 'and') {
    topTerms(e.left, out);
    topTerms(e.right, out);
  } else out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Pruning hints
// ---------------------------------------------------------------------------

interface Hint {
  readonly key: string;
  readonly values: ReadonlySet<string>;
}

/** The statistic texts a literal can match; zero is "0" and "-0" (a double -0 is stored as "-0", and 0 == -0.0). */
function hintText(c: Const | undefined, numeric: boolean): string[] | undefined {
  if (typeof c === 'string') return numeric ? undefined : [c];
  if (typeof c === 'bigint') {
    if (c === 0n) return ['0', '-0'];
    return c > -BigInt(SAFE) && c < BigInt(SAFE) ? [c.toString()] : undefined;
  }
  if (typeof c === 'number') {
    if (!Number.isFinite(c) || Math.abs(c) >= SAFE) return undefined;
    return c === 0 ? ['0', '-0'] : [String(c)];
  }
  if (typeof c === 'boolean') return numeric ? undefined : [String(c)];
  return undefined;
}

function eqHint(e: Expr, context: SqlContext): Hint | undefined {
  if (e.type !== 'cmp' || e.op !== '==') return undefined;
  const flipped = constOf(e.left) !== undefined;
  const o = pathOf(flipped ? e.right : e.left, context);
  const c = constOf(flipped ? e.left : e.right);
  if (o === undefined || c === undefined) return undefined;
  let key: string | undefined;
  let numeric = false;
  if (o.keys.length === 0) {
    if (o.canon === 'name' && context === 'span') key = 'name';
    else if (o.canon === 'metric.name' && context === 'datapoint') key = 'metric_name';
    else if (o.canon === 'instrumentation_scope.name') key = 'scope_name';
    else if (o.canon === 'severity_number' && context === 'log_record') {
      key = 'severity_number';
      numeric = true;
    }
  } else if (o.canon === 'resource.attributes' && o.keys.length === 1 && typeof o.keys[0] === 'string') {
    key = o.keys[0] === 'service.name' ? 'service_name' : `resource:${o.keys[0]}`;
  }
  // service_name is serviceName(resource): `unknown_service...` when service.name is absent, not a string or empty,
  // so only a non-empty string literal is a safe hint. Other resource keys store scalar texts (R16) as hintText gives.
  if (key === 'service_name' && (typeof c !== 'string' || c === '')) return undefined;
  const text = hintText(c, numeric);
  return key === undefined || text === undefined ? undefined : { key, values: new Set(text) };
}

function termHint(term: Expr, context: SqlContext): Hint | undefined {
  const alts: Expr[] = [];
  const walk = (x: Expr): void => {
    if (x.type === 'or') {
      walk(x.left);
      walk(x.right);
    } else alts.push(x);
  };
  walk(term);
  let key: string | undefined;
  const values = new Set<string>();
  for (const a of alts) {
    const h = eqHint(a, context);
    if (h === undefined || (key !== undefined && key !== h.key)) return undefined;
    key = h.key;
    for (const v of h.values) values.add(v);
  }
  return key === undefined ? undefined : { key, values };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Translate an OTTL condition. Throws the same `invalid-ottl` error `compileCondition` does for a condition that does
 * not compile; a term SQL cannot express exactly goes to `residual`.
 */
export function translateCondition(src: string, context: SqlContext): Translation {
  // Columns not marked nullAsEmpty in columns.ts are assumed always written (non-NULL) by the writer.
  compileCondition(src, context);
  const terms = topTerms(parseCondition(src));
  const predicates: ExprNode[] = [];
  const residual: Expr[] = [];
  const hints = new Map<string, Set<string>>();
  const reads = new Set<string>();
  for (const term of terms) {
    let p: ExprNode;
    const own = new Set<string>();
    readSink = own;
    try {
      p = translateExpr(term, context);
    } catch (e) {
      if (!(e instanceof Untranslatable)) throw e;
      residual.push(term);
      continue;
    } finally {
      readSink = null;
    }
    for (const k of own) reads.add(k);
    predicates.push(p);
    const h = termHint(term, context);
    if (h === undefined) continue;
    const prev = hints.get(h.key);
    hints.set(
      h.key,
      prev === undefined ? new Set(h.values) : new Set([...prev].filter((v) => h.values.has(v))),
    );
  }
  const rest = residual.reduce<Expr | null>(
    (acc, x) => (acc === null ? x : { type: 'and', left: acc, right: x }),
    null,
  );
  return {
    predicate:
      predicates.length === 0 ? null : predicates.length === 1 ? (predicates[0] ?? null) : and(...predicates),
    residual: rest === null ? null : printCondition(rest),
    hints,
    reads,
  };
}

const BODY_TEXT = sql`CASE WHEN json_type(${column('body')}) = 'VARCHAR' THEN json_extract_string(${column('body')}, '$') ELSE CAST(${column('body')} AS VARCHAR) END`;

/**
 * Case-insensitive contains over the signal's text fields (D10); the attribute fields are their JSON texts. Empty text
 * is null.
 */
export function textPredicate(text: string, context: SqlContext): ExprNode | null {
  if (text === '' || context === 'datapoint') return null;
  const needle = literal(text.toLowerCase());
  const hit = (field: ExprNode): ExprNode => contains(lower(coalesce(field, literal(''))), needle);
  const asText = (c: string): ExprNode => sql`CAST(${column(c)} AS VARCHAR)`;
  const fields =
    context === 'span'
      ? [column('name'), column('status_message'), asText('attributes'), asText('resource_attributes')]
      : [
          BODY_TEXT,
          column('severity_text'),
          column('event_name'),
          asText('attributes'),
          asText('resource_attributes'),
        ];
  return or(...fields.map(hit));
}
