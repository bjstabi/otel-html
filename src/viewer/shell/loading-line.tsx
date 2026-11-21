import type { JSX } from 'react';
import { LoadingIndicator } from '../components/explorer-states.js';
import type { LoadProgress } from '../data/open-report.js';

/** The loading line for each phase of `LoadProgress`. */
function progressText(p: LoadProgress | null): string {
  if (p === null) return 'Loading report';
  switch (p.phase) {
    case 'engine':
      return 'Starting the query engine';
    case 'partitions':
      return p.total === undefined || p.done === undefined
        ? 'Loading partitions'
        : `Loading partition ${Math.min(p.done + 1, p.total)} of ${p.total}`;
    case 'views':
      return 'Preparing views';
    case 'host':
      return 'Connecting to the host';
  }
}

/**
 * Two placements: `page` stands alone before the manifest is read; `pill` floats at the bottom of the viewport over
 * the page while the engine starts. Never inside a `main`: the e2e suite treats a `main` as "the page", and its
 * report-loaded wait reads the `aria-label`. The deploy preview (`preview.mjs`) waits for a `main` with no
 * `[aria-busy="true"]` in the document, so the line is `aria-busy` for as long as it shows.
 */
export function LoadingLine({
  progress,
  placement = 'page',
}: {
  progress: LoadProgress | null;
  placement?: 'page' | 'pill';
}): JSX.Element {
  const classes =
    placement === 'pill'
      ? 'fixed bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-hairline bg-surface px-3 py-1.5 text-sm text-muted shadow'
      : 'p-8 text-sm text-muted';
  return (
    <p role="status" aria-busy="true" aria-label="Loading the report" className={classes}>
      <LoadingIndicator />
      {progressText(progress)}
    </p>
  );
}
