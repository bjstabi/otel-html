import { type JSX, useMemo } from 'react';
import { formatDuration } from '../../../semconv/formatters.js';
import type { WidgetRenderer } from '../../dashboards/dashboard-page.js';
import { useSubtitle } from '../../dashboards/widgets/subtitle.js';
import { queue } from '../derive.js';
import { useRunActions } from '../run-actions.js';
import { useCicd } from '../use-cicd.js';
import { CicdBody } from './body.js';

const NO_LABEL = '(no label)';

/**
 * Per runner label: the p50 to p95 queue wait as a range bar, a tick at the longest wait, and the job count. The
 * view has no per-run mark, so the open run has no ring here.
 */
export const QueueView: WidgetRenderer = ({ widget, scope, actions: page }): JSX.Element => {
  const data = useCicd(widget, scope);
  const actions = useRunActions(widget.id);
  const rows = useMemo(() => queue(data.runs), [data.runs]);
  const longest = Math.max(1, ...rows.map((r) => r.max));
  useSubtitle(
    page,
    data.status === 'ready' && rows.length > 0
      ? `${rows.length} ${rows.length === 1 ? 'label' : 'labels'}`
      : null,
  );
  const pct = (v: number): string => `${((v / longest) * 100).toFixed(2)}%`;
  return (
    <>
      <CicdBody data={data}>
        {() =>
          rows.length === 0 ? (
            <div className="p-3 text-sm text-muted">No runner label has 5 jobs in this range.</div>
          ) : (
            <ul className="text-sm">
              {rows.map((r) => (
                <li
                  key={r.label}
                  data-queue-label={r.label}
                  className="flex items-center gap-3 border-b border-hairline px-3 py-2"
                >
                  <button
                    type="button"
                    className={`w-40 shrink-0 truncate text-left ${r.label === NO_LABEL ? 'cursor-default text-muted' : 'text-ink'}`}
                    title={r.label}
                    onClick={(e) => {
                      if (r.label === NO_LABEL) return;
                      const b = e.currentTarget.getBoundingClientRect();
                      actions.runnerMenu(r.label, { x: b.left, y: b.bottom });
                    }}
                  >
                    {r.label}
                  </button>
                  <span
                    className="relative h-3 flex-1 rounded-sm bg-hairline/40"
                    title={`p50 ${formatDuration(r.p50)}, p95 ${formatDuration(r.p95)}, longest ${formatDuration(r.max)}`}
                  >
                    <span
                      className="absolute inset-y-0.5 rounded-sm bg-accent"
                      style={{
                        left: pct(r.p50),
                        width: `max(2px, calc(${pct(r.p95)} - ${pct(r.p50)}))`,
                      }}
                    />
                    <span className="absolute inset-y-0 w-px bg-ink" style={{ left: pct(r.max) }} />
                  </span>
                  <span className="w-44 shrink-0 text-right font-mono text-xs text-muted">
                    {formatDuration(r.p50)} – {formatDuration(r.p95)} · n {r.n}
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </CicdBody>
      {actions.element}
    </>
  );
};
