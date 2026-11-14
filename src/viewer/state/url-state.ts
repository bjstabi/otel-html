import { z } from 'zod';
import { OtelHtmlError } from '../../model/errors.js';
import { parseSpanId, type SpanId } from '../../model/ids.js';
import { parseCondition } from '../../ottl/parse.js';
import { MetricPageStateSchema } from '../../query/metric-query.js';
import { EXPLORER_VIEWS, SELECTION_MODES } from '../../query/pages.js';
import { type LogRef, parseLogRef } from '../data/log-query.js';
import type { TimeWindow } from '../data/time-window.js';
import { LOG_TAB_IDS } from '../logs/tabs.js';
import { TRACE_TAB_IDS } from '../traces/tabs.js';
import { DashboardPageStateSchema, parseDashboardParam } from './dashboard-state.js';
import { parseMetricParam } from './metric-state.js';
import { T_ALL, T_FORMAT, TraceIdParamSchema, tRange, WindowParamSchema } from './param-schemas.js';

const MAX_INT64 = 2n ** 63n - 1n;
const LOG_FORMAT = /^\d+\.\d+$/;
const LOG_CANONICAL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const nonEmpty = z.string().min(1, 'a non-empty value');

function isOttl(s: string): boolean {
  try {
    parseCondition(s);
    return true;
  } catch {
    return false;
  }
}

/** Each field's failure message is the "expected ..." half of the reported error. */
const UrlStateSchema = z.object({
  q: nonEmpty.refine(isOttl, 'a valid OTTL condition'),
  text: nonEmpty,
  t: WindowParamSchema,
  mode: z.enum(SELECTION_MODES, `one of ${SELECTION_MODES.join(', ')}`),
  group: nonEmpty,
  view: z.enum(EXPLORER_VIEWS, `one of ${EXPLORER_VIEWS.join(', ')}`),
  trace: TraceIdParamSchema,
  span: z
    .string()
    .regex(/^[0-9a-f]{16}$/, '16 lowercase hex chars')
    .refine((s) => !/^0+$/.test(s), 'a non-zero span id')
    .transform((s): SpanId => parseSpanId(s, 'span')),
  tab: z.enum(TRACE_TAB_IDS, `one of ${TRACE_TAB_IDS.join(', ')}`),
  stab: nonEmpty,
  sort: nonEmpty,
  log: z
    .string()
    .regex(LOG_FORMAT, '<partition>.<row>')
    .refine((s) => !LOG_FORMAT.test(s) || LOG_CANONICAL.test(s), '<partition>.<row> without leading zeros')
    .transform((s): LogRef => parseLogRef(s, 'log')),
  ltab: z.enum(LOG_TAB_IDS, `one of ${LOG_TAB_IDS.join(', ')}`),
  // Arrives as JSON text, which `parseUrlState` decodes with `parseMetricParam`; this is the decoded shape.
  m: MetricPageStateSchema,
  // Same: decoded with `parseDashboardParam`.
  d: DashboardPageStateSchema,
});

const UrlStatePartial = UrlStateSchema.partial();
export type UrlState = z.output<typeof UrlStatePartial>;

export const URL_KEYS = [
  'q',
  'text',
  't',
  'mode',
  'group',
  'view',
  'trace',
  'span',
  'tab',
  'stab',
  'sort',
  'log',
  'ltab',
  'm',
  'd',
] as const;
export type UrlKey = (typeof URL_KEYS)[number];

function isUrlKey(k: string): k is UrlKey {
  return (URL_KEYS as readonly string[]).includes(k);
}

/**
 * Accepts `a=1&b=2`, `?a=1`, or a whole hash such as `#/traces?a=1` (a prefix is stripped only at the start).
 * A window is checked only for form and an int64 range; the caller reads it against the epoch or, on format 6, the anchor.
 */
export function parseUrlState(search: string): { state: UrlState; errors: string[] } {
  let query = search;
  if (search.startsWith('#')) {
    const qi = search.indexOf('?');
    query = qi >= 0 ? search.slice(qi + 1) : '';
  } else if (search.startsWith('?')) {
    query = search.slice(1);
  }
  const params = new URLSearchParams(query);
  const errors: string[] = [];
  const state: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    if (!isUrlKey(key)) {
      errors.push(`${key}: unknown parameter, got ${values.join(', ')}`);
      continue;
    }
    if (values.length > 1) {
      errors.push(`${key}: expected a single value, got ${values.length} values: ${values.join(', ')}`);
      continue;
    }
    const raw = values[0] ?? '';
    if (key === 'm') {
      const m = parseMetricParam(raw);
      if (m.ok) state[key] = m.state;
      else errors.push(m.error);
      continue;
    }
    if (key === 'd') {
      const d = parseDashboardParam(raw);
      if (d.ok) state[key] = d.state;
      else errors.push(d.error);
      continue;
    }
    const r = UrlStateSchema.shape[key].safeParse(raw);
    if (r.success) state[key] = r.data;
    else errors.push(`${key}: expected ${r.error.issues[0]?.message ?? 'a valid value'}, got ${raw}`);
  }
  return { state: UrlStatePartial.parse(state), errors };
}

export function serializeUrlState(s: UrlState): string {
  const p = new URLSearchParams();
  for (const k of URL_KEYS) {
    const v = s[k];
    if (v === undefined) continue;
    p.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  // `~` is a legal query character and keeps windows readable.
  return p.toString().replace(/%7E/g, '~');
}

/**
 * A window from its URL text. With an `anchor` (a format-6 report) the text is unix nanoseconds and the window is
 * relative to the anchor, rounded to the nearest double; it may start before the anchor.
 */
export function parseWindow(t: string, anchor?: bigint): TimeWindow {
  const m = T_FORMAT.exec(t);
  if (m === null || !tRange(t)) {
    throw new OtelHtmlError('usage', {
      path: 'window',
      expected:
        anchor === undefined
          ? `<start>~<end> in nanoseconds, start <= end, values <= ${MAX_INT64}`
          : '<start>~<end> in unix nanoseconds, start <= end',
      actual: JSON.stringify(t),
    });
  }
  if (anchor === undefined) return { start: Number(m[1]), end: Number(m[2]) };
  return { start: Number(BigInt(m[1] ?? '') - anchor), end: Number(BigInt(m[2] ?? '') - anchor) };
}

/** The URL text of a window; with an `anchor` (a format-6 report) absolute unix nanoseconds, else relative to the epoch. */
export function formatWindow(w: TimeWindow, anchor?: bigint): string {
  if (anchor !== undefined) {
    if (!(Number.isInteger(w.start) && Number.isInteger(w.end) && w.start <= w.end)) {
      throw new OtelHtmlError('usage', {
        path: 'window',
        expected: 'integers with start <= end',
        actual: `${w.start}~${w.end}`,
      });
    }
    const start = anchor + BigInt(w.start);
    const end = anchor + BigInt(w.end);
    if (start < 0n || end > MAX_INT64) {
      throw new OtelHtmlError('usage', {
        path: 'window',
        expected: `unix nanoseconds within 0..${MAX_INT64}`,
        actual: `${start}~${end}`,
      });
    }
    return `${start}~${end}`;
  }
  // Doubles past 2^53 are integers too: the text is exact for them and the parser reads back the nearest double.
  const ok =
    Number.isInteger(w.start) &&
    Number.isInteger(w.end) &&
    w.start >= 0 &&
    w.start <= w.end &&
    BigInt(w.end) <= MAX_INT64;
  if (!ok) {
    throw new OtelHtmlError('usage', {
      path: 'window',
      expected: `non-negative integers with start <= end, values <= ${MAX_INT64}`,
      actual: `${w.start}~${w.end}`,
    });
  }
  return `${BigInt(w.start)}~${BigInt(w.end)}`;
}

/**
 * The `t` text of a window. Without a fallback, the formatted window, or undefined for null. With the report's default
 * window as the fallback: null is `all`, a window equal to the fallback needs no `t`, any other is formatted.
 */
export function windowParam(
  window: TimeWindow | null,
  fallback: TimeWindow | null,
  anchor?: bigint,
): string | undefined {
  if (window === null) return fallback === null ? undefined : T_ALL;
  if (fallback !== null && window.start === fallback.start && window.end === fallback.end) return undefined;
  return formatWindow(window, anchor);
}

/** The window a `t` stands for: absent is the fallback, `all` the entire run (null), else the parsed window. */
export function windowFromParam(
  t: string | undefined,
  fallback: TimeWindow | null,
  anchor?: bigint,
): TimeWindow | null {
  if (t === undefined) return fallback;
  return t === T_ALL ? null : parseWindow(t, anchor);
}
