import type { JSX } from 'react';
import type { RunInfo, RunQueryResult } from '../data/metric-run-query.js';
import { formatMetricValue } from './metric-chart-option.js';
import { shortLabel } from './run-chart-format.js';
import type { RunLineStyle } from './run-chart-option.js';

export interface LegendRow {
  key: string;
  label: string;
  color: string;
  /** The line's dash, as in the plot; a plain dot where the color alone tells it apart. */
  dash?: readonly number[];
  /** In the hovered run, otherwise the latest run in view; a dash where the line has no point there. */
  value: string;
  /** From the median in view; empty where there is nothing to compare. */
  change: string;
  hidden: boolean;
}

/** One legend row's height in px, which the card uses to give the legend its room under the plot. */
export const LEGEND_ROW_PX = 28;
const NO_VALUE = '—';
/** Wide enough to show a full on-and-off of the longest dash a list of lines gets in practice. */
const DASH_SWATCH_PX = 28;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  if (Number.isInteger(mid)) return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return sorted[Math.floor(mid)] ?? null;
}

function changeFrom(value: number, mid: number | null): string {
  if (mid === null || mid <= 0) return '';
  const percent = Math.round(((value - mid) / mid) * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

/** Rows in a fixed order, by median over all runs and highest first, so that zoom and hover don't move them. */
export function legendRows(i: {
  result: RunQueryResult;
  inView: readonly RunInfo[];
  hoveredRun: string | null;
  hidden: ReadonlySet<string>;
  styles: ReadonlyMap<string, RunLineStyle>;
}): LegendRow[] {
  const { runs, lines } = i.result;
  const hovered = runs.findIndex((r) => r.id === i.hoveredRun);
  const last = i.inView[i.inView.length - 1];
  const at = hovered >= 0 ? hovered : last === undefined ? -1 : runs.indexOf(last);
  const held = new Set(i.inView);
  const valuesOf = (l: (typeof lines)[number], keep: (n: number) => boolean): number[] =>
    l.points.flatMap((p, n) => (p !== null && keep(n) ? [p.value] : []));
  const overall = new Map(lines.map((l) => [l.key, median(valuesOf(l, () => true)) ?? 0]));
  return [...lines]
    .sort((a, b) => (overall.get(b.key) ?? 0) - (overall.get(a.key) ?? 0))
    .map((l) => {
      const point = l.points[at] ?? null;
      const mid = median(
        valuesOf(l, (n) => {
          const run = runs[n];
          return run !== undefined && held.has(run);
        }),
      );
      const style = i.styles.get(l.key);
      return {
        key: l.key,
        label: l.label,
        color: style?.color ?? '',
        ...(style?.type === undefined ? {} : { dash: style.type }),
        value: point === null ? NO_VALUE : formatMetricValue(l.unit, point.value),
        change: point === null ? '' : changeFrom(point.value, mid),
        hidden: i.hidden.has(l.key),
      };
    });
}

/** The lines of a run chart: hover highlights one, and a click hides or shows it. */
export function RunChartLegend(props: {
  rows: readonly LegendRow[];
  height: number;
  onHover(key: string, on: boolean): void;
  onToggle(key: string): void;
}): JSX.Element {
  // Every swatch takes the room of a dashed one if there is one, so the labels stay in a column.
  const swatchWidth = props.rows.some((r) => r.dash !== undefined) ? DASH_SWATCH_PX : undefined;
  return (
    <ul aria-label="Lines" className="list-none overflow-y-auto" style={{ height: props.height }}>
      {props.rows.map((r) => (
        <li key={r.key}>
          <button
            type="button"
            aria-pressed={!r.hidden}
            title={r.label}
            onClick={() => props.onToggle(r.key)}
            onMouseEnter={() => props.onHover(r.key, true)}
            onMouseLeave={() => props.onHover(r.key, false)}
            style={{ height: LEGEND_ROW_PX }}
            className="flex w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-hairline aria-[pressed=false]:opacity-50"
          >
            <span aria-hidden className="flex shrink-0 items-center" style={{ width: swatchWidth }}>
              {r.dash === undefined ? (
                <span className="size-2 rounded-full" style={{ background: r.color }} />
              ) : (
                <svg width={DASH_SWATCH_PX} height={8} role="presentation">
                  <line
                    x1={0}
                    y1={4}
                    x2={DASH_SWATCH_PX}
                    y2={4}
                    stroke={r.color}
                    strokeWidth={1.5}
                    strokeDasharray={r.dash.join(' ')}
                  />
                </svg>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate">{shortLabel(r.label)}</span>
            <span className="shrink-0 tabular-nums">{r.value}</span>
            <span className="w-12 shrink-0 text-right text-muted tabular-nums">{r.change}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
