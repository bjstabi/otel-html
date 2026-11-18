import { type JSX, useMemo } from 'react';
import { menuTriggers } from '../../components/context-menu.js';
import type { WidgetRenderer } from '../../dashboards/dashboard-page.js';
import { useEpoch } from '../../dashboards/widgets/layout.js';
import { useSubtitle } from '../../dashboards/widgets/subtitle.js';
import { absoluteTime } from '../../shell/time-range.js';
import { failedRunCount, failures } from '../derive.js';
import { pointFromClick, useRunActions } from '../run-actions.js';
import { useCicd } from '../use-cicd.js';
import { CicdBody } from './body.js';

const LIMIT = 10;

/** The latest failed runs: when, title with trigger and branch, failed-job chips, a link to GitHub. */
export const FailuresView: WidgetRenderer = ({ widget, scope, dataSource, actions: page }): JSX.Element => {
  const data = useCicd(widget, scope);
  const actions = useRunActions(widget.id);
  const epoch = useEpoch(dataSource);
  const entries = useMemo(() => failures(data.runs, LIMIT), [data.runs]);
  const { openRun, runMenu, jobMenu, openOnGithub, selectedTraceId, isSource } = actions;
  const total = useMemo(() => failedRunCount(data.runs), [data.runs]);
  useSubtitle(
    page,
    data.status !== 'ready' || total === 0
      ? null
      : total > entries.length
        ? `latest ${entries.length} of ${total} failed runs`
        : `${total} failed ${total === 1 ? 'run' : 'runs'}`,
  );

  return (
    <>
      <CicdBody data={data}>
        {() =>
          entries.length === 0 ? (
            <div className="p-3 text-sm text-muted">No failed run in this range.</div>
          ) : (
            <ul className="text-sm">
              {entries.map(({ run, failed }) => {
                const mark = run.traceId === selectedTraceId;
                const ring = mark
                  ? isSource
                    ? 'outline outline-2 -outline-offset-2 outline-ink'
                    : 'outline outline-1 -outline-offset-1 outline-ink/35'
                  : '';
                const where = [run.trigger, run.branch].filter((x): x is string => x !== null).join(' · ');
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the title button is the keyboard target
                  <li
                    key={run.traceId}
                    data-failure={run.traceId}
                    {...(mark ? { 'data-run-ring': isSource ? 'full' : 'faint' } : {})}
                    className={`flex cursor-pointer items-start gap-3 border-b border-hairline px-3 py-2 hover:bg-page ${ring}`}
                    onClick={(e) => openRun(run, pointFromClick(e))}
                    {...menuTriggers((at) => runMenu(run, at))}
                  >
                    <span className="w-28 shrink-0 font-mono text-xs text-muted">
                      {absoluteTime(run.start, epoch)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <button type="button" className="block max-w-full truncate text-left text-ink">
                        {run.title ?? `Run ${run.runId}`}
                      </button>
                      {where !== '' && <span className="block truncate text-xs text-muted">{where}</span>}
                      {failed.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {failed.map((j) => (
                            <button
                              key={j.spanId ?? j.name}
                              type="button"
                              data-job-chip={j.name}
                              title={j.failedStep === null ? j.name : `${j.name}: failed at ${j.failedStep}`}
                              className="rounded-full border border-critical px-2 py-0.5 text-xs text-critical"
                              onClick={(e) => {
                                e.stopPropagation();
                                jobMenu(j.name, { x: e.clientX, y: e.clientY });
                              }}
                            >
                              {j.name}
                            </button>
                          ))}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      aria-label="Open on GitHub"
                      title="Open on GitHub"
                      className="shrink-0 text-muted hover:text-ink"
                      onClick={(e) => {
                        e.stopPropagation();
                        openOnGithub(run);
                      }}
                    >
                      ↗
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        }
      </CicdBody>
      {actions.element}
    </>
  );
};
