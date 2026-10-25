import { OtelHtmlError } from '../model/errors.js';
import type { OttlContextName, OttlValue, Target } from './contexts.js';

export interface ConverterSpec {
  readonly arity: number;
  /** Contexts the converter is available in; all when omitted. */
  readonly contexts?: readonly OttlContextName[];
  readonly returns: 'bool' | 'int';
  /**
   * Compile-time argument check. `constants[i]` is the argument's value when it is a
   * literal/enum, else undefined. Throws OtelHtmlError('invalid-ottl') using `col`.
   */
  validate?(constants: readonly (OttlValue | undefined)[], col: number): void;
  call(args: readonly OttlValue[], target: Target): OttlValue;
}

// ---------------------------------------------------------------------------
// Regex: user patterns run on the JS (backtracking) engine, while OTTL users expect
// Go RE2 (linear time). We therefore accept only an RE2-like subset: no
// lookaround or backreferences, and no unbounded quantifier applied to a group that
// itself contains an unbounded quantifier (the classic `(a+)+` blow-up). Pattern
// length is capped. Alternation overlap such as `(a|a)*` is not detected.
// ---------------------------------------------------------------------------

const MAX_PATTERN_LENGTH = 512;
const REGEX_CACHE_LIMIT = 256;
const regexCache = new Map<string, RegExp>();

function regexProblem(p: string): string | undefined {
  // Frame per open group: whether it contains an unbounded quantifier.
  const stack: boolean[] = [false];
  let lastAtomUnboundedGroup = false;
  let i = 0;
  const markTop = (): void => {
    stack[stack.length - 1] = true;
  };
  while (i < p.length) {
    const c = p.charAt(i);
    if (c === '\\') {
      const n = p.charAt(i + 1);
      if ((n >= '1' && n <= '9') || n === 'k') return 'backreferences are not supported';
      lastAtomUnboundedGroup = false;
      i += 2;
      continue;
    }
    if (c === '[') {
      i++;
      if (p.charAt(i) === '^') i++;
      // JS semantics: a ']' right after '[' or '[^' closes the class ([] is empty, [^] is any).
      while (i < p.length && p.charAt(i) !== ']') i += p.charAt(i) === '\\' ? 2 : 1;
      lastAtomUnboundedGroup = false;
      i++;
      continue;
    }
    if (c === '(') {
      if (p.charAt(i + 1) === '?') {
        const k = p.charAt(i + 2);
        if (k === '=' || k === '!' || (k === '<' && (p.charAt(i + 3) === '=' || p.charAt(i + 3) === '!')))
          return 'lookaround is not supported';
      }
      stack.push(false);
      lastAtomUnboundedGroup = false;
      i++;
      continue;
    }
    if (c === ')') {
      const inner = stack.length > 1 ? stack.pop() === true : false;
      if (inner) markTop();
      lastAtomUnboundedGroup = inner;
      i++;
      continue;
    }
    let unbounded = false;
    let len = 1;
    if (c === '*' || c === '+') unbounded = true;
    else if (c === '{') {
      const m = /^\{\d+(,\d*)?\}/.exec(p.slice(i));
      if (m !== null) {
        len = m[0].length;
        unbounded = m[1] === ',';
      } else {
        lastAtomUnboundedGroup = false;
        i++;
        continue;
      }
    } else if (c !== '?') {
      lastAtomUnboundedGroup = false;
      i++;
      continue;
    }
    if (unbounded) {
      if (lastAtomUnboundedGroup)
        return 'nested unbounded repetition (e.g. "(a+)+") can backtrack catastrophically; use bounded repetition like {1,64}';
      markTop();
    }
    lastAtomUnboundedGroup = false;
    i += len;
  }
  return undefined;
}

function compileRegex(pattern: string, col: number): RegExp {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  const fail = (actual: string, hint?: string): never => {
    throw new OtelHtmlError('invalid-ottl', {
      path: `col ${col}`,
      expected: 'a valid regular expression',
      actual,
      ...(hint === undefined ? {} : { hint }),
    });
  };
  if (pattern.length > MAX_PATTERN_LENGTH)
    fail(`pattern too long (${pattern.length} > ${MAX_PATTERN_LENGTH} chars)`);
  // Go-style leading flag group, the only inline-flag form worth translating.
  let body = pattern;
  let flags = 'u';
  const lead = /^\(\?([is]+)\)/.exec(pattern);
  if (lead !== null) {
    body = pattern.slice(lead[0].length);
    if (lead[1]?.includes('i')) flags += 'i';
    if (lead[1]?.includes('s')) flags += 's';
  }
  const problem = regexProblem(body);
  if (problem !== undefined) fail(JSON.stringify(pattern), problem);
  let re: RegExp;
  try {
    re = new RegExp(body, flags);
  } catch (e) {
    return fail(`invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (regexCache.size >= REGEX_CACHE_LIMIT) regexCache.clear();
  regexCache.set(pattern, re);
  return re;
}

function isMatch(args: readonly OttlValue[]): OttlValue {
  const [subject, pattern] = args;
  if (typeof subject !== 'string' || typeof pattern !== 'string') return false;
  return compileRegex(pattern, 1).test(subject);
}

const utf8 = new TextEncoder();

export const CONVERTERS: ReadonlyMap<string, ConverterSpec> = new Map<string, ConverterSpec>([
  [
    'IsMatch',
    {
      arity: 2,
      returns: 'bool',
      validate(constants, col) {
        const p = constants[1];
        if (typeof p !== 'string')
          throw new OtelHtmlError('invalid-ottl', {
            path: `col ${col}`,
            expected: 'IsMatch pattern to be a string literal',
            actual: 'a non-constant value',
          });
        compileRegex(p, col);
      },
      call: isMatch,
    },
  ],
  [
    'IsRootSpan',
    {
      arity: 0,
      contexts: ['span'],
      returns: 'bool',
      call: (_args, target) => 'span' in target && target.span.parentSpanId === null,
    },
  ],
  ['IsString', { arity: 1, returns: 'bool', call: ([v]) => typeof v === 'string' }],
  ['IsInt', { arity: 1, returns: 'bool', call: ([v]) => typeof v === 'bigint' }],
  ['IsDouble', { arity: 1, returns: 'bool', call: ([v]) => typeof v === 'number' }],
  ['IsBool', { arity: 1, returns: 'bool', call: ([v]) => typeof v === 'boolean' }],
  ['IsMap', { arity: 1, returns: 'bool', call: ([v]) => v instanceof Map }],
  ['IsList', { arity: 1, returns: 'bool', call: ([v]) => Array.isArray(v) }],
  [
    'Len',
    {
      arity: 1,
      returns: 'int',
      // Strings count UTF-8 bytes, as Go's len does in the Collector.
      call([v]) {
        if (typeof v === 'string') return BigInt(utf8.encode(v).length);
        if (v instanceof Uint8Array) return BigInt(v.length);
        if (v instanceof Map) return BigInt(v.size);
        if (Array.isArray(v)) return BigInt(v.length);
        return null;
      },
    },
  ],
]);
