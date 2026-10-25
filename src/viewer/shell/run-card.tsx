import type { JSX } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { SIGNALS } from '../../format/paths.js';
import { parseUnixNanos } from '../../model/ids.js';
import { formatDuration } from '../../semconv/formatters.js';
import { absoluteTime } from './time-range.js';

const LABEL: Record<(typeof SIGNALS)[number], string> = { spans: 'Spans', logs: 'Logs', metrics: 'Metrics' };

export function RunCard({ manifest }: { manifest: Manifest }): JSX.Element {
  const epoch = parseUnixNanos(manifest.epochUnixNano, 'manifest.epochUnixNano');
  const range = manifest.range;
  return (
    <section aria-label="Run" className="rounded-card border border-hairline bg-surface p-3">
      <h2 className="text-sm font-semibold text-ink">{manifest.title}</h2>
      {range === null ? (
        <p className="mt-1 text-xs text-muted">No data recorded yet</p>
      ) : (
        <p className="mt-1 font-mono text-xs tabular-nums text-ink-2">
          {absoluteTime(range.start, epoch)} <span aria-hidden>→</span>
          <span className="sr-only">for</span> {formatDuration(range.end - range.start)}
        </p>
      )}
      <p className="mt-1 text-xs text-muted">{manifest.complete ? 'Complete' : 'Still recording'}</p>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
        {SIGNALS.map((s) => (
          <div key={s}>
            <dt className="text-muted">{LABEL[s]}</dt>
            <dd className="font-mono tabular-nums text-ink">{manifest.totals[s]}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
