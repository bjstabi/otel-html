import { compileCondition } from '../../ottl/compile.js';
import { PAGE_OPTIONS, type Page } from './page-options.js';
import { type SelectionData, selectionToUrlState } from './selection.js';
import { formatWindow, type UrlState } from './url-state.js';

export interface DroppedParam {
  key: 'q';
  value: string;
  /** Why it does not apply on the target page (the OTTL compile error). */
  reason: string;
}

/**
 * The cross-signal carry-over rule. Within one page everything is kept. Between explorers only `t`, `text` and a
 * `q` that compiles in the target's OTTL context come along; mode, group, view, sort, trace, span, log and tabs
 * reset. Metrics and Dashboards have no OTTL context yet, so they keep everything.
 */
export function carryTo(
  s: SelectionData,
  from: Page | null,
  to: Page,
): { url: UrlState; dropped: DroppedParam[] } {
  if (from === to) return { url: selectionToUrlState(s), dropped: [] };
  switch (to) {
    case 'metrics':
    case 'dashboards':
      return { url: selectionToUrlState(s), dropped: [] };
    case 'traces':
    case 'logs': {
      const url: UrlState = {};
      const dropped: DroppedParam[] = [];
      if (s.text !== '') url.text = s.text;
      if (s.window !== null) url.t = formatWindow(s.window);
      if (s.condition !== null) {
        try {
          compileCondition(s.condition, PAGE_OPTIONS[to].context);
          url.q = s.condition;
        } catch (e) {
          dropped.push({ key: 'q', value: s.condition, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      return { url, dropped };
    }
  }
}
