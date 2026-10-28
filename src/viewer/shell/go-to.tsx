import { createContext, useContext } from 'react';
import { OtelHtmlError } from '../../model/errors.js';
import type { DroppedParam, UrlPatch } from '../state/carry.js';
import type { Page } from '../state/page-options.js';

/**
 * Go to an explorer route through the carry-over rule (`carryTo`), then apply `extra` on top, for example
 * `{ q: 'trace_id.string == "…"', log }` from a cross-link (`null` removes a key). The shell provides it; every
 * explorer jump uses it. `dropped` adds filters the caller could not carry (a metric chart's click menu) to the
 * shell's "not carried over" notice.
 */
export type GoTo = (page: Page, route: string, extra?: UrlPatch, dropped?: readonly DroppedParam[]) => void;

export const GoToContext = createContext<GoTo | null>(null);

export function useGoTo(): GoTo {
  const goTo = useContext(GoToContext);
  if (goTo === null)
    throw new OtelHtmlError('usage', {
      path: 'useGoTo',
      expected: 'a <Shell> ancestor (GoToContext provider)',
      actual: 'no provider',
    });
  return goTo;
}
