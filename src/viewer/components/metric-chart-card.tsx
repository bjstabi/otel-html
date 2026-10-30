import { Menu } from '@base-ui/react/menu';
import { Info } from 'lucide-react';
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseTraceId, type TraceId } from '../../model/ids.js';
import type { METRIC_DISPLAYS, METRIC_SCALES } from '../../query/metric-query.js';
import type { MetricQueryResult } from '../data/metric-query.js';
import type { TimeWindow } from '../data/span-query.js';
import { useColorAssigner } from '../theme/colors-context.js';
import { Chart, type EChartsType } from './chart.js';
import {
  buildMetricChartOption,
  GRID,
  heatAxis,
  METRIC_CHART_HEIGHT,
  type MetricSize,
  sharedUnit,
} from './metric-chart-option.js';

export type ChartPick =
  | { kind: 'exemplar'; traceId: string; spanId: string | null }
  | { kind: 'traces' | 'logs'; window: TimeWindow; queryId: string }
  | { kind: 'zoom'; window: TimeWindow };

export interface MetricChartCardProps {
  title: string;
  subtitle: string;
  results: readonly MetricQueryResult[];
  display: (typeof METRIC_DISPLAYS)[number];
  scale: (typeof METRIC_SCALES)[number];
  size: MetricSize;
  marker?: number | null;
  highlightTrace?: string | null;
  exemplars: boolean;
  notes: string[];
  /** The x range of the chart; series only cover the buckets that hold data. */
  window: TimeWindow;
  /** How the click menu names a query when it offers one Traces/Logs entry per query (default: its id). */
  queryLabels?: Readonly<Record<string, string>>;
  /** Whether the report holds a trace; embedded callers pass an explicit resolver. */
  hasTrace: (traceId: string) => Promise<boolean>;
  /** The dashboard's selection window, shaded on the chart. */
  band?: TimeWindow | null;
  /** A config's ECharts options, merged over the built option. */
  echarts?: Record<string, unknown> | null;
  /** Adds "Select this trace" to the menu of an exemplar whose trace the report holds. */
  onSelectTrace?: (traceId: TraceId) => void;
  /** A newer result is loading; the chart stays drawn and is marked busy meanwhile. */
  busy?: boolean;
  onPick(pick: ChartPick): void;
  onZoom(w: TimeWindow): void;
}

/** Pointer movement in px below which a press is a click rather than a drag-zoom. */
const DRAG_PX = 6;
/** Distance in px within which a click counts as being on an exemplar. */
const HIT_PX = 10;

interface ZrEvent {
  offsetX: number;
  offsetY: number;
  event: { clientX: number; clientY: number };
}

type Trace = { traceId: string; spanId: string | null; state: 'present' | 'absent' | 'unknown' };

interface PinnedMenu {
  x: number;
  y: number;
  window: TimeWindow;
  /** The query the click is about; several when no series has a value there to tell them apart. */
  queryIds: string[];
  trace: Trace | null;
}

interface PixelChart {
  convertToPixel(finder: { gridIndex: number }, value: [number, number]): unknown;
}

/**
 * The query whose series passes nearest the click (by y at the clicked bucket, in pixels), so a combined chart's
 * Traces/Logs links carry that query's `where`. Every query when none has a value in that bucket: the menu then
 * offers one entry per query rather than guessing.
 */
function queriesAt(
  chart: PixelChart,
  results: readonly MetricQueryResult[],
  display: MetricChartCardProps['display'],
  scale: MetricChartCardProps['scale'],
  t: number,
  y: number,
): string[] {
  const ids = [...new Set(results.map((r) => r.queryId))];
  if (ids.length <= 1 || display === 'heatmap' || display === 'distribution') return ids.slice(0, 1);
  let best: { id: string; d: number } | null = null;
  // Area lines are stacked in series order, as the chart draws them.
  let stack = 0;
  for (const r of results) {
    const start = Math.floor(t / r.widthNs) * r.widthNs;
    for (const s of r.series) {
      const v = s.points.find((p) => p[0] === start)?.[1] ?? null;
      if (v === null || (scale === 'log' && v <= 0)) continue;
      if (display === 'area') stack += v;
      const p = chart.convertToPixel({ gridIndex: 0 }, [start, display === 'area' ? stack : v]);
      if (!Array.isArray(p)) continue;
      const d = Math.abs(Number(p[1]) - y);
      if (Number.isFinite(d) && (best === null || d < best.d)) best = { id: r.queryId, d };
    }
  }
  return best === null ? ids : [best.id];
}

const ITEM = 'rounded-md px-3 py-1.5 text-sm hover:bg-hairline data-[disabled]:text-muted';
const POPUP = 'rounded-card border border-hairline bg-surface p-1 shadow-lg';

/** The one metric chart: used by the Explorer and every embedded Metrics grid. */
export function MetricChartCard(props: MetricChartCardProps): JSX.Element {
  const colors = useColorAssigner();
  const { results, hasTrace, onZoom } = props;
  const [chart, setChart] = useState<EChartsType | null>(null);
  const [menu, setMenu] = useState<PinnedMenu | null>(null);
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => mo.disconnect();
  }, []);

  const unit = sharedUnit(results);
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeTick re-reads the CSS colour tokens
  const option = useMemo(
    () =>
      buildMetricChartOption({
        results,
        display: props.display,
        scale: props.scale,
        unit,
        colors,
        marker: props.marker ?? null,
        highlightTrace: props.highlightTrace ?? null,
        exemplars: props.exemplars,
        size: props.size,
        window: props.window,
        band: props.band ?? null,
        echarts: props.echarts ?? null,
      }),
    [
      results,
      props.display,
      props.scale,
      unit,
      colors,
      props.marker,
      props.highlightTrace,
      props.exemplars,
      props.size,
      props.window,
      props.band,
      props.echarts,
      themeTick,
    ],
  );

  // Latest values for the zrender handlers, which are bound once per chart instance.
  const live = useRef({
    results,
    display: props.display,
    scale: props.scale,
    exemplars: props.exemplars,
    hasTrace,
    onZoom,
  });
  live.current = {
    results,
    display: props.display,
    scale: props.scale,
    exemplars: props.exemplars,
    hasTrace,
    onZoom,
  };
  const seq = useRef(0);

  useEffect(() => {
    if (chart === null) return;
    const zr = chart.getZr();
    let down: { x: number; y: number; t: number } | null = null;
    // Time under the pointer in whole nanoseconds (ECharts maps pixels to fractional values, and a window must be
    // integers), or null off the plot, on a distribution (no time axis) or when unconvertible.
    // A heatmap's x axis is a category index, mapped back to its bucket's time.
    const timeAt = (e: ZrEvent): number | null => {
      const { display, results: rs } = live.current;
      if (display === 'distribution' || !chart.containPixel('grid', [e.offsetX, e.offsetY])) return null;
      const v = chart.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]);
      const x = Array.isArray(v) ? Number(v[0]) : Number.NaN;
      if (!Number.isFinite(x)) return null;
      if (display !== 'heatmap') return Math.round(x);
      const { t0, width } = heatAxis(rs);
      return t0 + Math.round(x) * width;
    };
    const onDown = (e: ZrEvent): void => {
      const t = timeAt(e);
      down = t === null ? null : { x: e.offsetX, y: e.offsetY, t };
    };
    const onUp = (e: ZrEvent): void => {
      const d = down;
      down = null;
      if (d === null || Math.abs(e.offsetX - d.x) < DRAG_PX) return;
      const a = d.t;
      // A drag released beyond the plot's edge zooms to that edge.
      const atEdge = (): number | null => {
        const x = Math.min(Math.max(e.offsetX, GRID.left), chart.getWidth() - GRID.right);
        return timeAt({ ...e, offsetX: x, offsetY: d.y });
      };
      const b = timeAt(e) ?? atEdge();
      if (b === null) return;
      const { display, results: rs } = live.current;
      // A heatmap column spans its whole bucket.
      if (display === 'heatmap') {
        live.current.onZoom({ start: Math.min(a, b), end: Math.max(a, b) + heatAxis(rs).width });
        return;
      }
      live.current.onZoom({ start: Math.min(a, b), end: Math.max(a, b) });
    };
    const onClick = (e: ZrEvent): void => {
      if (down !== null) return;
      const { results: rs, display, scale, exemplars, hasTrace: check } = live.current;
      const t = timeAt(e);
      const first = rs[0];
      // A click off the plot opens nothing, and ends an earlier click's pending lookup as a later click would.
      const mine = ++seq.current;
      if (t === null || first === undefined) return;
      // The bucket under the click, at the width of the query the menu is for (they can differ in a combined chart).
      const windowAt = (queryId: string): TimeWindow => {
        const width = rs.find((r) => r.queryId === queryId)?.widthNs ?? first.widthNs;
        const start = Math.floor(t / width) * width;
        return { start, end: start + width };
      };
      let hit: { traceId: string; spanId: string | null; queryId: string } | null = null;
      let best = HIT_PX;
      if (exemplars && display !== 'heatmap') {
        for (const r of rs)
          for (const x of r.exemplars) {
            if (x.traceId === null) continue;
            const p = chart.convertToPixel({ gridIndex: 0 }, [x.time, x.value]);
            if (!Array.isArray(p)) continue;
            const dist = Math.hypot(Number(p[0]) - e.offsetX, Number(p[1]) - e.offsetY);
            if (dist <= best) {
              best = dist;
              hit = { traceId: x.traceId, spanId: x.spanId, queryId: r.queryId };
            }
          }
      }
      const open = (trace: Trace | null): void => {
        // A slower lookup from an earlier click must not replace a later one.
        if (mine !== seq.current) return;
        const queryIds = hit === null ? queriesAt(chart, rs, display, scale, t, e.offsetY) : [hit.queryId];
        setMenu({
          x: e.event.clientX,
          y: e.event.clientY,
          window: windowAt(queryIds[0] ?? first.queryId),
          queryIds,
          trace,
        });
      };
      if (hit === null) {
        open(null);
        return;
      }
      const { traceId, spanId } = hit;
      // The menu opens once the lookup settles, so its trace item is never wrong.
      check(traceId).then(
        (ok) => open({ traceId, spanId, state: ok ? 'present' : 'absent' }),
        () => open({ traceId, spanId, state: 'unknown' }),
      );
    };
    zr.on('mousedown', onDown as (e: unknown) => void);
    zr.on('mouseup', onUp as (e: unknown) => void);
    zr.on('click', onClick as (e: unknown) => void);
    return () => {
      zr.off('mousedown', onDown as (e: unknown) => void);
      zr.off('mouseup', onUp as (e: unknown) => void);
      zr.off('click', onClick as (e: unknown) => void);
    };
  }, [chart]);

  const anchor = useMemo(
    () =>
      menu === null
        ? undefined
        : {
            getBoundingClientRect: () =>
              ({
                x: menu.x,
                y: menu.y,
                left: menu.x,
                top: menu.y,
                right: menu.x,
                bottom: menu.y,
                width: 0,
                height: 0,
                toJSON: () => ({}),
              }) satisfies DOMRect,
          },
    [menu],
  );

  const pick = useCallback(
    (p: ChartPick): void => {
      setMenu(null);
      props.onPick(p);
    },
    [props.onPick],
  );

  const seriesCount = results.reduce((n, r) => n + r.series.length, 0);
  return (
    <section
      aria-label={props.title}
      aria-busy={props.busy === true ? true : undefined}
      className="rounded-card border border-hairline bg-surface p-3"
    >
      <h3 className="truncate text-sm font-medium">{props.title}</h3>
      <p className="truncate text-xs text-muted">{props.subtitle}</p>
      {props.notes.length > 0 && (
        <div className="mt-1 flex items-start gap-1.5 text-xs text-muted">
          <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
          <ul aria-label="Notes" className="list-none">
            {props.notes.map((n, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: notes are a static ordered list and may repeat
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      <Chart
        option={option}
        height={METRIC_CHART_HEIGHT[props.size]}
        ariaLabel={`${props.title}: ${seriesCount} series`}
        onInstance={setChart}
      />
      <Menu.Root open={menu !== null} onOpenChange={(o) => !o && setMenu(null)}>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4} {...(anchor === undefined ? {} : { anchor })}>
            <Menu.Popup className={POPUP}>
              {menu?.trace?.state === 'present' && props.onSelectTrace !== undefined && (
                <Menu.Item
                  className={ITEM}
                  onClick={() => {
                    const id = menu.trace?.traceId;
                    setMenu(null);
                    if (id !== undefined) props.onSelectTrace?.(parseTraceId(id, 'exemplar.traceId'));
                  }}
                >
                  Select this trace
                </Menu.Item>
              )}
              {menu?.trace != null &&
                (menu.trace.state === 'present' ? (
                  <Menu.Item
                    className={ITEM}
                    onClick={() =>
                      menu.trace &&
                      pick({ kind: 'exemplar', traceId: menu.trace.traceId, spanId: menu.trace.spanId })
                    }
                  >
                    Open exemplar trace
                  </Menu.Item>
                ) : (
                  <Menu.Item disabled className={ITEM}>
                    {menu.trace.state === 'absent' ? 'trace not in this report' : 'trace lookup failed'}
                  </Menu.Item>
                ))}
              {(['traces', 'logs'] as const).flatMap((kind) =>
                (menu?.queryIds ?? []).map((queryId, _, ids) => (
                  <Menu.Item
                    key={`${kind}:${queryId}`}
                    className={ITEM}
                    onClick={() => menu && pick({ kind, window: menu.window, queryId })}
                  >
                    {kind === 'traces' ? 'Traces' : 'Logs'} in this window
                    {ids.length > 1 ? ` (${props.queryLabels?.[queryId] ?? queryId})` : ''}
                  </Menu.Item>
                )),
              )}
              <Menu.Item className={ITEM} onClick={() => menu && pick({ kind: 'zoom', window: menu.window })}>
                Zoom to this window
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </section>
  );
}
