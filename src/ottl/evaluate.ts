import type { CmpOp, MathOp } from './ast.js';
import type { OttlValue } from './contexts.js';

type Ord = -1 | 0 | 1;

function sign(n: number): Ord {
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}

/** Exact int64-vs-double ordering (no precision loss above 2^53). Undefined for NaN. */
function orderIntDouble(a: bigint, b: number): Ord | undefined {
  if (Number.isNaN(b)) return undefined;
  if (b === Number.POSITIVE_INFINITY) return -1;
  if (b === Number.NEGATIVE_INFINITY) return 1;
  const fl = Math.floor(b);
  const fb = BigInt(fl);
  if (a < fb) return -1;
  if (a > fb) return 1;
  return b > fl ? -1 : 0;
}

/** Ordering for comparable pairs; undefined when the pair is unordered or incomparable. */
function order(a: OttlValue, b: OttlValue): Ord | undefined {
  if (typeof a === 'bigint') {
    if (typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof b === 'number') return orderIntDouble(a, b);
    return undefined;
  }
  if (typeof a === 'number') {
    if (typeof b === 'number') return Number.isNaN(a) || Number.isNaN(b) ? undefined : sign(a - b);
    if (typeof b === 'bigint') {
      const o = orderIntDouble(b, a);
      return o === undefined ? undefined : (-o as Ord);
    }
    return undefined;
  }
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return undefined;
}

function equals(a: OttlValue, b: OttlValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return order(a, b) === 0;
}

/**
 * OTTL comparison: `nil` equals only `nil`; int and double compare numerically; strings
 * lexically; mismatched or uncomparable types make `==` false, `!=` true, and every
 * ordering comparison false (as does NaN).
 */
export function compareValues(op: CmpOp, a: OttlValue, b: OttlValue): boolean {
  switch (op) {
    case '==':
      return equals(a, b);
    case '!=':
      return !equals(a, b);
    case '<': {
      const o = order(a, b);
      return o !== undefined && o < 0;
    }
    case '<=': {
      const o = order(a, b);
      return o !== undefined && o <= 0;
    }
    case '>': {
      const o = order(a, b);
      return o !== undefined && o > 0;
    }
    case '>=': {
      const o = order(a, b);
      return o !== undefined && o >= 0;
    }
  }
}

function asDouble(v: bigint | number): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Int64 arithmetic wraps; int division by zero and non-numeric operands yield nil. */
export function mathValues(op: MathOp, a: OttlValue, b: OttlValue): OttlValue {
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    switch (op) {
      case '+':
        return BigInt.asIntN(64, a + b);
      case '-':
        return BigInt.asIntN(64, a - b);
      case '*':
        return BigInt.asIntN(64, a * b);
      case '/':
        return b === 0n ? null : BigInt.asIntN(64, a / b);
    }
  }
  if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number')) {
    const x = asDouble(a);
    const y = asDouble(b);
    switch (op) {
      case '+':
        return x + y;
      case '-':
        return x - y;
      case '*':
        return x * y;
      case '/':
        return x / y;
    }
  }
  return null;
}
