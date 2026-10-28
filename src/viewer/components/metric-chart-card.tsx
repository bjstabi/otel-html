import { Menu } from '@base-ui/react/menu';
import { Info } from 'lucide-react';
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MetricQueryResult } from '../data/metric-query.js';
import type { TimeWindow } from '../data/span-query.js';
import type { METRIC_DISPLAYS, METRIC_SCALES } from '../state/metric-state.js';
import { useColorAssigner } from '../theme/colors-context.js';
import { Chart, type EChartsType } from './chart.js';
import { buildMetricChartOption, METRIC_CHART_HEIGHT, type MetricSize } from './metric-chart-option.js';

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
  window?: TimeWindow | null;
  /** Whether the report holds a trace; without it every exemplar trace is assumed present. */
  hasTrace?: (traceId: string) => Promise<boolean>;
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
  queryId: string;
  trace: Trace | null;
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

  const unit = results[0]?.series[0]?.unit ?? '1';
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
        window: props.window ?? null,
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
      themeTick,
    ],
  );

  // Latest values for the zrender handlers, which are bound once per chart instance.
  const live = useRef({ results, exemplars: props.exemplars, hasTrace, onZoom });
  live.current = { results, exemplars: props.exemplars, hasTrace, onZoom };

  useEffect(() => {
    if (chart === null) return;
    const zr = chart.getZr();
    let down: { x: number; y: number; t: number } | null = null;
    const timeAt = (e: ZrEvent): number => {
      const v = chart.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]);
      return Array.isArray(v) ? Number(v[0]) : 0;
    };
    const onDown = (e: ZrEvent): void => {
      down = { x: e.offsetX, y: e.offsetY, t: timeAt(e) };
    };
    const onUp = (e: ZrEvent): void => {
      const d = down;
      down = null;
      if (d === null || Math.abs(e.offsetX - d.x) < DRAG_PX) return;
      const a = d.t;
      const b = timeAt(e);
      live.current.onZoom({ start: Math.min(a, b), end: Math.max(a, b) });
    };
    const onClick = (e: ZrEvent): void => {
      if (down !== null) return;
      const { results: rs, exemplars, hasTrace: check } = live.current;
      const t = timeAt(e);
      const first = rs[0];
      if (first === undefined) return;
      const width = first.widthNs;
      const start = Math.floor(t / width) * width;
      const window = { start, end: start + width };
      let hit: { traceId: string; spanId: string | null; queryId: string } | null = null;
      let best = HIT_PX;
      if (exemplars) {
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
      const open = (trace: Trace | null): void =>
        setMenu({
          x: e.event.clientX,
          y: e.event.clientY,
          window,
          queryId: hit?.queryId ?? first.queryId,
          trace,
        });
      if (hit === null) {
        open(null);
        return;
      }
      const { traceId, spanId } = hit;
      if (check === undefined) {
        open({ traceId, spanId, state: 'present' });
        return;
      }
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
    <section aria-label={props.title} className="rounded-card border border-hairline bg-surface p-3">
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
              <Menu.Item
                className={ITEM}
                onClick={() => menu && pick({ kind: 'traces', window: menu.window, queryId: menu.queryId })}
              >
                Traces in this window
              </Menu.Item>
              <Menu.Item
                className={ITEM}
                onClick={() => menu && pick({ kind: 'logs', window: menu.window, queryId: menu.queryId })}
              >
                Logs in this window
              </Menu.Item>
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
