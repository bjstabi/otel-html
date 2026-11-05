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
// Go RE2 (linear time). We therefore accept only an RE2-like subset: no lookaround,
// backreferences or inline flag groups (a leading `(?i)`/`(?s)` is the only flag form). A repeated
// group (maximum above 1) that holds a variable quantifier (`*`, `+`, `{n,}`, `{n,m}` with m > n)
// or an optional item (`?`, `{0,n}`)
// is accepted only when, inside it: every variable quantifier is on a single-character atom
// (never a group) that is followed, looking through subgroup ends, by a mandatory single literal
// the atom cannot match, as in `(\d+\.){3}`; no `|` sits on the path down to a variable atom; and
// every optional item is a single literal the next atom cannot match, as in `(-?\d+,)+`. That
// pins where each repeat ends, so the split is unique and cannot blow up like `(a+)+`.
// Pattern length is capped. Not detected (tracked in #195): overlapping alternation with no
// quantifier inside the repeated group, as in `(a|aa)+`, and long chains of variable atoms outside
// any repeated group, as in `.*.*.*.*x`.
// ---------------------------------------------------------------------------

const MAX_PATTERN_LENGTH = 512;
const REGEX_CACHE_LIMIT = 256;
const regexCache = new Map<string, RegExp>();

const NESTED_REPETITION =
  'nested repetition (e.g. "(a+)+" or "(a+){2}") can backtrack catastrophically; put a literal the repeated part cannot match after it, like (\\d+\\.){3}, or repeat a class instead, like [a-z]{1,64}';

const INLINE_FLAGS = 'inline flag groups are not supported; use a leading (?i) or (?s)';

interface Quant {
  readonly min: number;
  readonly max: number;
}

/** One element of a pattern sequence, with its source span (`start` to `end`, quantifier excluded). */
interface Item {
  readonly kind: 'atom' | 'group' | 'alt' | 'anchor';
  readonly start: number;
  end: number;
  readonly children: Item[];
  /** The single character an atom stands for when it is a plain or identity-escaped one. */
  readonly literal: string | undefined;
  q: Quant | undefined;
}

const SPECIAL = '^$\\.*+?()[]{}|';
const IDENTITY_ESCAPES = `${SPECIAL}/`;
const ESCAPE = /^\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\}|[pP]\{[^}]*\}|c[A-Za-z]|.)/su;
const QUANTIFIER = /^(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})\??/;

function item(kind: Item['kind'], start: number, end: number, literal?: string): Item {
  return { kind, start, end, children: [], literal, q: undefined };
}

/** The pattern as an item tree, or the reason it is not supported. */
function parseRegex(p: string): Item | string {
  const root = item('group', 0, p.length);
  const stack: Item[] = [root];
  const top = (): Item => stack[stack.length - 1] ?? root;
  let i = 0;
  while (i < p.length) {
    const c = p.charAt(i);
    const seq = top().children;
    if (c === '\\') {
      const n = p.charAt(i + 1);
      if ((n >= '1' && n <= '9') || n === 'k') return 'backreferences are not supported';
      const len = ESCAPE.exec(p.slice(i))?.[0].length ?? 1;
      const identity = len === 2 && IDENTITY_ESCAPES.includes(n);
      seq.push(item('atom', i, i + len, identity ? n : undefined));
      i += len;
    } else if (c === '[') {
      const start = i++;
      if (p.charAt(i) === '^') i++;
      // JS semantics: a ']' right after '[' or '[^' closes the class ([] is empty, [^] is any).
      while (i < p.length && p.charAt(i) !== ']') i += p.charAt(i) === '\\' ? 2 : 1;
      i = Math.min(i + 1, p.length);
      seq.push(item('atom', start, i));
    } else if (c === '(') {
      const k = p.charAt(i + 2);
      let open = 1;
      if (p.charAt(i + 1) === '?') {
        if (k !== ':' && k !== '<' && k !== '=' && k !== '!') return INLINE_FLAGS;
        if (k === '=' || k === '!' || (k === '<' && (p.charAt(i + 3) === '=' || p.charAt(i + 3) === '!')))
          return 'lookaround is not supported';
        open = k === '<' ? Math.max(p.indexOf('>', i), i + 2) - i + 1 : 3;
      }
      const g = item('group', i, p.length);
      seq.push(g);
      stack.push(g);
      i += open;
    } else if (c === ')') {
      if (stack.length > 1) {
        const g = stack.pop();
        if (g !== undefined) g.end = i + 1;
      }
      i++;
    } else if (c === '|') {
      seq.push(item('alt', i, i + 1));
      i++;
    } else if (c === '^' || c === '$') {
      seq.push(item('anchor', i, i + 1));
      i++;
    } else if (c === '.') {
      seq.push(item('atom', i, i + 1));
      i++;
    } else {
      const m = QUANTIFIER.exec(p.slice(i));
      if (m === null) {
        const cp = String.fromCodePoint(p.codePointAt(i) ?? 0);
        seq.push(item('atom', i, i + cp.length, SPECIAL.includes(cp) ? undefined : cp));
        i += cp.length;
        continue;
      }
      // A quantifier applies to the previous item (the group just closed, when it follows a ')').
      const prev = seq[seq.length - 1];
      const min = m[1] === '+' ? 1 : Number(m[2] ?? 0);
      let max: number;
      if (m[1] === '*' || m[1] === '+') max = Number.POSITIVE_INFINITY;
      else if (m[1] === '?') max = 1;
      else if (m[3] === undefined) max = min;
      else max = m[4] === '' || m[4] === undefined ? Number.POSITIVE_INFINITY : Number(m[4]);
      if (prev !== undefined && (prev.kind === 'atom' || prev.kind === 'group') && prev.q === undefined)
        prev.q = { min, max };
      i += m[0].length;
    }
  }
  return root;
}

const isVariable = (q: Quant | undefined): boolean => q !== undefined && q.max > 1 && q.min < q.max;

/** Whether `it` or anything inside it is a variable quantifier or an optional (minimum 0) item. */
const hasLoose = (it: Item): boolean => isVariable(it.q) || it.q?.min === 0 || it.children.some(hasLoose);

/** Whether `a` is a single literal character that the single-character atom `x` cannot match. */
function disjoint(p: string, flags: string, x: Item, literal: string | undefined): boolean {
  if (literal === undefined) return false;
  try {
    return !new RegExp(`^(?:${p.slice(x.start, x.end)})$`, flags).test(literal);
  } catch {
    return false;
  }
}

/** Whether `follow` is a mandatory single literal that the quantified atom `x` cannot match. */
function safeFollower(p: string, flags: string, x: Item, follow: Item | undefined): boolean {
  if (follow === undefined || follow.kind !== 'atom' || follow.literal === undefined) return false;
  if (follow.q !== undefined && follow.q.min === 0) return false;
  return disjoint(p, flags, x, follow.literal);
}

/** An optional item is a single literal that the (mandatory) single-character atom after it cannot match. */
function safeOptional(p: string, flags: string, it: Item, follow: Item | undefined): boolean {
  if (it.kind !== 'atom' || follow === undefined || follow.kind !== 'atom') return false;
  if (follow.q !== undefined && follow.q.min === 0) return false;
  return disjoint(p, flags, follow, it.literal);
}

/**
 * Inside a repeated group that holds a variable quantifier: no `|`, no variable quantifier on a
 * group, every variable quantifier has a safe follower and every optional item a safe successor.
 * `outer` follows the sequence's group.
 */
function repeatSafe(p: string, flags: string, items: readonly Item[], outer: Item | undefined): boolean {
  return items.every((it, i) => {
    if (it.kind === 'alt') return false;
    const follow = items[i + 1] ?? outer;
    if (it.q !== undefined && it.q.min === 0 && !safeOptional(p, flags, it, follow)) return false;
    if (it.kind === 'group') {
      if (isVariable(it.q)) return false;
      return !hasLoose(it) || repeatSafe(p, flags, it.children, follow);
    }
    return !isVariable(it.q) || safeFollower(p, flags, it, follow);
  });
}

/** Whether some repeated group contains a variable quantifier without the structure `repeatSafe` needs. */
function hasUnsafeRepeat(p: string, flags: string, it: Item): boolean {
  if (it.kind !== 'group') return false;
  if (
    it.q !== undefined &&
    it.q.max > 1 &&
    it.children.some(hasLoose) &&
    !repeatSafe(p, flags, it.children, undefined)
  )
    return true;
  return it.children.some((c) => hasUnsafeRepeat(p, flags, c));
}

function regexProblem(p: string, flags: string): string | undefined {
  const tree = parseRegex(p);
  if (typeof tree === 'string') return tree;
  return hasUnsafeRepeat(p, flags, tree) ? NESTED_REPETITION : undefined;
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
  const problem = regexProblem(body, flags);
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
