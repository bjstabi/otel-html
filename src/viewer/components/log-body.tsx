import { type JSX, type ReactNode, useMemo, useState } from 'react';
import { type AnyValue, anyValueToDisplay, anyValueToJson } from '../../model/anyvalue.js';
import { formatBytes } from '../../semconv/formatters.js';
import { JsonTree } from './json-tree.js';

export type BodySegment =
  | { type: 'text'; text: string }
  | { type: 'kv'; key: string; value: string }
  | { type: 'json'; raw: string; value: unknown };

const KV = /([A-Za-z_][\w.-]*)=("(?:[^"\\\n]|\\.){0,1024}"|[^\s"]{1,4096})/y;
const WORD = /[\w.-]/;
/** Longest embedded JSON worth parsing; also bounds the cost of rescanning from every opener. */
const MAX_JSON = 16_384;
/** Total characters all JSON candidate scans of one call may read; a hostile body of openers cannot exceed it. */
const SCAN_BUDGET = 2_000_000;
/** Only this much of a body is segmented; the rest is plain text, so even "Show all" stays bounded. */
const MAX_SEGMENTED = 262_144;

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/** The end (exclusive) of the balanced `{…}` / `[…]` starting at `start`, or -1. Strings and escapes are honoured. */
function balancedEnd(s: string, start: number, budget: { left: number }): number {
  if (budget.left <= 0) return -1;
  const stop = Math.min(s.length, start + MAX_JSON, start + budget.left);
  budget.left -= stop - start;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < stop; i++) {
    const c = s.charAt(i);
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function tryJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Split a log line into plain text, `key=value` pairs and embedded JSON; the segments rejoin to `s` exactly. */
export function segmentBody(input: string): BodySegment[] {
  const budget = { left: SCAN_BUDGET };
  let s = input;
  let tail = '';
  if (s.length > MAX_SEGMENTED) {
    let at = MAX_SEGMENTED;
    if (isHigh(s.charCodeAt(at - 1))) at--;
    tail = s.slice(at);
    s = s.slice(0, at);
  }
  const out: BodySegment[] = [];
  let text = '';
  const flush = (): void => {
    if (text !== '') out.push({ type: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '{' || c === '[') {
      const end = balancedEnd(s, i, budget);
      if (end > 0) {
        const raw = s.slice(i, end);
        const parsed = tryJson(raw);
        if (parsed.ok) {
          flush();
          out.push({ type: 'json', raw, value: parsed.value });
          i = end;
          continue;
        }
      }
    } else if (i === 0 || !WORD.test(s.charAt(i - 1))) {
      KV.lastIndex = i;
      const m = KV.exec(s);
      if (m !== null && m[1] !== undefined && m[2] !== undefined) {
        flush();
        out.push({ type: 'kv', key: m[1], value: m[2] });
        i += m[0].length;
        continue;
      }
    }
    text += c;
    i++;
  }
  text += tail;
  flush();
  return out;
}

const JSON_TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]|\s+|[\s\S]/g;

/** Colour the tokens of already-valid JSON text. Every piece is a React text node. */
function JsonText(props: { raw: string }): JSX.Element {
  const parts: ReactNode[] = [];
  let n = 0;
  for (const m of props.raw.matchAll(JSON_TOKEN)) {
    const t = m[0];
    const key = `t${n++}`;
    if (m[1] !== undefined) {
      parts.push(
        <span key={key} className={m[2] === undefined ? 'oh-json-str' : 'oh-json-key'}>
          {m[1]}
        </span>,
      );
      if (m[2] !== undefined)
        parts.push(
          <span key={`${key}c`} className="oh-json-punct">
            {m[2]}
          </span>,
        );
    } else if (/^-?\d/.test(t)) {
      parts.push(
        <span key={key} className="oh-json-num">
          {t}
        </span>,
      );
    } else if (t === 'true' || t === 'false' || t === 'null') {
      parts.push(
        <span key={key} className="oh-json-other">
          {t}
        </span>,
      );
    } else if (/^[{}[\],:]$/.test(t)) {
      parts.push(
        <span key={key} className="oh-json-punct">
          {t}
        </span>,
      );
    } else parts.push(t);
  }
  return <>{parts}</>;
}

function Segments(props: { text: string }): JSX.Element {
  const segments = useMemo(() => segmentBody(props.text), [props.text]);
  return (
    <>
      {segments.map((g, i) => {
        const key = `s${i}`;
        if (g.type === 'text') return g.text;
        if (g.type === 'kv') {
          return (
            <span key={key}>
              <span className="oh-json-key">{g.key}</span>
              <span className="oh-json-punct">=</span>
              {g.value}
            </span>
          );
        }
        return (
          <span key={key}>
            <JsonText raw={g.raw} />
          </span>
        );
      })}
    </>
  );
}

const DEFAULT_MAX_CHARS = 16_384;

export function LogBody(props: {
  body: AnyValue;
  mode: 'raw' | 'wrapped';
  lines?: number;
  maxChars?: number;
}): JSX.Element {
  const [all, setAll] = useState(false);
  const { body } = props;
  const wrapped = props.mode === 'wrapped';
  const lines = props.lines ?? 1;
  const tree = body.kind === 'kvlist' || body.kind === 'array';
  const full = tree ? '' : anyValueToDisplay(body);
  const max = props.maxChars ?? DEFAULT_MAX_CHARS;
  const cut = !tree && !all && full.length > max;
  const size = useMemo(() => (cut ? formatBytes(new TextEncoder().encode(full).length) : ''), [cut, full]);

  if (tree) {
    return (
      <div className="overflow-hidden" style={wrapped ? { maxHeight: lines * 20 } : undefined}>
        <JsonTree data={anyValueToJson(body)} label="Log body" />
      </div>
    );
  }

  const shown = cut ? (isHigh(full.charCodeAt(max - 1)) ? full.slice(0, max - 1) : full.slice(0, max)) : full;
  const style = wrapped
    ? {
        display: '-webkit-box',
        WebkitLineClamp: lines,
        WebkitBoxOrient: 'vertical' as const,
        overflow: 'hidden',
      }
    : undefined;
  return (
    <span
      className={`block min-w-0 font-mono text-xs ${wrapped ? 'whitespace-pre-wrap break-words' : 'truncate whitespace-pre'}`}
      style={style}
    >
      {body.kind === 'string' ? <Segments text={shown} /> : shown}
      {cut ? (
        <>
          {'… '}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setAll(true);
            }}
            className="rounded-full border border-hairline bg-surface px-2 text-ink hover:bg-hairline"
          >
            {`Show all (${size})`}
          </button>
        </>
      ) : null}
    </span>
  );
}
