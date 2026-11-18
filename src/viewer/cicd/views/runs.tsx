import { type JSX, useMemo } from 'react';
import { Chart } from '../../components/chart.js';
import type { WidgetRenderer } from '../../dashboards/dashboard-page.js';
import { useTheme } from '../../theme/theme-provider.js';
import { durationText } from '../format.js';
import { useRunActions } from '../run-actions.js';
import type { CiRun } from '../runs.js';
import { useCicd } from '../use-cicd.js';
import {
  CicdBody,
  chartPx,
  currentSeries,
  escapeHtml,
  indexOf,
  pointOf,
  resultColors,
  ringSeries,
} from './body.js';
import { useRunKeys } from './run-keys.js';

const PLOT = { left: 44, right: 8 };

/** One bar per run, oldest first: height is the duration, colour the result, hollow when no task was replayed. */
export const RunsView: WidgetRenderer = ({ widget, scope, height }): JSX.Element => {
  const data = useCicd(widget, scope);
  const actions = useRunActions(widget.id);
  const { resolved } = useTheme();
  const runs = useMemo(() => [...data.runs].sort((a, b) => a.start - b.start), [data.runs]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `resolved` re-reads the colour tokens
  const colors = useMemo(resultColors, [resolved]);
  const { openRun, runMenu, selectedTraceId, isSource } = actions;
  const open = runs.findIndex((r) => r.traceId === selectedTraceId);
  const keys = useRunKeys(runs, actions, PLOT);
  const maxDuration = Math.max(1, ...runs.map((r) => r.duration));

  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: PLOT.left, right: PLOT.right, top: 8, bottom: 8 },
      tooltip: {
        trigger: 'item',
        formatter: (p: { dataIndex: number }) => {
          const r = runs[p.dataIndex];
          return r === undefined ? '' : tooltip(r);
        },
      },
      xAxis: { type: 'category', data: runs.map((r) => r.runId), show: false },
      yAxis: {
        type: 'value',
        max: maxDuration * 1.08,
        axisLabel: { formatter: (v: number) => durationText(v) },
      },
      series: [
        {
          type: 'bar',
          name: 'duration',
          barCategoryGap: '20%',
          cursor: 'pointer',
          data: runs.map((r) => {
            const color = colors[r.result];
            return {
              value: r.duration,
              itemStyle:
                r.cached === false ? { color: 'transparent', borderColor: color, borderWidth: 2 } : { color },
            };
          }),
        },
        ...(open < 0 ? [] : [ringSeries([open, runs[open]?.duration ?? 0], isSource, colors.ink)]),
        ...(keys.current === null
          ? []
          : [currentSeries([keys.current, runs[keys.current]?.duration ?? 0], colors.ink)]),
      ],
    }),
    [runs, colors, open, isSource, maxDuration, keys.current],
  );
  const onEvents = useMemo(
    () => ({
      click: (p: unknown) => {
        const i = indexOf(p);
        const r = i === null ? undefined : runs[i];
        if (r !== undefined) openRun(r, pointOf(p));
      },
      contextmenu: (p: unknown) => {
        const i = indexOf(p);
        const r = i === null ? undefined : runs[i];
        if (r === undefined) return;
        const e = (p as { event?: { event?: { preventDefault?(): void } } }).event?.event;
        e?.preventDefault?.();
        runMenu(r, pointOf(p));
      },
    }),
    [runs, openRun, runMenu],
  );
  return (
    <>
      <CicdBody data={data}>
        {() => (
          <div
            role="application"
            {...keys.props}
            aria-label="Run durations: Left and Right choose a run, Enter opens it"
            className="rounded focus-visible:outline focus-visible:outline-2"
          >
            <Chart option={option} onEvents={onEvents} height={chartPx(height)} ariaLabel="Run durations" />
            {keys.live}
          </div>
        )}
      </CicdBody>
      {actions.element}
    </>
  );
};

function tooltip(r: CiRun): string {
  const lines = [
    `<b>${escapeHtml(r.title ?? `Run ${r.runId}`)}</b>`,
    `${r.result} · ${durationText(r.duration)}${r.attempt > 1 ? ` · attempt ${r.attempt}` : ''}`,
    [r.trigger, r.branch]
      .filter((x): x is string => x !== null)
      .map(escapeHtml)
      .join(' · '),
    r.cached === null ? '' : r.cached ? 'tasks replayed' : 'no task replayed',
  ];
  return lines.filter((l) => l !== '').join('<br/>');
}
