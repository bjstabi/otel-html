import type { JSX } from 'react';
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

/** Never a `main`: the e2e suite treats a `main` as "the report loaded", and the pages render their own. */
export function LoadingLine({ progress }: { progress: LoadProgress | null }): JSX.Element {
  return (
    <p role="status" aria-label="Loading the report" className="p-8 text-sm text-muted">
      {progressText(progress)}
    </p>
  );
}
