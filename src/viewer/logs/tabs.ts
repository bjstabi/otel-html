import type { LogRow } from '../data/log-query.js';

/** Log panel tabs, in display order; the first is the default. */
export const LOG_TAB_IDS = ['attributes', 'trace', 'metrics', 'surrounding', 'resource'] as const;
export type LogTabId = (typeof LOG_TAB_IDS)[number];

export function isLogTabId(s: string): s is LogTabId {
  return (LOG_TAB_IDS as readonly string[]).includes(s);
}

export interface LogTabContext {
  /** The log's trace has spans in this report. */
  hasTrace: boolean;
  /** The log's resource has metric series in this report. */
  hasMetrics: boolean;
}

export interface LogTab {
  id: LogTabId;
  label: string;
  available(row: LogRow, ctx: LogTabContext): boolean;
}

/** The log panel's tabs as data; `Trace` needs spans in the report to show, `Metrics` series on the log's resource. */
export const LOG_TABS: readonly LogTab[] = [
  { id: 'attributes', label: 'Attributes', available: () => true },
  { id: 'trace', label: 'Trace', available: (_row, ctx) => ctx.hasTrace },
  { id: 'metrics', label: 'Metrics', available: (_row, ctx) => ctx.hasMetrics },
  { id: 'surrounding', label: 'Surrounding logs', available: () => true },
  { id: 'resource', label: 'Resource', available: () => true },
];

export function availableLogTabs(row: LogRow, ctx: LogTabContext): readonly LogTab[] {
  return LOG_TABS.filter((t) => t.available(row, ctx));
}
