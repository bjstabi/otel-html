import { type JSX, useMemo, useState } from 'react';
import { Chart } from '../../components/chart.js';
import type { WidgetRenderer } from '../../dashboards/dashboard-page.js';
import { useEpoch } from '../../dashboards/widgets/layout.js';
import { useSubtitle } from '../../dashboards/widgets/subtitle.js';
import { useTheme } from '../../theme/theme-provider.js';
import { minutesPerDay } from '../derive.js';
import { useRunActions } from '../run-actions.js';
import { useCicd } from '../use-cicd.js';
import { CicdBody, chartPx, escapeHtml } from './body.js';

type By = 'trigger' | 'job';
const OTHER = 'Other';
const NO_TRIGGER = '(none)';
const BYS: readonly By[] = ['trigger', 'job'];
const SERIES_TOKENS = 7;

const minutesText = (m: number): string => (m >= 100 ? `${Math.round(m)}` : m.toFixed(1));

/** The series colours as resolved strings (a canvas chart cannot resolve `var()`): the series tokens, grey for Other. */
function seriesColors(keys: readonly string[]): string[] {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string): string => style.getPropertyValue(name).trim() || 'gray';
  return keys.map((k, i) =>
    k === OTHER || i >= SERIES_TOKENS ? token('--oh-series-other') : token(`--oh-series-${i + 1}`),
  );
}

/**
 * CI minutes per day as stacked bars, by trigger or by job (the top 7 plus Other). The legend is HTML so that an item
 * can open its menu. The view has no per-run mark, so the open run has no ring here.
 */
export const MinutesView: WidgetRenderer = ({
  widget,
  scope,
  height,
  dataSource,
  actions: page,
}): JSX.Element => {
  const data = useCicd(widget, scope);
  const actions = useRunActions(widget.id);
  const epoch = useEpoch(dataSource);
  const { resolved } = useTheme();
  const [by, setBy] = useState<By>(widget.type === 'cicd' ? widget.by : 'trigger');
  const result = useMemo(() => minutesPerDay(data.runs, by, epoch), [data.runs, by, epoch]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `resolved` re-reads the colour tokens
  const colors = useMemo(() => seriesColors(result.keys), [result.keys, resolved]);
  const total = result.days.reduce((s, d) => s + d.total, 0);
  useSubtitle(
    page,
    data.status === 'ready' && result.days.length > 0 ? `${minutesText(total)} min by ${by}` : null,
  );

  const option = useMemo(
    () => ({
      animation: false,
      color: colors,
      grid: { left: 44, right: 8, top: 8, bottom: 24 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (ps: { dataIndex: number }[]) => {
          const day = result.days[ps[0]?.dataIndex ?? -1];
          if (day === undefined) return '';
          const lines = day.parts
            .filter((p) => p.minutes > 0)
            .map((p) => `${escapeHtml(p.key)}: ${minutesText(p.minutes)} min`);
          return [
            `<b>${new Date(day.day).toLocaleDateString()}</b> · ${minutesText(day.total)} min`,
            ...lines,
          ].join('<br/>');
        },
      },
      xAxis: {
        type: 'category',
        data: result.days.map((d) =>
          new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        ),
        axisLabel: { hideOverlap: true },
      },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${v} min` } },
      series: result.keys.map((key, k) => ({
        type: 'bar',
        name: key,
        stack: 'minutes',
        barCategoryGap: '25%',
        data: result.days.map((d) => d.parts[k]?.minutes ?? 0),
      })),
    }),
    [result, colors],
  );

  return (
    <>
      <CicdBody data={data}>
        {() => (
          <div className="flex flex-col gap-1 px-3 pt-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <fieldset aria-label="Stack by" className="m-0 flex gap-1 border-0 p-0">
                {BYS.map((b) => (
                  <button
                    key={b}
                    type="button"
                    data-by={b}
                    aria-pressed={by === b}
                    onClick={() => setBy(b)}
                    className="rounded-full border border-hairline px-2 py-0.5 text-xs text-muted aria-[pressed=true]:bg-hairline aria-[pressed=true]:text-ink"
                  >
                    {b === 'trigger' ? 'by trigger' : 'by job'}
                  </button>
                ))}
              </fieldset>
              <ul aria-label="Legend" className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs">
                {result.keys.map((key, i) => {
                  const swatch = (
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: colors[i] }}
                    />
                  );
                  return (
                    <li key={key}>
                      {key === OTHER || (by === 'trigger' && key === NO_TRIGGER) ? (
                        <span data-legend={key} className="flex items-center gap-1 text-muted">
                          {swatch}
                          {key}
                        </span>
                      ) : (
                        <button
                          type="button"
                          data-legend={key}
                          title={key}
                          className="flex max-w-40 items-center gap-1 hover:text-ink"
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            const at = { x: r.left, y: r.bottom };
                            if (by === 'trigger') actions.triggerMenu(key, at);
                            else actions.jobMenu(key, at);
                          }}
                        >
                          {swatch}
                          <span className="truncate">{key}</span>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
            <Chart option={option} height={chartPx(height, 40)} ariaLabel={`CI minutes per day by ${by}`} />
          </div>
        )}
      </CicdBody>
      {actions.element}
    </>
  );
};
