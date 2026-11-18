import { type JSX, useMemo } from 'react';
import { formatDuration } from '../../../semconv/formatters.js';
import { menuTriggers } from '../../components/context-menu.js';
import type { WidgetRenderer } from '../../dashboards/dashboard-page.js';
import { useSubtitle } from '../../dashboards/widgets/subtitle.js';
import { statusGrid } from '../derive.js';
import { centreOf, pointFromClick, RunRing, useRunActions } from '../run-actions.js';
import { useCicd } from '../use-cicd.js';
import { CicdBody } from './body.js';

const LAST = 60;
const CELL = 10;
const GAP = 2;
const PITCH = CELL + GAP;
const ROW = 14;
const LABEL_W = 150;
const LABEL_CHARS = 24;
const DOTS_H = 16;
const TAIL_W = 48;

const FILL = { success: 'fill-ok-cell', failure: 'fill-critical', cancelled: 'fill-series-other' } as const;
const DOT = { success: 'fill-good', failure: 'fill-critical', cancelled: 'fill-series-other' } as const;

/** A label that fits its column: cut with an ellipsis when longer. */
const fitLabel = (name: string): string =>
  name.length <= LABEL_CHARS ? name : `${name.slice(0, LABEL_CHARS - 1)}…`;

/** Jobs by the last 60 runs: a cell per job and run, a result dot per run on top, failed k / n per job. */
export const StatusGridView: WidgetRenderer = ({ widget, scope, actions: page }): JSX.Element => {
  const data = useCicd(widget, scope);
  const actions = useRunActions(widget.id);
  const grid = useMemo(() => statusGrid(data.runs, LAST), [data.runs]);
  const { openRun, runMenu, jobMenu, selectedTraceId, isSource } = actions;
  useSubtitle(
    page,
    data.status === 'ready' && grid.runs.length > 0
      ? `last ${grid.runs.length} ${grid.runs.length === 1 ? 'run' : 'runs'}`
      : null,
  );
  const open = grid.runs.findIndex((r) => r.traceId === selectedTraceId);
  return (
    <>
      <CicdBody data={data}>
        {() => {
          const width = LABEL_W + grid.runs.length * PITCH + TAIL_W;
          const height = DOTS_H + grid.rows.length * ROW;
          const colX = (i: number): number => LABEL_W + i * PITCH;
          return (
            <div>
              <svg
                role="img"
                aria-label="Job results over the last runs"
                width={width}
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                className="max-w-none text-ink"
              >
                {grid.runs.map((r, i) => (
                  // biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a <button>
                  <circle
                    key={r.traceId}
                    data-run-dot={r.result}
                    role="button"
                    tabIndex={0}
                    aria-label={`${r.title ?? `Run ${r.runId}`}, ${r.result}`}
                    cx={colX(i) + CELL / 2}
                    cy={DOTS_H / 2}
                    r={3.5}
                    className={`cursor-pointer ${DOT[r.result]}`}
                    onClick={(e) => openRun(r, pointFromClick(e))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') openRun(r, centreOf(e.currentTarget));
                    }}
                    {...menuTriggers((at) => runMenu(r, at))}
                  >
                    <title>{`${r.title ?? `Run ${r.runId}`} · ${r.result} · ${formatDuration(r.duration)}`}</title>
                  </circle>
                ))}
                {grid.rows.map((row, y) => {
                  const top = DOTS_H + y * ROW;
                  return (
                    <g key={row.job} data-job-row={row.job}>
                      <text
                        x={0}
                        y={top + CELL}
                        fontSize={11}
                        className="cursor-pointer fill-current"
                        {...menuTriggers((at) => jobMenu(row.job, at))}
                      >
                        {fitLabel(row.job)}
                        <title>{row.job}</title>
                      </text>
                      {row.cells.map((cell, i) => {
                        const run = grid.runs[i];
                        if (run === undefined) return null;
                        return cell === null ? (
                          <rect
                            key={run.traceId}
                            x={colX(i)}
                            y={top}
                            width={CELL}
                            height={CELL}
                            rx={1.5}
                            fill="none"
                            strokeWidth={1}
                            className="stroke-hairline"
                          />
                        ) : (
                          // biome-ignore lint/a11y/noStaticElementInteractions: a mark of the grid, the run dot above is its keyboard target
                          <rect
                            key={run.traceId}
                            data-cell={cell}
                            x={colX(i)}
                            y={top}
                            width={CELL}
                            height={CELL}
                            rx={1.5}
                            tabIndex={0}
                            className={`cursor-pointer ${FILL[cell]}`}
                            onClick={(e) => openRun(run, pointFromClick(e))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') openRun(run, centreOf(e.currentTarget));
                            }}
                            {...menuTriggers((at) => runMenu(run, at))}
                          >
                            <title>{`${row.job} · ${cell} · ${run.title ?? `Run ${run.runId}`}`}</title>
                          </rect>
                        );
                      })}
                      <text
                        x={colX(grid.runs.length) + 4}
                        y={top + CELL}
                        fontSize={10}
                        className="fill-muted"
                      >
                        {row.failed} / {row.ran}
                      </text>
                    </g>
                  );
                })}
                {open >= 0 && (
                  <>
                    <rect
                      data-run-column=""
                      x={colX(open) - 1}
                      y={DOTS_H - 2}
                      width={CELL + 2}
                      height={grid.rows.length * ROW + 2}
                      rx={2}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1}
                      opacity={isSource ? 0.6 : 0.2}
                      pointerEvents="none"
                    />
                    <RunRing cx={colX(open) + CELL / 2} cy={DOTS_H / 2} r={3.5} source={isSource} />
                  </>
                )}
              </svg>
            </div>
          );
        }}
      </CicdBody>
      {actions.element}
    </>
  );
};
