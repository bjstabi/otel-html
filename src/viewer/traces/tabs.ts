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
