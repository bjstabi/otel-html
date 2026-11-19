import type { JSX } from 'react';
import type { WidgetRenderer } from '../../dashboards/dashboard-page.js';
import { Sparkline } from '../../traces/sparkline.js';
import { type StatKind, stat } from '../derive.js';
import { useRunActions } from '../run-actions.js';
import { useCicd } from '../use-cicd.js';
import { CicdBody } from './body.js';

const MIN = 60_000_000_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** The length of the previous period as "7 days", "6 hours" or "30 minutes". */
export function lengthText(ns: number): string {
  if (ns >= DAY) return plural(Math.round(ns / DAY), 'day');
  if (ns >= HOUR) return plural(Math.round(ns / HOUR), 'hour');
  return plural(Math.max(1, Math.round(ns / MIN)), 'minute');
}

/** The statistic tiles: a value, its change against the same length before, and a sparkline for three of them. */
export const StatView: WidgetRenderer = ({ widget, scope }): JSX.Element => {
  const data = useCicd(widget, scope);
  const actions = useRunActions(widget.id);
  const kind: StatKind = widget.type === 'cicd' ? (widget.stat ?? 'success-rate') : 'success-rate';
  return (
    <>
      <CicdBody data={data}>
        {(runs) => {
          const s = stat(kind, runs, data.previous);
          const arrow = s.delta?.text.startsWith('+') ? '▲ ' : s.delta?.text.startsWith('−') ? '▼ ' : '';
          const tone =
            s.delta?.better === true
              ? 'text-good-ink'
              : s.delta?.better === false
                ? 'text-critical'
                : 'text-muted';
          const before = data.span === null ? null : lengthText(data.span[1] - data.span[0]);
          return (
            <div className="flex flex-col gap-1 p-3">
              <div className="whitespace-nowrap font-mono text-3xl text-ink">{s.value}</div>
              {s.delta !== null && (
                <div className={`text-sm ${tone}`}>
                  {arrow}
                  {s.delta.text.replace(/^[+−]/, '')}
                  {before === null ? '' : ` vs ${before} before`}
                </div>
              )}
              {s.note !== null && <div className="text-xs text-muted">{s.note}</div>}
              {s.spark !== null && <Sparkline values={s.spark} width={120} height={24} />}
            </div>
          );
        }}
      </CicdBody>
      {actions.element}
    </>
  );
};
