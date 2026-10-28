import { z } from 'zod';
import { OtelHtmlError } from '../../model/errors.js';
import { parseSpanId, parseTraceId, type SpanId, type TraceId } from '../../model/ids.js';
import { parseCondition } from '../../ottl/parse.js';
import { MetricPageStateSchema } from '../../query/metric-query.js';
import { EXPLORER_VIEWS, SELECTION_MODES } from '../../query/pages.js';
import { type LogRef, parseLogRef } from '../data/log-query.js';
import type { TimeWindow } from '../data/span-query.js';
import { LOG_TAB_IDS } from '../logs/tabs.js';
import { TRACE_TAB_IDS } from '../traces/tabs.js';
import { parseMetricParam } from './metric-state.js';

const T_FORMAT = /^(\d+)~(\d+)$/;
const LOG_FORMAT = /^\d+\.\d+$/;
const LOG_CANONICAL = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const nonEmpty = z.string().min(1, 'a non-empty value');

function isOttl(s: string): boolean {
  try {
    parseCondition(s);
    return true;
  } catch {
    return false;
  }
}

function tRange(s: string): boolean {
  const m = T_FORMAT.exec(s);
  if (m === null) return true; // the regex check reports the format problem
  const a = BigInt(m[1] ?? '');
  const b = BigInt(m[2] ?? '');
  return a <= b && b <= MAX_SAFE;
}

/** Each field's failure message is the "expected ..." half of the reported error. */
export const UrlStateSchema = z.object({
  q: nonEmpty.refine(isOttl, 'a valid OTTL condition'),
  text: nonEmpty,
  t: z
    .string()
    .regex(T_FORMAT, '<start>~<end> in nanoseconds')
    .refine(tRange, `<start>~<end> with start <= end and values <= ${Number.MAX_SAFE_INTEGER}`),
  mode: z.enum(SELECTION_MODES, `one of ${SELECTION_MODES.join(', ')}`),
  group: nonEmpty,
  view: z.enum(EXPLORER_VIEWS, `one of ${EXPLORER_VIEWS.join(', ')}`),
  trace: z
    .string()
    .regex(/^[0-9a-f]{32}$/, '32 lowercase hex chars')
    .refine((s) => !/^0+$/.test(s), 'a non-zero trace id')
    .transform((s): TraceId => parseTraceId(s, 'trace')),
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
    .regex(LOG_FORMAT, '<chunk>.<row>')
    .refine((s) => !LOG_FORMAT.test(s) || LOG_CANONICAL.test(s), '<chunk>.<row> without leading zeros')
    .transform((s): LogRef => parseLogRef(s, 'log')),
  ltab: z.enum(LOG_TAB_IDS, `one of ${LOG_TAB_IDS.join(', ')}`),
  // Arrives as JSON text, which `parseUrlState` decodes with `parseMetricParam`; this is the decoded shape.
  m: MetricPageStateSchema,
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
] as const;
export type UrlKey = (typeof URL_KEYS)[number];

function isUrlKey(k: string): k is UrlKey {
  return (URL_KEYS as readonly string[]).includes(k);
}

/** Accepts `a=1&b=2`, `?a=1`, or a whole hash such as `#/traces?a=1` (a prefix is stripped only at the start). */
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

export function parseWindow(t: string): TimeWindow {
  const m = T_FORMAT.exec(t);
  if (m === null || !tRange(t)) {
    throw new OtelHtmlError('usage', {
      path: 'window',
      expected: `<start>~<end> in nanoseconds, start <= end, values <= ${Number.MAX_SAFE_INTEGER}`,
      actual: JSON.stringify(t),
    });
  }
  return { start: Number(m[1]), end: Number(m[2]) };
}

export function formatWindow(w: TimeWindow): string {
  const ok = Number.isSafeInteger(w.start) && Number.isSafeInteger(w.end) && w.start >= 0 && w.start <= w.end;
  if (!ok) {
    throw new OtelHtmlError('usage', {
      path: 'window',
      expected: 'non-negative safe integers with start <= end',
      actual: `${w.start}~${w.end}`,
    });
  }
  return `${w.start}~${w.end}`;
}
