import { OtelHtmlError } from '../../model/errors.js';
import { compileCondition } from '../../ottl/compile.js';
import { PAGE_OPTIONS, type Page } from './page-options.js';
import { type SelectionData, selectionToUrlState } from './selection.js';
import { formatWindow, URL_KEYS, type UrlKey, type UrlState } from './url-state.js';

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
          if (!(e instanceof OtelHtmlError && e.code === 'invalid-ottl')) throw e;
          dropped.push({ key: 'q', value: s.condition, reason: e.message });
        }
      }
      return { url, dropped };
    }
  }
}

/** URL changes applied on top of a carried state: a value sets the key, `null` removes it. */
export type UrlPatch = { [K in keyof UrlState]?: UrlState[K] | null };

function patchKey<K extends UrlKey>(out: UrlState, k: K, v: UrlState[K] | null | undefined): void {
  if (v === null) delete out[k];
  else if (v !== undefined) out[k] = v;
}

export function applyPatch(url: UrlState, patch: UrlPatch): UrlState {
  const out: UrlState = { ...url };
  for (const k of URL_KEYS) patchKey(out, k, patch[k]);
  return out;
}
