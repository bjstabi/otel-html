const SERIES_COUNT = 8;

function pick(tokens: Record<string, string>, name: string, fallback: string): string {
  return tokens[name] ?? fallback;
}

/** Builds an ECharts theme object from resolved CSS custom property values. */
export function buildEchartsTheme(tokens: Record<string, string>): object {
  const ink = pick(tokens, '--oh-ink', '#16181d');
  const muted = pick(tokens, '--oh-muted', '#6b6f78');
  const hairline = pick(tokens, '--oh-hairline', '#e4e4de');
  const surface = pick(tokens, '--oh-surface', '#ffffff');
  const mono = pick(tokens, '--oh-font-mono', 'monospace');
  const color: string[] = [];
  for (let i = 1; i < SERIES_COUNT; i++) color.push(pick(tokens, `--oh-series-${i}`, ink));
  color.push(pick(tokens, '--oh-series-other', muted));

  const axis = {
    axisLine: { lineStyle: { color: hairline } },
    axisTick: { show: false },
    axisLabel: { color: muted, fontFamily: mono, fontSize: 11 },
    splitLine: { show: true, lineStyle: { color: hairline, opacity: 0.6, width: 1 } },
  };
  return {
    color,
    backgroundColor: 'transparent',
    textStyle: { color: ink, fontFamily: mono },
    line: { lineStyle: { width: 2 }, symbolSize: 6, smooth: false },
    bar: { itemStyle: { borderRadius: [2, 2, 0, 0] } },
    categoryAxis: axis,
    valueAxis: axis,
    timeAxis: axis,
    logAxis: axis,
    legend: { textStyle: { color: ink } },
    tooltip: {
      backgroundColor: ink,
      borderColor: ink,
      textStyle: { color: surface, fontFamily: mono, fontSize: 12 },
    },
  };
}
