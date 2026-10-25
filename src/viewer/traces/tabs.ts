import type { SpanRecord } from '../../model/records.js';
import { StatusCode } from '../../model/records.js';
import type { TraceDetail } from '../data/data-source.js';

export const TRACE_TAB_IDS = ['flame', 'waterfall', 'spans', 'services', 'errors'] as const;
export type TraceTabId = (typeof TRACE_TAB_IDS)[number];

export interface TraceTab {
  id: TraceTabId;
  label: string;
  available(detail: TraceDetail): boolean;
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

/** The `logs` tab is added in M2. */
export const TRACE_TABS: readonly TraceTab[] = [
  { id: 'flame', label: 'Flame graph', available: () => true },
  { id: 'waterfall', label: 'Waterfall', available: () => true },
  { id: 'spans', label: 'Span list', available: () => true },
  { id: 'services', label: 'Services', available: () => true },
  { id: 'errors', label: 'Errors', available: hasErrorSpans },
];

export function availableTabs(detail: TraceDetail): readonly TraceTab[] {
  return TRACE_TABS.filter((t) => t.available(detail));
}

export const SPAN_TAB_IDS = ['overview', 'events', 'links', 'resource'] as const;
export type SpanTabId = (typeof SPAN_TAB_IDS)[number];

export interface SpanTab {
  id: SpanTabId;
  label: string;
  available(span: SpanRecord): boolean;
}

export function isSpanTabId(s: string): s is SpanTabId {
  return (SPAN_TAB_IDS as readonly string[]).includes(s);
}

/** The `logs` and `metrics` tabs are added in M2 and M3. */
export const SPAN_TABS: readonly SpanTab[] = [
  { id: 'overview', label: 'Overview', available: () => true },
  { id: 'events', label: 'Events', available: (s) => s.events.length > 0 },
  { id: 'links', label: 'Links', available: (s) => s.links.length > 0 },
  { id: 'resource', label: 'Resource', available: () => true },
];

export function availableSpanTabs(span: SpanRecord): readonly SpanTab[] {
  return SPAN_TABS.filter((t) => t.available(span));
}
