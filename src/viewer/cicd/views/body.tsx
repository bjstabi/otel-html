import type { JSX, ReactNode } from 'react';
import { FRAME_CHROME_PX } from '../../dashboards/widgets/layout.js';
import { STATUS } from '../../theme/palette.js';
import type { CiRun } from '../runs.js';
import type { useCicd } from '../use-cicd.js';

const EMPTY_TEXT = 'No run in this range.';
const MIN_CHART_PX = 80;

/** The chart's height: what is left of the widget once the frame's header and padding are taken. */
export const chartPx = (heightPx: number, extra = 0): number =>
  Math.max(MIN_CHART_PX, heightPx - FRAME_CHROME_PX - extra);

/** The view's loading, error and empty lines; `children` runs only when there is at least one run. */
export function CicdBody(props: {
  data: ReturnType<typeof useCicd>;
  children(runs: readonly CiRun[]): ReactNode;
}): JSX.Element {
  const { data } = props;
  if (data.status === 'loading') return <div className="p-3 text-sm text-muted">Loading…</div>;
  if (data.status === 'error')
    return (
      <div role="alert" className="p-3 text-sm text-critical">
        {data.error?.message ?? 'The CI runs could not be read.'}
      </div>
    );
  if (data.runs.length === 0) return <div className="p-3 text-sm text-muted">{EMPTY_TEXT}</div>;
  return <>{props.children(data.runs)}</>;
}

/** The colour of a run's result in a canvas chart (which cannot resolve `var()`); `other` is read from the token. */
export function resultColors(): Record<CiRun['result'], string> & { ink: string } {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    success: STATUS.good,
    failure: STATUS.critical,
    cancelled: token('--oh-series-other', 'gray'),
    ink: token('--oh-ink', 'black'),
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The native mouse event's position inside an ECharts event, for the context menu. */
export function pointOf(params: unknown): { x: number; y: number } {
  const e = (params as { event?: { event?: { clientX?: number; clientY?: number } } }).event?.event;
  return { x: e?.clientX ?? 0, y: e?.clientY ?? 0 };
}

export function indexOf(params: unknown): number | null {
  const i = (params as { dataIndex?: unknown }).dataIndex;
  return typeof i === 'number' ? i : null;
}

/** The open run's ring as a scatter series: faint in every view, full in the one the run was opened from. */
export function ringSeries(at: [number, number], source: boolean, ink: string, yAxisIndex = 0) {
  return {
    id: 'open-run',
    type: 'scatter',
    silent: true,
    symbol: 'circle',
    symbolSize: 18,
    yAxisIndex,
    z: 10,
    itemStyle: {
      color: 'transparent',
      borderColor: ink,
      borderWidth: source ? 2 : 1.5,
      opacity: source ? 1 : 0.35,
    },
    data: [at],
  };
}

/** The keyboard-highlighted run as a dashed ring (the open run's ring is solid), drawn while the chart has focus. */
export function currentSeries(at: [number, number], ink: string, yAxisIndex = 0) {
  return {
    id: 'current-run',
    type: 'scatter',
    silent: true,
    symbol: 'circle',
    symbolSize: 22,
    yAxisIndex,
    z: 11,
    itemStyle: { color: 'transparent', borderColor: ink, borderWidth: 2, borderType: 'dashed' },
    data: [at],
  };
}
