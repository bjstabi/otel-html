import { type JSX, useMemo } from 'react';
import type { WidgetRenderer } from '../../dashboards/dashboard-page.js';
import { useSubtitle } from '../../dashboards/widgets/subtitle.js';
import { type TriggerRow, triggers } from '../derive.js';
import { useRunActions } from '../run-actions.js';
import { useCicd } from '../use-cicd.js';
import { CicdBody } from './body.js';

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** "all 4" when every job it ever started always ran, else "k of N always". */
const alwaysText = (t: TriggerRow): string =>
  t.always === t.jobs ? `all ${t.jobs}` : `${t.always} of ${t.jobs} always`;

/** A chip's text: the job's name, or how many jobs share the share. */
const chipText = (names: readonly string[], share: number): string =>
  names.length === 1 ? `${names[0]} ${percent(share)}` : `${names.length} jobs ${percent(share)}`;

/** Per trigger: runs, passed share, the jobs it always starts, and chips for those it starts only some of the time. */
export const TriggersView: WidgetRenderer = ({ widget, scope, actions: page }): JSX.Element => {
  const data = useCicd(widget, scope);
  const actions = useRunActions(widget.id);
  const rows = useMemo(() => triggers(data.runs), [data.runs]);
  const most = Math.max(1, ...rows.map((r) => r.runs));
  useSubtitle(
    page,
    data.status === 'ready' && rows.length > 0
      ? `${rows.length} ${rows.length === 1 ? 'trigger' : 'triggers'}`
      : null,
  );
  return (
    <>
      <CicdBody data={data}>
        {() => (
          <ul className="text-sm">
            {rows.map((t) => (
              <li key={t.trigger} data-trigger={t.trigger} className="border-b border-hairline px-3 py-2">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    data-trigger-name
                    className="w-32 shrink-0 truncate text-left text-ink"
                    title={t.trigger}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      actions.triggerMenu(t.trigger, { x: r.left, y: r.bottom });
                    }}
                  >
                    {t.trigger}
                  </button>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="h-2 flex-1 rounded-sm bg-hairline">
                      <span
                        className="block h-2 rounded-sm bg-accent"
                        style={{ width: `${((t.runs / most) * 100).toFixed(1)}%` }}
                      />
                    </span>
                    <span className="w-10 text-right font-mono text-xs">{t.runs}</span>
                  </span>
                  <span
                    className="w-12 text-right font-mono text-xs"
                    title="runs that passed, cancelled left out"
                  >
                    {percent(t.passedShare)}
                  </span>
                  <span className="w-24 shrink-0 text-right text-xs text-muted">{alwaysText(t)}</span>
                </div>
                {t.chips.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1 pl-[8.75rem]">
                    {t.chips.map((c) => (
                      <span
                        key={c.count}
                        title={`${c.names.join(', ')}: in ${c.count} of ${t.runs} runs`}
                        className="rounded-full border border-hairline px-2 py-0.5 text-xs text-muted"
                      >
                        {chipText(c.names, c.share)}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CicdBody>
      {actions.element}
    </>
  );
};
