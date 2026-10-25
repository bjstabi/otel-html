import { BarChart, LineChart, PieChart, ScatterChart, TreemapChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
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
}

/** Tree-shaken ECharts wrapper; rebuilds the instance with the runtime theme when light/dark changes. */
export function Chart({ option, onEvents, height = 240, ariaLabel }: ChartProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();

  const chartRef = useRef<EChartsType | null>(null);

  // One instance per mount; the theme is swapped in place with setTheme.
  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    const chart = init(el, buildEchartsTheme(readTokens()));
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
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
    chart.setOption(option, true);
    const entries = Object.entries(onEvents ?? {});
    for (const [name, handler] of entries) chart.on(name, handler);
    return () => {
      for (const [name, handler] of entries) chart.off(name, handler);
    };
  }, [option, onEvents]);

  return <div ref={host} style={{ height }} role="img" aria-label={ariaLabel} />;
}
