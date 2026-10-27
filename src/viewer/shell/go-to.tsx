import { createContext, useContext } from 'react';
import { OtelHtmlError } from '../../model/errors.js';
import type { UrlPatch } from '../state/carry.js';
import type { Page } from '../state/page-options.js';

/**
 * Go to an explorer route through the carry-over rule (`carryTo`), then apply `extra` on top, for example
 * `{ q: 'trace_id.string == "…"', log }` from a cross-link (`null` removes a key). The shell provides it; every
 * explorer jump uses it.
 */
export type GoTo = (page: Page, route: string, extra?: UrlPatch) => void;

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
