import type { JSX } from 'react';
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

export function ErrorCard(props: { title: string; message: string }): JSX.Element {
  return (
    <div role="alert" className="rounded-card border border-hairline bg-surface p-4">
      <p className="font-semibold text-critical">{props.title}</p>
      <p className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-ink-2">{props.message}</p>
    </div>
  );
}

/** A windowed scan that stopped early: how much it read, and a way to read everything. */
export function PartialNote(props: {
  partial: { scanned: number; total: number } | null;
  onScanAll(): void;
}): JSX.Element | null {
  const { partial } = props;
  if (partial === null) return null;
  return (
    <p role="status" aria-label="Partial results" className="text-sm text-ink-2">
      <span className="font-mono tabular-nums">
        from {partial.scanned} of {partial.total} chunks
      </span>{' '}
      <span aria-hidden>·</span>{' '}
      <button
        type="button"
        onClick={props.onScanAll}
        className="rounded-full px-2 py-0.5 text-accent underline"
      >
        Scan entire run
      </button>
    </p>
  );
}

/** "Loading", or how far a chunk scan has got. */
export function LoadingNote(props: { progress: { scanned: number; total: number } | null }): JSX.Element {
  return (
    <p role="status" className="text-sm text-muted">
      {props.progress === null
        ? 'Loading'
        : `Scanning ${props.progress.scanned} of ${props.progress.total} chunks`}
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
