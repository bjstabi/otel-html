import { Info } from 'lucide-react';
import { type JSX, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RunControls } from '../../dashboards/schema.js';
import type { RunInfo, RunQueryResult } from '../data/metric-run-query.js';
import type { TimeWindow } from '../data/span-query.js';
import { useRunLineColorAssigner } from '../theme/colors-context.js';
import { Chart, type EChartsType } from './chart.js';
import { plotRects } from './run-chart-layout.js';
import { LEGEND_ROW_PX, legendRows, RunChartLegend } from './run-chart-legend.js';
import {
  buildRunChartOption,
  guideSeries,
  lineColors,
  type RunZoom,
  runsInView,
  runYAxes,
  zoomFromEvent,
} from './run-chart-option.js';
import { useThemeTick } from './theme-tick.js';

/** The card's own state, which a parent can keep across a remount. */
export interface RunChartView {
  zoom: RunZoom | null;
  /** The window `zoom` was taken in: a zoom doesn't outlive its window. */
  zoomWindow: TimeWindow | null;
  hidden: ReadonlySet<string>;
}

export interface RunChartCardProps {
  title: string;
  subtitle: string;
  result: RunQueryResult;
  configured: RunControls;
  controls: RunControls;
  onControls(c: RunControls): void;
  /** The whole card's height: its header and notes come out of it, so the widget never changes size. */
  height: number;
  epochUnixNano: string;
  selectedRun: string | null;
  echarts: Record<string, unknown> | null;
  onPickRun: ((runId: string) => void) | null;
  notes: string[];
  /** Where the card starts; read on mount only. */
  view?: RunChartView | undefined;
  onView?: ((view: RunChartView) => void) | undefined;
}

const TOGGLES: readonly { key: keyof RunControls; label: string }[] = [
  { key: 'slider', label: 'Slider' },
  { key: 'evenSpacing', label: 'Even spacing' },
  { key: 'split', label: 'Split' },
  { key: 'legend', label: 'Legend' },
];
const TOO_SMALL = 'Too small to split. Make this widget taller.';
const BUTTON =
  'rounded-full px-2 py-0.5 text-xs text-ink-2 hover:bg-hairline aria-pressed:bg-ink aria-pressed:text-page disabled:opacity-50 disabled:hover:bg-transparent';
/** Below this card width the legend sits under the plot. */
const LEGEND_BESIDE_MIN_PX = 820;
const LEGEND_WIDTH_PX = 290;
const LEGEND_GAP_PX = 8;
/** Under the plot, the legend scrolls past this share of the height rather than squeezing the plot away. */
const LEGEND_UNDER_MAX_SHARE = 0.4;
const NO_HIDDEN: ReadonlySet<string> = new Set();

/** The zoom a card starts at: a stored one only counts in the window it was taken in. */
function startingZoom(view: RunChartView | undefined, window: TimeWindow): RunZoom | null {
  const taken = view?.zoomWindow;
  return taken?.start === window.start && taken.end === window.end ? (view?.zoom ?? null) : null;
}

interface DotEvent {
  value?: unknown;
  data?: { meta?: { run: RunInfo } };
}

/** The room a `Chart` gets once a legend, if any, has taken its share of the measured body. */
function chartBox(
  body: { width: number; height: number },
  legend: boolean,
  rows: number,
): { width: number; height: number; beside: boolean; legendHeight: number } {
  if (!legend) return { ...body, beside: false, legendHeight: 0 };
  if (body.width >= LEGEND_BESIDE_MIN_PX) {
    return {
      width: body.width - LEGEND_WIDTH_PX - LEGEND_GAP_PX,
      height: body.height,
      beside: true,
      legendHeight: body.height,
    };
  }
  const legendHeight = Math.min(rows * LEGEND_ROW_PX, body.height * LEGEND_UNDER_MAX_SHARE);
  return {
    width: body.width,
    height: Math.max(0, body.height - legendHeight - LEGEND_GAP_PX),
    beside: false,
    legendHeight,
  };
}

/** The plot count and the guide a built option draws, which is what a hover leaves behind. */
function restingGuide(option: unknown): { plots: number; x: number | null } {
  const { series } = option as { series?: { id?: string; markLine?: { data?: { xAxis?: number }[] } }[] };
  const guides = (series ?? []).filter((s) => s.id?.startsWith('guide'));
  return { plots: guides.length, x: guides[0]?.markLine?.data?.[0]?.xAxis ?? null };
}

/** A metric widget's run chart: the card holds the zoom and the hidden lines, and its parent holds the toggles. */
export function RunChartCard(props: RunChartCardProps): JSX.Element {
  const { result, controls, configured, onControls, epochUnixNano, selectedRun, echarts, onPickRun } = props;
  const colors = useRunLineColorAssigner();
  const chart = useRef<EChartsType | null>(null);
  const onInstance = useCallback((c: EChartsType | null): void => {
    chart.current = c;
  }, []);

  const themeTick = useThemeTick();

  // The body's size, measured: null until first laid out, and kept while it isn't (a size of 0).
  const bodyRef = useRef<HTMLDivElement>(null);
  const [body, setBody] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    const measure = (): void => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width === 0 || height === 0) return;
      setBody((b) => (b?.width === width && b.height === height ? b : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ECharts swallows every wheel event over a plot once it has an inside zoom, ctrl or not, which would stop the page
  // scrolling. A plain one is kept from reaching it, so only Ctrl+scroll gets to the chart.
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    const leaveToPage = (e: WheelEvent): void => {
      if (!e.ctrlKey) e.stopPropagation();
    };
    el.addEventListener('wheel', leaveToPage, { capture: true, passive: true });
    return () => el.removeEventListener('wheel', leaveToPage, { capture: true });
  }, []);

  // The zoom is also a ref because it isn't an input to the option: ECharts already shows a zoom it reports, and
  // only the y axis follows it. A rebuild for any other reason reads the ref, so it comes back at the current zoom.
  const [zoom, setZoomState] = useState(() => startingZoom(props.view, result.window));
  const zoomNow = useRef(zoom);
  const setZoom = (z: RunZoom | null): void => {
    zoomNow.current = z;
    setZoomState(z);
  };
  const [zoomedWindow, setZoomedWindow] = useState(result.window);
  if (zoomedWindow.start !== result.window.start || zoomedWindow.end !== result.window.end) {
    setZoomedWindow(result.window);
    setZoom(null);
  }
  // Reset clears a zoom ECharts is showing, which takes a rebuild when nothing else changes.
  const [resetTick, setResetTick] = useState(0);

  const [hiddenKeys, setHiddenKeys] = useState(props.view?.hidden ?? NO_HIDDEN);
  // A new result can drop lines: hidden keys only count while they exist, and never hide everything.
  const hidden = useMemo(() => {
    const kept = new Set(result.lines.filter((l) => hiddenKeys.has(l.key)).map((l) => l.key));
    return kept.size === result.lines.length ? NO_HIDDEN : kept;
  }, [result.lines, hiddenKeys]);

  const onView = useRef(props.onView);
  onView.current = props.onView;
  useEffect(() => {
    onView.current?.({ zoom, zoomWindow: zoom === null ? null : result.window, hidden: hiddenKeys });
  }, [zoom, hiddenKeys, result.window]);

  const [hoveredRun, setHoveredRun] = useState<string | null>(null);

  const box = chartBox(body ?? { width: 0, height: props.height }, controls.legend, result.lines.length);
  const pickable = onPickRun !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeTick re-reads the CSS colour tokens, resetTick drops the zoom ECharts holds
  const { option, splitFits } = useMemo(
    () =>
      buildRunChartOption({
        result,
        controls,
        hidden,
        zoom: zoomNow.current,
        width: box.width,
        height: box.height,
        colors,
        epochUnixNano,
        selectedRun,
        pickable,
        echarts,
      }),
    [
      result,
      controls,
      hidden,
      box.width,
      box.height,
      colors,
      epochUnixNano,
      selectedRun,
      pickable,
      echarts,
      themeTick,
      resetTick,
    ],
  );
  const guide = useMemo(() => restingGuide(option), [option]);

  // A rebuild makes new series models over the same elements, and ECharts only leaves a blur a model remembers, so a
  // blur still on when it happens never clears. A cleanup, because cleanups all run before `Chart`'s `setOption`.
  // Gated on the pointer being over the body, because a line blurs with no ECharts event for the card to see.
  const pointerInBody = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new option is a rebuild
  useEffect(
    () => () => {
      if (pointerInBody.current) chart.current?.dispatchAction({ type: 'downplay' });
    },
    [option],
  );

  // Latest values for the ECharts handlers, which stay the same so that an event never rebuilds the chart.
  const live = useRef({ result, controls, hidden, split: false, guide, onPickRun, epochUnixNano });
  live.current = {
    result,
    controls,
    hidden,
    split: controls.split && splitFits,
    guide,
    onPickRun,
    epochUnixNano,
  };

  const guideDrawn = useRef<number | null>(guide.x);
  useEffect(() => {
    guideDrawn.current = guide.x;
    setHoveredRun(null);
  }, [guide]);

  const onEvents = useMemo(() => {
    const drawGuide = (x: number | null): void => {
      if (guideDrawn.current === x) return;
      guideDrawn.current = x;
      const { plots } = live.current.guide;
      chart.current?.setOption({ series: Array.from({ length: plots }, (_, n) => guideSeries(n, x)) });
    };
    const leaveDot = (): void => {
      setHoveredRun(null);
      drawGuide(live.current.guide.x);
    };
    return {
      datazoom: (): void => {
        const c = chart.current;
        if (c === null) return;
        const { dataZoom } = c.getOption() as { dataZoom?: { startValue?: number; endValue?: number }[] };
        const { startValue, endValue } = dataZoom?.[0] ?? {};
        if (startValue === undefined || endValue === undefined) return;
        const { result: r, controls: t, hidden: h, split, epochUnixNano: epoch } = live.current;
        const next = zoomFromEvent(r, t.evenSpacing, startValue, endValue, epoch);
        if (next?.start === zoomNow.current?.start && next?.end === zoomNow.current?.end) return;
        zoomNow.current = next;
        setZoomState(next);
        c.setOption({ yAxis: runYAxes({ result: r, controls: t, hidden: h, zoom: next }, split) });
      },
      mouseover: (e: unknown): void => {
        const { value, data } = e as DotEvent;
        const x = Array.isArray(value) ? Number(value[0]) : Number.NaN;
        if (data?.meta === undefined || Number.isNaN(x)) return;
        setHoveredRun(data.meta.run.id);
        drawGuide(x);
      },
      mouseout: leaveDot,
      globalout: leaveDot,
      click: (e: unknown): void => {
        const id = (e as DotEvent).data?.meta?.run.id;
        if (id !== undefined) live.current.onPickRun?.(id);
      },
    };
  }, []);

  const toggleLine = (key: string): void => {
    if (!hidden.has(key) && result.lines.length - hidden.size <= 1) return;
    const next = new Set(hidden);
    if (!next.delete(key)) next.add(key);
    setHiddenKeys(next);
  };
  const hoverLine = (key: string, on: boolean): void => {
    chart.current?.dispatchAction({ type: on ? 'highlight' : 'downplay', seriesId: `line:${key}` });
  };

  const controlsMatch = TOGGLES.every(({ key }) => controls[key] === configured[key]);
  const isConfigured = controlsMatch && zoom === null && hidden.size === 0;
  const reset = (): void => {
    if (!controlsMatch) onControls(configured);
    setZoom(null);
    setHiddenKeys(NO_HIDDEN);
    setResetTick((n) => n + 1);
  };

  const tooSmall = body !== null && !splitFits;
  const notes = tooSmall ? [...props.notes, TOO_SMALL] : props.notes;
  // With split off the builder's `splitFits` says nothing, and turning it on here would only strand it on, disabled.
  const visible = result.lines.filter((l) => !hidden.has(l.key));
  const wouldNotFit =
    body !== null &&
    !controls.split &&
    !plotRects({
      width: box.width,
      height: box.height,
      plots: visible.length,
      split: true,
      slider: controls.slider,
      // As the builder: mixed units split whatever the size or the toggle.
      forceSplit: new Set(visible.map((l) => l.unit)).size > 1,
    }).splitFits;
  const empty = result.runs.length === 0 || result.lines.length === 0;
  const inView = runsInView(result, zoom);
  const rows =
    controls.legend && !empty
      ? legendRows({
          result,
          // As the y axis: a zoom holding no run, possible on real time, reads every run.
          inView: inView.length === 0 ? result.runs : inView,
          hoveredRun,
          hidden,
          colors: lineColors(result, colors),
        })
      : [];

  return (
    <section
      aria-label={props.title}
      className="flex flex-col overflow-hidden rounded-card border border-hairline bg-surface p-3"
      style={{ height: props.height }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="min-w-0 flex-1 basis-40">
          <h3 className="truncate text-sm font-medium">{props.title}</h3>
          <p className="truncate text-xs text-muted">{props.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {TOGGLES.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={controls[key]}
              disabled={key === 'split' && (tooSmall || wouldNotFit)}
              {...(key === 'split' && wouldNotFit ? { title: TOO_SMALL } : {})}
              onClick={() => onControls({ ...controls, [key]: !controls[key] })}
              className={BUTTON}
            >
              {label}
            </button>
          ))}
          <button type="button" disabled={isConfigured} onClick={reset} className={BUTTON}>
            Reset
          </button>
        </div>
      </div>
      {notes.length > 0 && (
        <div className="mt-1 flex items-start gap-1.5 text-xs text-muted">
          <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
          <ul aria-label="Notes" className="list-none">
            {notes.map((n, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: notes are a static ordered list and may repeat
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: only notes where the pointer is, and nothing acts on it */}
      <div
        ref={bodyRef}
        className="mt-1 min-h-0 flex-1"
        onMouseEnter={() => {
          pointerInBody.current = true;
        }}
        onMouseLeave={() => {
          pointerInBody.current = false;
        }}
      >
        {empty ? (
          <>
            <p className="text-sm font-semibold">No data points in this window</p>
            <p className="mt-1 text-sm text-ink-2">The queries match no data points.</p>
          </>
        ) : (
          <div
            className="grid"
            style={{
              gap: LEGEND_GAP_PX,
              gridTemplateColumns: box.beside ? `minmax(0, 1fr) ${LEGEND_WIDTH_PX}px` : 'minmax(0, 1fr)',
            }}
          >
            <Chart
              option={option}
              height={box.height}
              onEvents={onEvents}
              onInstance={onInstance}
              ariaLabel={`${props.title}: ${result.lines.length} lines over ${result.runs.length} runs`}
            />
            {controls.legend && (
              <RunChartLegend
                rows={rows}
                height={box.legendHeight}
                onHover={hoverLine}
                onToggle={toggleLine}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
