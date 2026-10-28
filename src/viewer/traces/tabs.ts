import type { SpanId } from '../../model/ids.js';
import type { SpanRecord } from '../../model/records.js';
import { StatusCode } from '../../model/records.js';
import type { TraceDetail } from '../data/data-source.js';

export const TRACE_TAB_IDS = [
  'flame',
  'waterfall',
  'spans',
  'services',
  'logs',
  'metrics',
  'errors',
] as const;
export type TraceTabId = (typeof TRACE_TAB_IDS)[number];

/** What a trace tab may depend on besides the trace. */
export interface TraceTabContext {
  /** One of the trace's resources has metric series in this report. */
  hasMetrics: boolean;
}

export interface TraceTab {
  id: TraceTabId;
  label: string;
  available(detail: TraceDetail, ctx: TraceTabContext): boolean;
}

export function isTraceTabId(s: string): s is TraceTabId {
  return (TRACE_TAB_IDS as readonly string[]).includes(s);
}

/** True when a span has an error status or an `exception` event (the Errors tab has something to show). */
export function hasErrorSpans(detail: TraceDetail): boolean {
  return detail.spans.some(
    (r) => r.span.status.code === StatusCode.ERROR || r.span.events.some((e) => e.name === 'exception'),
  );
}

/** Logs shows when the trace has logs; Metrics when its resources have metrics; Errors when a span failed. */
export const TRACE_TABS: readonly TraceTab[] = [
  { id: 'flame', label: 'Flame graph', available: () => true },
  { id: 'waterfall', label: 'Waterfall', available: () => true },
  { id: 'spans', label: 'Span list', available: () => true },
  { id: 'services', label: 'Services', available: () => true },
  { id: 'logs', label: 'Logs', available: (d) => d.logCount > 0 },
  { id: 'metrics', label: 'Metrics', available: (_d, ctx) => ctx.hasMetrics },
  { id: 'errors', label: 'Errors', available: hasErrorSpans },
];

export function availableTabs(detail: TraceDetail, ctx: TraceTabContext): readonly TraceTab[] {
  return TRACE_TABS.filter((t) => t.available(detail, ctx));
}

export const SPAN_TAB_IDS = ['overview', 'events', 'logs', 'metrics', 'links', 'resource'] as const;
export type SpanTabId = (typeof SPAN_TAB_IDS)[number];

/**
 * What a span tab may depend on besides the span: the ids of spans that emitted logs (null while they load or
 * after a failed load), the load error, if any, and whether the span's resource has metric series.
 */
export interface SpanTabContext {
  logSpanIds: ReadonlySet<SpanId> | null;
  logsError: string | null;
  hasMetrics: boolean;
}

export interface SpanTab {
  id: SpanTabId;
  label: string;
  available(span: SpanRecord, ctx: SpanTabContext): boolean;
}

export function isSpanTabId(s: string): s is SpanTabId {
  return (SPAN_TAB_IDS as readonly string[]).includes(s);
}

export const SPAN_TABS: readonly SpanTab[] = [
  { id: 'overview', label: 'Overview', available: () => true },
  { id: 'events', label: 'Events', available: (s) => s.events.length > 0 },
  {
    id: 'logs',
    label: 'Logs',
    available: (s, ctx) => ctx.logsError !== null || ctx.logSpanIds?.has(s.spanId) === true,
  },
  { id: 'metrics', label: 'Metrics', available: (_s, ctx) => ctx.hasMetrics },
  { id: 'links', label: 'Links', available: (s) => s.links.length > 0 },
  { id: 'resource', label: 'Resource', available: () => true },
];

export function availableSpanTabs(span: SpanRecord, ctx: SpanTabContext): readonly SpanTab[] {
  return SPAN_TABS.filter((t) => t.available(span, ctx));
}
