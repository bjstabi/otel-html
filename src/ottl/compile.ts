import { OtelHtmlError } from '../model/errors.js';
import type { Expr, Value } from './ast.js';
import {
  CONTEXTS,
  type ContextSpec,
  ENUMS,
  type OttlContextName,
  type OttlValue,
  type TargetMap,
} from './contexts.js';
import { CONVERTERS } from './converters.js';
import { compareValues, mathValues } from './evaluate.js';
import { parseCondition } from './parse.js';

export interface CompiledCondition<C extends OttlContextName> {
  readonly source: string;
  test(target: TargetMap[C]): boolean;
}

/**
 * Real nesting (parentheses, `not`, converter arguments) beyond this is rejected.
 * and/or chains and arithmetic chains are flattened iteratively and cost no depth,
 * so the compiler and the closures it builds never recurse deeper than this.
 */
const MAX_DEPTH = 200;

function fail(col: number, message: string): never {
  throw new OtelHtmlError('invalid-ottl', { message: `col ${col}: ${message}` });
}

type Getter<T> = (t: T) => OttlValue;
/** Whether a value is statically known to be boolean (yes), not (no), or only known at runtime (maybe). */
type Boolness = 'yes' | 'no' | 'maybe';
interface CompiledValue<T> {
  readonly get: Getter<T>;
  readonly bool: Boolness;
}

class Compiler<C extends OttlContextName> {
  constructor(private readonly spec: ContextSpec<C>) {}

  private deep(depth: number, col: number): void {
    if (depth > MAX_DEPTH) fail(col, `expression nested too deeply (more than ${MAX_DEPTH} levels)`);
  }

  expr(e: Expr, depth: number): (t: TargetMap[C]) => boolean {
    this.deep(depth, 1);
    switch (e.type) {
      case 'and':
      case 'or': {
        const terms: Expr[] = [];
        let cur: Expr = e;
        while (cur.type === e.type) {
          terms.push(cur.right);
          cur = cur.left;
        }
        terms.push(cur);
        terms.reverse();
        const fns = terms.map((x) => this.expr(x, depth + 1));
        const isAnd = e.type === 'and';
        return (t) => {
          for (const f of fns) if (f(t) !== isAnd) return !isAnd;
          return isAnd;
        };
      }
      case 'not': {
        const f = this.expr(e.expr, depth + 1);
        return (t) => !f(t);
      }
      case 'cmp': {
        const l = this.value(e.left, depth + 1, 1).get;
        const r = this.value(e.right, depth + 1, 1).get;
        const op = e.op;
        return (t) => compareValues(op, l(t), r(t));
      }
      case 'value': {
        const v = this.value(e.value, depth + 1, 1);
        if (v.bool === 'no')
          throw new OtelHtmlError('invalid-ottl', {
            path: `col ${valueCol(e.value)}`,
            expected: 'a boolean expression',
            actual: 'a non-boolean value',
          });
        const g = v.get;
        return (t) => g(t) === true;
      }
    }
  }

  value(v: Value, depth: number, col: number): CompiledValue<TargetMap[C]> {
    this.deep(depth, col);
    switch (v.type) {
      case 'literal': {
        const x = v.value;
        return { get: () => x, bool: typeof x === 'boolean' ? 'yes' : 'no' };
      }
      case 'enum': {
        const n = ENUMS.get(v.name);
        if (n === undefined)
          throw new OtelHtmlError('invalid-ottl', {
            path: `col ${v.from + 1}`,
            expected: 'a known enum',
            actual: JSON.stringify(v.name),
          });
        return { get: () => n, bool: 'no' };
      }
      case 'path':
        return this.path(v);
      case 'call':
        return this.call(v, depth);
      case 'math': {
        const rights: { op: typeof v.op; f: Getter<TargetMap[C]> }[] = [];
        let cur: Value = v;
        while (cur.type === 'math') {
          rights.push({ op: cur.op, f: this.value(cur.right, depth + 1, col).get });
          cur = cur.left;
        }
        rights.reverse();
        const first = this.value(cur, depth + 1, col).get;
        return {
          bool: 'no',
          get: (t) => {
            let acc = first(t);
            for (const { op, f } of rights) acc = mathValues(op, acc, f(t));
            return acc;
          },
        };
      }
    }
  }

  private path(v: Extract<Value, { type: 'path' }>): CompiledValue<TargetMap[C]> {
    const col = v.from + 1;
    const written = v.segments.join('.');
    const segs =
      v.segments.length > 1 && v.segments[0] === this.spec.prefix ? v.segments.slice(1) : v.segments;
    const acc = this.spec.paths.get(segs.join('.'));
    if (acc === undefined)
      throw new OtelHtmlError('invalid-ottl', {
        path: `col ${col}`,
        expected: `a ${this.spec.name} path`,
        actual: JSON.stringify(written),
      });
    if (v.keys.length > 0 && acc.type !== 'map' && acc.type !== 'any')
      fail(col, `path "${written}" does not take keys`);
    const keys = v.keys;
    const bool = v.keys.length > 0 || acc.type === 'any' ? 'maybe' : acc.type === 'bool' ? 'yes' : 'no';
    return { get: (t) => acc.get(t, keys), bool };
  }

  private call(v: Extract<Value, { type: 'call' }>, depth: number): CompiledValue<TargetMap[C]> {
    const col = v.from + 1;
    const spec = CONVERTERS.get(v.name);
    if (spec === undefined)
      throw new OtelHtmlError('invalid-ottl', {
        path: `col ${col}`,
        expected: 'a known converter',
        actual: JSON.stringify(v.name),
      });
    if (spec.contexts !== undefined && !spec.contexts.includes(this.spec.name))
      fail(col, `${v.name} is not available in ${this.spec.name} conditions`);
    if (v.args.length !== spec.arity)
      fail(col, `${v.name}: expected ${spec.arity} arguments, got ${v.args.length}`);
    const args = v.args.map((a) => this.value(a, depth + 1, col).get);
    spec.validate?.(
      v.args.map((a) =>
        a.type === 'literal' ? a.value : a.type === 'enum' ? (ENUMS.get(a.name) ?? undefined) : undefined,
      ),
      col,
    );
    const call = spec.call;
    return {
      bool: spec.returns === 'bool' ? 'yes' : 'no',
      get: (t) =>
        call(
          args.map((a) => a(t)),
          t,
        ),
    };
  }
}

function valueCol(v: Value): number {
  return v.type === 'path' || v.type === 'call' || v.type === 'enum' ? v.from + 1 : 1;
}

export function compileCondition<C extends OttlContextName>(src: string, context: C): CompiledCondition<C> {
  const ast = parseCondition(src);
  const test = new Compiler(CONTEXTS[context]).expr(ast, 0);
  return { source: src, test };
}

/** filterprocessor semantics: matches (drops) if any condition matches; no conditions never match. */
export function compileAny<C extends OttlContextName>(
  conditions: readonly string[],
  context: C,
): CompiledCondition<C> {
  const compiled = conditions.map((src, i) => {
    try {
      return compileCondition(src, context);
    } catch (e) {
      if (e instanceof OtelHtmlError)
        throw new OtelHtmlError(e.code, {
          ...(e.path === undefined ? {} : { path: `conditions[${i}] ${e.path}` }),
          ...(e.expected === undefined ? {} : { expected: e.expected }),
          ...(e.actual === undefined ? {} : { actual: e.actual }),
          ...(e.hint === undefined ? {} : { hint: e.hint }),
          ...(e.path === undefined ? { message: `conditions[${i}] ${e.message}` } : {}),
        });
      throw e;
    }
  });
  return {
    source: conditions.join('\n'),
    test: (t) => {
      for (const c of compiled) if (c.test(t)) return true;
      return false;
    },
  };
}
