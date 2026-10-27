/** Log panel tabs, in display order; the first is the default. */
export const LOG_TAB_IDS = ['attributes', 'trace', 'surrounding', 'resource'] as const;
export type LogTabId = (typeof LOG_TAB_IDS)[number];

export function isLogTabId(s: string): s is LogTabId {
  return (LOG_TAB_IDS as readonly string[]).includes(s);
}
