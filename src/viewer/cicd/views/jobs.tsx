import { type JSX, useMemo, useState } from 'react';
import { Chart } from '../../components/chart.js';
import { menuTriggers } from '../../components/context-menu.js';
import type { WidgetRenderer } from '../../dashboards/dashboard-page.js';
import { useEpoch } from '../../dashboards/widgets/layout.js';
import { useSubtitle } from '../../dashboards/widgets/subtitle.js';
import { useTheme } from '../../theme/theme-provider.js';
import { type JobRow, jobsTable } from '../derive.js';
import { axisTime, durationAxis, durationText } from '../format.js';
import { useRunActions } from '../run-actions.js';
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

const COLUMNS = 'grid-cols-[minmax(8rem,1fr)_120px_4.5rem_4.5rem_9rem_4.5rem_1.75rem]';
const SPARK_W = 120;
const SPARK_H = 24;
const PLOT = { left: 52, right: 12 };

/** A job's durations as a line with its p25–p75 band, a diamond for each failure and a hollow point for each cancel. */
function JobSpark({ row }: { row: JobRow }): JSX.Element {
  const max = Math.max(1, ...row.points.map((p) => p.duration), row.p75);
  const y = (v: number): number => SPARK_H - 3 - (v / max) * (SPARK_H - 6);
  const step = row.points.length > 1 ? (SPARK_W - 6) / (row.points.length - 1) : 0;
  const x = (i: number): number => 3 + i * step;
  return (
    <svg aria-hidden width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}>
      <rect
        x={0}
        y={y(row.p75)}
        width={SPARK_W}
        height={Math.max(1, y(row.p25) - y(row.p75))}
        className="fill-ok-cell"
      />
      <polyline
        points={row.points.map((p, i) => `${x(i).toFixed(1)},${y(p.duration).toFixed(1)}`).join(' ')}
        fill="none"
        strokeWidth={1.25}
        className="stroke-accent"
      />
      {row.points.map((p, i) =>
        p.status === 'failure' ? (
          <rect
            key={p.run.traceId}
            x={x(i) - 2.5}
            y={y(p.duration) - 2.5}
            width={5}
            height={5}
            transform={`rotate(45 ${x(i)} ${y(p.duration)})`}
            className="fill-critical"
          />
        ) : p.status === 'cancelled' ? (
          <circle
            key={p.run.traceId}
            cx={x(i)}
            cy={y(p.duration)}
            r={2.5}
            fill="none"
            strokeWidth={1.25}
            className="stroke-series-other"
          />
        ) : null,
      )}
    </svg>
  );
}

/** The Δ cell: a bar that grows left (faster) or right (slower) from a centre line, or why there is none. */
function DeltaCell({ row }: { row: JobRow }): JSX.Element {
  if (row.delta === null || row.deltaA === null || row.deltaB === null)
    return <span className="text-xs text-muted">baseline too small</span>;
  const share = row.deltaA > 0 ? Math.min(1, Math.abs(row.delta) / row.deltaA) : 0;
  const slower = row.delta > 0;
  const sign = row.delta > 0 ? '+' : row.delta < 0 ? '−' : '';
  return (
    <span
      className="flex items-center gap-1.5"
      title={`median of the last 10 passed runs ${durationText(row.deltaB)}, the 20 before ${durationText(row.deltaA)}`}
    >
      <span className="relative h-2 w-14 shrink-0">
        <span className="absolute inset-y-0 left-1/2 w-px bg-hairline" />
        <span
          className={`absolute inset-y-0 ${slower ? 'left-1/2 bg-critical' : 'right-1/2 bg-good'}`}
          style={{ width: `${(share * 50).toFixed(1)}%` }}
        />
      </span>
      <span className={`font-mono text-xs ${slower ? 'text-critical' : 'text-good-ink'}`}>
        {sign}
        {durationText(Math.abs(row.delta))}
      </span>
    </span>
  );
}

/** One row per job: trend, latest, median, Δ against the baseline, failed k / n; a click expands the full trend. */
export const JobsView: WidgetRenderer = ({
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
  const [expanded, setExpanded] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `resolved` re-reads the colour tokens
  const colors = useMemo(resultColors, [resolved]);
  const rows = useMemo(
    () => jobsTable(data.runs, [...data.previous, ...data.runs]),
    [data.runs, data.previous],
  );
  const { openRun, runMenu, jobMenu, selectedTraceId, isSource } = actions;
  useSubtitle(
    page,
    data.status === 'ready' && rows.length > 0
      ? `${rows.length} ${rows.length === 1 ? 'job' : 'jobs'}`
      : null,
  );

  const trend = rows.find((r) => r.name === expanded);
  const trendRuns = useMemo(() => trend?.points.map((p) => p.run) ?? [], [trend]);
  const keys = useRunKeys(trendRuns, actions, PLOT);
  const option = useMemo(() => {
    if (trend === undefined) return null;
    const open = trend.points.findIndex((p) => p.run.traceId === selectedTraceId);
    const pt = trend.points[open];
    return {
      animation: false,
      grid: { left: PLOT.left, right: PLOT.right, top: 12, bottom: 24 },
      tooltip: {
        trigger: 'item',
        formatter: (p: { dataIndex: number }) => {
          const x = trend.points[p.dataIndex];
          return x === undefined
            ? ''
            : `<b>${escapeHtml(x.run.title ?? `Run ${x.run.runId}`)}</b><br/>${x.status} · ${durationText(x.duration)}`;
        },
      },
      xAxis: {
        type: 'category',
        data: trend.points.map((p) => axisTime(p.run.start, epoch, 0)),
        axisLabel: { hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        ...durationAxis(Math.max(0, ...trend.points.map((p) => p.duration))),
        axisLabel: { formatter: (v: number) => durationText(v) },
      },
      series: [
        {
          type: 'line',
          name: trend.name,
          cursor: 'pointer',
          symbolSize: 7,
          lineStyle: { width: 1.25 },
          data: trend.points.map((p) => ({
            value: p.duration,
            symbol: p.status === 'failure' ? 'diamond' : 'circle',
            itemStyle:
              p.status === 'failure'
                ? { color: colors.failure }
                : p.status === 'cancelled'
                  ? { color: 'transparent', borderColor: colors.cancelled, borderWidth: 1.5 }
                  : { color: colors.success },
          })),
        },
        ...(pt === undefined ? [] : [ringSeries([open, pt.duration], isSource, colors.ink)]),
        ...(keys.current === null
          ? []
          : [currentSeries([keys.current, trend.points[keys.current]?.duration ?? 0], colors.ink)]),
      ],
    };
  }, [trend, colors, epoch, selectedTraceId, isSource, keys.current]);
  const onEvents = useMemo(
    () => ({
      click: (p: unknown) => {
        const i = indexOf(p);
        const x = i === null ? undefined : trend?.points[i];
        if (x !== undefined) openRun(x.run, pointOf(p));
      },
      contextmenu: (p: unknown) => {
        const i = indexOf(p);
        const x = i === null ? undefined : trend?.points[i];
        if (x === undefined) return;
        (p as { event?: { event?: { preventDefault?(): void } } }).event?.event?.preventDefault?.();
        runMenu(x.run, pointOf(p));
      },
    }),
    [trend, openRun, runMenu],
  );

  return (
    <>
      <CicdBody data={data}>
        {() =>
          rows.length === 0 ? (
            <div className="p-3 text-sm text-muted">No job ran three times in this range.</div>
          ) : (
            <div className="min-w-[36rem] text-sm">
              <div
                className={`grid ${COLUMNS} items-center gap-x-3 border-b border-hairline px-3 py-1 text-xs text-muted`}
              >
                <span>Job</span>
                <span>Trend</span>
                <span className="text-right">Latest</span>
                <span className="text-right">Median</span>
                <span>Δ vs baseline</span>
                <span className="text-right">Failed</span>
                <span />
              </div>
              {rows.map((row) => {
                const isOpen = row.name === expanded;
                const toggle = (): void => setExpanded(isOpen ? null : row.name);
                const menu = (at: { x: number; y: number }): void =>
                  jobMenu(row.name, at, () => setExpanded(row.name));
                return (
                  <div key={row.name} className="border-b border-hairline">
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: the name inside is the keyboard target */}
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: the whole row is a larger click target */}
                    <div
                      data-job={row.name}
                      className={`grid ${COLUMNS} cursor-pointer items-center gap-x-3 px-3 py-1.5 hover:bg-page`}
                      onClick={toggle}
                      {...menuTriggers(menu)}
                    >
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        className="min-w-0 truncate text-left text-ink"
                        title={row.name}
                      >
                        {row.name}
                      </button>
                      <JobSpark row={row} />
                      <span className="text-right font-mono text-xs">{durationText(row.latest)}</span>
                      <span className="text-right font-mono text-xs">{durationText(row.median)}</span>
                      <DeltaCell row={row} />
                      <span
                        className={`text-right font-mono text-xs ${row.failed[0] > 0 ? 'text-critical' : 'text-muted'}`}
                      >
                        {row.failed[0]} / {row.failed[1]}
                      </span>
                      <button
                        type="button"
                        aria-label="Job menu"
                        className="rounded px-1 text-muted hover:text-ink"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = e.currentTarget.getBoundingClientRect();
                          menu({ x: r.left, y: r.bottom });
                        }}
                      >
                        ⋯
                      </button>
                    </div>
                    {isOpen && option !== null && (
                      <div
                        data-job-trend
                        role="application"
                        {...keys.props}
                        aria-label={`${row.name} duration over the runs: Left and Right choose a run, Enter opens it`}
                        className="px-3 pb-2 focus-visible:outline focus-visible:outline-2"
                      >
                        <Chart
                          option={option}
                          onEvents={onEvents}
                          height={chartPx(height, 80)}
                          ariaLabel={`${row.name} duration over the runs`}
                        />
                        {keys.live}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        }
      </CicdBody>
      {actions.element}
    </>
  );
};
