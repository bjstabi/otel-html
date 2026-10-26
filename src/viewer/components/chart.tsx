import { BarChart, CustomChart, LineChart, PieChart, ScatterChart, TreemapChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { type EChartsType, init, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { type JSX, useEffect, useRef } from 'react';
import { buildEchartsTheme } from '../theme/echarts-theme.js';
import { useTheme } from '../theme/theme-provider.js';

use([
  LineChart,
  BarChart,
  PieChart,
  ScatterChart,
  TreemapChart,
  CustomChart,
  DataZoomComponent,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);

const TOKEN_NAMES: readonly string[] = [
  '--oh-ink',
  '--oh-muted',
  '--oh-hairline',
  '--oh-surface',
  '--oh-font-mono',
  '--oh-series-other',
  ...[1, 2, 3, 4, 5, 6, 7].map((i) => `--oh-series-${i}`),
];

function readTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const name of TOKEN_NAMES) {
    const v = style.getPropertyValue(name).trim();
    if (v !== '') out[name] = v;
  }
  return out;
}

type Option = Parameters<EChartsType['setOption']>[0];
export type ChartEvents = Readonly<Record<string, (params: unknown) => void>>;

export interface ChartProps {
  option: Option;
  onEvents?: ChartEvents;
  height?: number;
  /** Accessible description of what the chart shows. */
  ariaLabel: string;
  /** Called with the live instance after mount and with null on unmount (for imperative sync such as linked zoom). */
  onInstance?: (chart: EChartsType | null) => void;
}

export type { EChartsType };

/** Tree-shaken ECharts wrapper; rebuilds the instance with the runtime theme when light/dark changes. */
export function Chart({ option, onEvents, height = 240, ariaLabel, onInstance }: ChartProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();

  const chartRef = useRef<EChartsType | null>(null);
  const instanceCb = useRef(onInstance);
  instanceCb.current = onInstance;

  // One instance per mount; the theme is swapped in place with setTheme.
  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const chart = init(el, buildEchartsTheme(readTokens()));
    chartRef.current = chart;
    instanceCb.current?.(chart);
    // ResizeObserver reports the initial size on observe; re-laying out at an unchanged size re-renders every series.
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === chart.getWidth() && el.clientHeight === chart.getHeight()) return;
      chart.resize();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      instanceCb.current?.(null);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resolved` triggers re-reading the CSS variables
  useEffect(() => {
    chartRef.current?.setTheme(buildEchartsTheme(readTokens()));
  }, [resolved]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    // Subscribe first: a render's `rendered`/`finished` events can fire during setOption itself.
    const entries = Object.entries(onEvents ?? {});
    for (const [name, handler] of entries) chart.on(name, handler);
    chart.setOption(option, true);
    return () => {
      for (const [name, handler] of entries) chart.off(name, handler);
    };
  }, [option, onEvents]);

  return <div ref={host} style={{ height }} role="img" aria-label={ariaLabel} />;
}
