import { type JSX, useEffect, useMemo, useRef } from 'react';
import { formatDuration } from '../../../semconv/formatters.js';
import { Chart } from '../../components/chart.js';
import { useContextMenu } from '../../components/context-menu.js';
import type { WidgetRenderer } from '../../dashboards/dashboard-page.js';
import { useEpoch } from '../../dashboards/widgets/layout.js';
import { absoluteTime } from '../../shell/time-range.js';
import { useTheme } from '../../theme/theme-provider.js';
import { trendBuckets } from '../derive.js';
import { useRunActions } from '../run-actions.js';
import { useCicd } from '../use-cicd.js';
import { CicdBody, chartPx, indexOf, pointOf, resultColors } from './body.js';
import { lengthText } from './stat.js';

const MIN = 60_000_000_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "5 min", "1 hour", "2 days", "1 week": the bucket step in words. */
function stepText(step: number): string {
  if (step >= 7 * DAY) {
    const w = Math.round(step / (7 * DAY));
    return step % (7 * DAY) === 0 ? `${w} ${w === 1 ? 'week' : 'weeks'}` : lengthText(step);
  }
  if (step >= HOUR || step % MIN !== 0 || step < MIN) return lengthText(step);
  return `${Math.round(step / MIN)} min`;
}

/** p50 and p95 run duration over stacked passed, failed and cancelled counts per bucket. */
export const RunsTrendView: WidgetRenderer = ({
  widget,
  scope,
  height,
  dataSource,
  actions: page,
}): JSX.Element => {
  const data = useCicd(widget, scope);
  const actions = useRunActions(widget.id);
  const menu = useContextMenu();
  const epoch = useEpoch(dataSource);
  const { resolved } = useTheme();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `resolved` re-reads the colour tokens
  const colors = useMemo(resultColors, [resolved]);
  const trend = useMemo(
    () => (data.span === null ? null : trendBuckets(data.runs, data.span)),
    [data.runs, data.span],
  );
  const { setSubtitle } = page;
  const select = useRef(page.selectWindow);
  select.current = page.selectWindow;
  const openMenu = menu.open;
  const subtitle = trend === null || trend.buckets.length === 0 ? null : `${stepText(trend.step)} buckets`;
  useEffect(() => {
    setSubtitle(subtitle);
    return () => setSubtitle(null);
  }, [setSubtitle, subtitle]);

  const option = useMemo(() => {
    if (trend === null) return null;
    const { buckets } = trend;
    const bar = (name: string, key: 'passed' | 'failed' | 'cancelled', color: string) => ({
      type: 'bar',
      name,
      stack: 'runs',
      yAxisIndex: 1,
      itemStyle: { color },
      data: buckets.map((b) => b[key]),
    });
    const line = (name: string, key: 'p50' | 'p95') => ({
      type: 'line',
      name,
      yAxisIndex: 0,
      showSymbol: false,
      connectNulls: true,
      data: buckets.map((b) => b[key]),
    });
    return {
      animation: false,
      grid: { left: 52, right: 36, top: 24, bottom: 24 },
      legend: { top: 0, right: 0 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? String(v) : '–'),
      },
      xAxis: {
        type: 'category',
        data: buckets.map((b) => absoluteTime(b.t, epoch)),
        axisLabel: { hideOverlap: true },
      },
      yAxis: [
        { type: 'value', axisLabel: { formatter: (v: number) => formatDuration(v) } },
        { type: 'value', minInterval: 1, splitLine: { show: false } },
      ],
      series: [
        bar('passed', 'passed', colors.success),
        bar('failed', 'failed', colors.failure),
        bar('cancelled', 'cancelled', colors.cancelled),
        line('p50', 'p50'),
        line('p95', 'p95'),
      ],
    };
  }, [trend, colors, epoch]);

  const onEvents = useMemo(
    () => ({
      contextmenu: (p: unknown) => {
        const i = indexOf(p);
        const b = i === null ? undefined : trend?.buckets[i];
        if (b === undefined || trend === null || data.span === null) return;
        (p as { event?: { event?: { preventDefault?(): void } } }).event?.event?.preventDefault?.();
        // whole nanoseconds, through the page's own zoom path; the last bucket stops at the span's end
        const start = Math.round(b.t);
        const end = Math.round(Math.min(b.t + trend.step, data.span[1]));
        openMenu(pointOf(p), `${b.runs.length} runs`, [
          { label: 'Zoom the slider to this bucket', run: () => select.current({ start, end }) },
        ]);
      },
    }),
    [trend, data.span, openMenu],
  );
  return (
    <>
      <CicdBody data={data}>
        {() =>
          option === null ? null : (
            <Chart option={option} onEvents={onEvents} height={chartPx(height)} ariaLabel="Runs over time" />
          )
        }
      </CicdBody>
      {menu.element}
      {actions.element}
    </>
  );
};
