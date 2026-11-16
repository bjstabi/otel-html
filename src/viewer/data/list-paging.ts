import { translateCondition } from '../../query/sql/ottl.js';

/**
 * The one rule for which lists page: the data source reads a page and a `next` cursor for them, and the viewer asks for
 * a page of rows and loads the rest on scroll. Every other list is one statement of the viewer's whole `listCap`.
 */

/** The residual of a condition (the terms only the browser can evaluate), or null; an invalid condition counts as one (it fails when it runs). */
export function residualOf(condition: string | null, context: 'span' | 'log_record'): string | null {
  if (condition === null || condition.trim() === '') return null;
  try {
    return translateCondition(condition, context).residual;
  } catch {
    return condition;
  }
}

/**
 * A spans list pages when it is start-sorted and either has no residual or reads it through an id table (`idTable`: the
 * statement also asks an aggregate, so the browser's re-check ran first and the page reads the ids it kept). A trace list
 * pages only with no residual, and not under a long window (`longWindow`), which the trace-by-start rules take over.
 * The viewer passes `idTable: false`: a page after the first asks `rows` alone, which re-checks in the browser and has
 * no cursor, so a list with a residual is one statement of `listCap` rows.
 */
export function pagesSpanList(q: {
  mode: 'spans' | 'traces';
  sortColumn: string;
  residual: string | null;
  idTable: boolean;
  longWindow: boolean;
}): boolean {
  if (q.sortColumn !== 'start') return false;
  if (q.mode === 'traces') return q.residual === null && !q.longWindow;
  return q.residual === null || q.idTable;
}

/** A logs list pages in logs mode, time-sorted, with no residual or one read through an id table (see `pagesSpanList`). Patterns and the trace grouping never page. */
export function pagesLogList(q: {
  mode: string;
  sortColumn: string;
  residual: string | null;
  idTable: boolean;
}): boolean {
  return q.mode === 'logs' && q.sortColumn === 'time' && (q.residual === null || q.idTable);
}
