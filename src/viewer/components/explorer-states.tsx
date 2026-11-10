import type { JSX } from 'react';
import { GoneNotice } from '../shell/in-progress.js';
import type { ColumnUi } from '../traces/columns.js';
import type { SortState } from './results-table.js';

/** The explorers' shared pill-button class. */
export const PILL = 'rounded-full px-3 py-1 text-sm';

/** `column:dir`, as stored in the selection; anything that is not a sortable column of this mode is `fallback`. */
export function parseSort(raw: string | null, sortable: readonly string[], fallback: SortState): SortState {
  if (raw === null) return fallback;
  const at = raw.lastIndexOf(':');
  const column = raw.slice(0, at);
  const dir = raw.slice(at + 1);
  if (at <= 0 || (dir !== 'asc' && dir !== 'desc') || !sortable.includes(column)) return fallback;
  return { column, dir };
}

/** The data-layer sort columns a set of columns offers. */
export function sortableOf(columns: readonly ColumnUi<never>[]): string[] {
  return columns.flatMap((c) => (c.sort === undefined ? [] : [c.sort]));
}

/** `gone`: the failure is a registered file the site no longer serves (D56), so Refresh is offered. */
export function ErrorCard(props: { title: string; message: string; gone?: boolean }): JSX.Element {
  return (
    <div role="alert" className="rounded-card border border-hairline bg-surface p-4">
      <p className="font-semibold text-critical">{props.title}</p>
      <p className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-ink-2">{props.message}</p>
      {props.gone === true && <GoneNotice />}
    </div>
  );
}

/**
 * What a running or finished query says about itself: "Loading" while it runs, and (D5) that part of the filter was
 * evaluated in the browser instead of the query engine; nothing otherwise.
 */
export function QueryNote(props: { loading: boolean; residual: string | null }): JSX.Element | null {
  if (!props.loading && props.residual === null) return null;
  return (
    <div className="flex flex-col gap-1">
      {props.residual !== null && (
        <p role="status" aria-label="Evaluated in the browser" className="text-sm text-ink-2">
          Evaluated in the browser: {props.residual}
        </p>
      )}
      {props.loading && (
        <p role="status" className="text-sm text-muted">
          Loading
        </p>
      )}
    </div>
  );
}

/** The loading note of a query that has not answered yet. */
export function LoadingNote(): JSX.Element {
  return (
    <p role="status" className="text-sm text-muted">
      Loading
    </p>
  );
}

/** The empty result: `No <noun> match`, with a way out when the caller has one (`onClear`). */
export function NoMatch(props: {
  noun: string;
  onClear?: () => void;
  /** `h3` inside a card that has its own `h2` (a dashboard widget). */
  heading?: 'h2' | 'h3';
}): JSX.Element {
  const Heading = props.heading ?? 'h2';
  return (
    <section className="rounded-card border border-hairline bg-surface p-6">
      <Heading className="text-base font-semibold">No {props.noun} match</Heading>
      <p className="mt-1 text-sm text-ink-2">Nothing in this run matches the current filters.</p>
      {props.onClear !== undefined && (
        <button type="button" onClick={props.onClear} className={`${PILL} mt-3 bg-ink text-surface`}>
          Clear filters
        </button>
      )}
    </section>
  );
}
