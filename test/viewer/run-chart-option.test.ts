import { LineChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { RunControls } from '../../src/dashboards/schema.js';
import { runDateTime, shortLabel } from '../../src/viewer/components/run-chart-format.js';
import {
  buildRunChartOption,
  guideSeries,
  lineColors,
  type RunChartInput,
  runsInView,
  runYAxes,
  zoomFromEvent,
} from '../../src/viewer/components/run-chart-option.js';
import type { RunLine, RunQueryResult } from '../../src/viewer/data/metric-results.js';
import { createColorAssigner, STATUS } from '../../src/viewer/theme/palette.js';

use([
  LineChart,
  DataZoomComponent,
  GridComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  SVGRenderer,
]);

interface Item {
  value: [number, number];
  symbol?: string;
  itemStyle?: { color?: string };
  meta: { line: string; label: string; value: number; failed: boolean; runIndex: number };
}
interface Series {
  id: string;
  name?: string;
  xAxisIndex: number;
  yAxisIndex: number;
  data: Item[];
  connectNulls?: boolean;
  cursor?: string;
  showSymbol?: boolean;
  emphasis?: { focus?: string };
  itemStyle?: { color?: string };
  lineStyle: { color?: string; type?: unknown };
  markLine?: { data: { xAxis: number }[] };
}
interface Axis {
  type: string;
  min?: number;
  max?: number;
  data?: string[];
  axisLabel: { show: boolean; formatter: (v: number | string) => string };
}
interface Zoom {
  type: string;
  xAxisIndex: number[];
  filterMode: string;
  zoomOnMouseWheel?: unknown;
  moveOnMouseWheel?: unknown;
  moveOnMouseMove?: unknown;
  startValue?: number;
  endValue?: number;
}
interface Opt {
  animation: boolean;
  grid: { height: number; width: number }[];
  title: { text: string }[];
  xAxis: Axis[];
  yAxis: { max: number }[];
  dataZoom: Zoom[];
  tooltip: {
    trigger: string;
    confine: boolean;
    extraCssText: string;
    formatter: (p: unknown) => string;
  };
  series: Series[];
}

// Canvas can't read a token, and jsdom has no stylesheet: give each a value so that colors can differ.
const OTHER_COLOR = '#808080';
beforeAll(() => {
  const root = document.documentElement.style;
  for (let i = 1; i <= 7; i++) root.setProperty(`--oh-series-${i}`, `#00000${i}`);
  root.setProperty('--oh-series-other', OTHER_COLOR);
});

const HOUR = 3600e9;
const EPOCH = '1760000000000000000';
const EPOCH_MS = 1760000000000;
const OUTLIER = 'job-a';
const NAMES = [OUTLIER, 'job-b', 'job-c', 'job-d', 'job-e', 'job-f', 'job-g', 'job-h', 'job-i'];
const CONTROLS: RunControls = { slider: true, evenSpacing: true, split: true, legend: false };

function line(label: string, values: (number | null)[], unit = 's', failed: number[] = []): RunLine {
  return {
    key: `key:${label}`,
    label,
    unit,
    points: values.map((value, i) => (value === null ? null : { value, failed: failed.includes(i) })),
  };
}

function result(lines: RunLine[], runCount: number): RunQueryResult {
  return {
    queryId: 'a',
    runs: Array.from({ length: runCount }, (_, i) => ({
      id: `run-${i}`,
      time: (i + 1) * HOUR,
      revision: i === 1 ? 'abcdef0123456789' : null,
    })),
    lines,
    leftOut: 0,
    window: { start: 0, end: (runCount + 1) * HOUR },
    notes: [],
  };
}

/** 28 runs and 9 lines; run 0 of the first line is a 1254 s outlier, and everything else is at most 470 s. */
function fixture(): RunQueryResult {
  return result(
    NAMES.map((name, n) =>
      line(
        name,
        Array.from({ length: 28 }, (_, i) => (n === 0 && i === 0 ? 1254 : 200 + ((i * 10) % 270))),
      ),
    ),
    28,
  );
}

function input(over: Partial<RunChartInput> = {}): RunChartInput {
  return {
    result: fixture(),
    controls: CONTROLS,
    hidden: new Set(),
    zoom: null,
    width: 1200,
    height: 600,
    colors: createColorAssigner(),
    epochUnixNano: EPOCH,
    selectedRun: null,
    pickable: true,
    echarts: null,
    ...over,
  };
}

const build = (over: Partial<RunChartInput> = {}): Opt =>
  buildRunChartOption(input(over)).option as unknown as Opt;
const lineSeries = (o: Opt): Series[] => o.series.filter((s) => !s.id.startsWith('guide'));
const guides = (o: Opt): Series[] => o.series.filter((s) => s.id.startsWith('guide'));
const single = (over: Partial<RunChartInput> = {}): Opt =>
  build({ controls: { ...CONTROLS, split: false }, ...over });
const timeAxis = (over: Partial<RunChartInput> = {}): Opt =>
  build({ controls: { ...CONTROLS, evenSpacing: false }, ...over });

/** The zoom that holds runs `a` to `b` of the fixture. */
const zoomOf = (a: number, b: number): { start: number; end: number } => ({
  start: (a + 1) * HOUR,
  end: (b + 1) * HOUR,
});

describe('plots', () => {
  test('split gives each of 9 lines a grid, with one slider driving all of them', () => {
    const o = build();
    expect(o.grid.length).toBe(9);
    expect(o.xAxis.length).toBe(9);
    const slider = o.dataZoom.find((z) => z.type === 'slider');
    expect(slider?.xAxisIndex).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(o.yAxis.length).toBe(9);
    expect(o.title.map((t) => t.text)).toEqual(NAMES.map(shortLabel));
  });

  test('split off holds every line in one grid, with no titles', () => {
    const o = single();
    expect(o.grid.length).toBe(1);
    expect(o.title).toEqual([]);
    expect(new Set(lineSeries(o).map((s) => s.xAxisIndex))).toEqual(new Set([0]));
    expect(lineSeries(o).length).toBe(9);
  });

  test('small chart titles use the short label', () => {
    const r = result([line('binary (ubuntu-24.04-arm, linux-arm64)', [1]), line('b', [2])], 1);
    expect(build({ result: r }).title[0]?.text).toBe('binary linux-arm64');
  });

  test('slider off drops the slider, keeps inside zoom, and makes the grid taller', () => {
    const on = single();
    const off = single({ controls: { ...CONTROLS, split: false, slider: false } });
    expect(off.dataZoom.some((z) => z.type === 'slider')).toBe(false);
    expect(off.dataZoom.some((z) => z.type === 'inside')).toBe(true);
    expect(off.grid[0]?.height).toBeGreaterThan(on.grid[0]?.height ?? 0);
  });

  test('hiding lines lets the others grow and leaves no gap', () => {
    const all = build();
    const hid = build({ hidden: new Set(NAMES.slice(1, 7).map((n) => `key:${n}`)) });
    expect(hid.grid.length).toBe(3);
    expect(hid.xAxis.length).toBe(3);
    expect(hid.yAxis.length).toBe(3);
    expect(guides(hid).length).toBe(3);
    expect(hid.grid[0]?.height).toBeGreaterThan(all.grid[0]?.height ?? 0);
    expect(lineSeries(hid).map((s) => s.xAxisIndex)).toEqual([0, 1, 2]);
    expect(lineSeries(hid).map((s) => s.name)).toEqual([OUTLIER, 'job-h', 'job-i']);
  });

  test('a split too small to fit falls back to one plot and says so', () => {
    const { option, splitFits } = buildRunChartOption(input({ height: 200 }));
    expect(splitFits).toBe(false);
    expect((option as unknown as Opt).grid.length).toBe(1);
    expect(buildRunChartOption(input()).splitFits).toBe(true);
  });

  test('mixed units force a split, even when off or too small', () => {
    const r = result([line('a', [1, 2]), line('b', [3, 4], 'By')], 2);
    const off = build({ result: r, controls: { ...CONTROLS, split: false } });
    expect(off.grid.length).toBe(2);
    const { option, splitFits } = buildRunChartOption(input({ result: r, height: 90 }));
    expect((option as unknown as Opt).grid.length).toBe(2);
    expect(splitFits).toBe(true);
    expect(runYAxes({ result: r, controls: CONTROLS, hidden: new Set(), zoom: null }, false).length).toBe(2);
  });
});

describe('zoom', () => {
  test('plain scrolling and dragging do nothing, ctrl+scroll zooms, and lines run off the edge', () => {
    const o = build();
    const inside = o.dataZoom.find((z) => z.type === 'inside');
    expect(inside?.zoomOnMouseWheel).toBe('ctrl');
    expect(inside?.moveOnMouseWheel).toBe(false);
    expect(inside?.moveOnMouseMove).toBe(false);
    expect(inside?.xAxisIndex).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const z of o.dataZoom) expect(z.filterMode).toBe('none');
  });

  test('even spacing sets the window as run indexes', () => {
    for (const z of build({ zoom: zoomOf(3, 27) }).dataZoom) {
      expect(z.startValue).toBe(3);
      expect(z.endValue).toBe(27);
    }
  });

  test('real time sets the window on the axis scale, and the same runs stay in view', () => {
    const o = timeAxis({ zoom: zoomOf(3, 27) });
    const x = (i: number): number | undefined => lineSeries(o)[0]?.data[i]?.value[0];
    for (const z of o.dataZoom) {
      expect(z.startValue).toBe(x(3));
      expect(z.endValue).toBe(x(27));
    }
  });

  test('no zoom sets no window', () => {
    for (const z of build().dataZoom) expect(z.startValue).toBeUndefined();
  });

  test('runsInView is inclusive at both ends', () => {
    const r = fixture();
    expect(runsInView(r, null).length).toBe(28);
    expect(runsInView(r, zoomOf(3, 5)).map((x) => x.id)).toEqual(['run-3', 'run-4', 'run-5']);
    expect(runsInView(r, { start: 1.2 * HOUR, end: 1.3 * HOUR })).toEqual([]);
  });

  test('zoomFromEvent round trip with even spacing', () => {
    const r = fixture();
    expect(zoomFromEvent(r, true, 3, 27, EPOCH)).toEqual({ start: r.runs[3]?.time, end: r.runs[27]?.time });
    expect(zoomFromEvent(r, true, 0, 27, EPOCH)).toBeNull();
  });

  test('zoomFromEvent round trip on real time is exact to the run, including sub-millisecond times', () => {
    const r = result([line('a', [1, 2, 3, 4])], 4);
    const times = [1234567890123, 7777777777777, 9007199254740, 12345678912345];
    for (const [i, run] of r.runs.entries()) run.time = times[i] ?? 0;
    const o = timeAxis({ result: r });
    const x = lineSeries(o)[0]?.data.map((d) => d.value[0]) ?? [];
    expect(zoomFromEvent(r, false, x[1] ?? 0, x[2] ?? 0, EPOCH)).toEqual({ start: times[1], end: times[2] });
    expect(zoomFromEvent(r, false, x[0] ?? 0, x[3] ?? 0, EPOCH)).toBeNull();
    expect(runsInView(r, zoomFromEvent(r, false, x[1] ?? 0, x[2] ?? 0, EPOCH)).length).toBe(2);
  });

  test('the axis carries absolute ms, exact past what a float holds of the epoch in nanos', () => {
    const epochUnixNano = '1760000000123456789';
    const r = result([line('a', [1, 2])], 2);
    const times = [1234567890123, 7777777777777];
    for (const [i, run] of r.runs.entries()) run.time = times[i] ?? 0;
    const o = timeAxis({ result: r, epochUnixNano });
    const x = lineSeries(o)[0]?.data.map((d) => d.value[0]) ?? [];
    expect(x).toEqual([1760000000123 + 1234568, 1760000000123 + 7777778]);
    expect(zoomFromEvent(r, false, x[0] ?? 0, x[0] ?? 0, epochUnixNano)).toEqual({
      start: times[0],
      end: times[0],
    });
    expect(zoomFromEvent(r, false, x[0] ?? 0, x[1] ?? 0, epochUnixNano)).toBeNull();
  });

  test('zoomFromEvent on real time keeps a window edge between runs, so the slider is not snapped away', () => {
    const r = fixture();
    const start = 3.5 * HOUR;
    const at = (rel: number): number => EPOCH_MS + rel / 1e6;
    expect(zoomFromEvent(r, false, at(start), at(r.runs[27]?.time ?? 0), EPOCH)).toEqual({
      start,
      end: r.runs[27]?.time,
    });
  });

  test('zoomFromEvent has no zoom to hold without runs', () => {
    const r = result([], 0);
    expect(zoomFromEvent(r, true, 0, 0, EPOCH)).toBeNull();
    expect(zoomFromEvent(r, false, 0, 1, EPOCH)).toBeNull();
  });
});

describe('x axis', () => {
  test('even spacing is a category axis whose points sit at run indexes', () => {
    const o = build();
    expect(o.xAxis[0]?.type).toBe('category');
    expect(lineSeries(o)[0]?.data.map((d) => d.value[0])).toEqual(Array.from({ length: 28 }, (_, i) => i));
  });

  test('real time is a time axis, and a run has one x on every line', () => {
    const o = timeAxis();
    expect(o.xAxis[0]?.type).toBe('time');
    expect(new Set(lineSeries(o).map((s) => s.data[5]?.value[0])).size).toBe(1);
    const x = lineSeries(o)[0]?.data.map((d) => d.value[0]) ?? [];
    expect(o.xAxis[0]?.min).toBe(x[0]);
    expect(o.xAxis[0]?.max).toBe(x[27]);
  });

  test('labels are the local date over the local time, on both kinds of axis', () => {
    const r = fixture();
    const d = runDateTime(EPOCH, r.runs[3]?.time ?? 0);
    const want = `${d.date}\n${d.time}`;
    const even = build().xAxis[8];
    expect(even?.axisLabel.formatter(even.data?.[3] ?? '')).toBe(want);
    const real = timeAxis();
    const x = lineSeries(real)[0]?.data[3]?.value[0] ?? 0;
    expect(real.xAxis[8]?.axisLabel.formatter(x)).toBe(want);
  });

  test('only the bottom row shows labels', () => {
    const o = build();
    expect(o.xAxis.map((a) => a.axisLabel.show)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(single().xAxis[0]?.axisLabel.show).toBe(true);
  });
});

describe('y scale', () => {
  const y = (over: Partial<RunChartInput>, split = false): number[] =>
    runYAxes({ ...input(over) }, split).map((a) => a.max);

  test('follows the runs in view, both ways', () => {
    expect(y({})).toEqual([1500]);
    expect(y({ zoom: zoomOf(1, 27) })).toEqual([480]);
  });

  test('ignores hidden lines', () => {
    expect(y({ hidden: new Set([`key:${OUTLIER}`]) })).toEqual([480]);
  });

  test('a zoom holding no run falls back to the full scale', () => {
    expect(y({ zoom: { start: 1.2 * HOUR, end: 1.3 * HOUR } })).toEqual([1500]);
  });

  test('split gives one axis per visible plot, each from its own line and with fewer ticks', () => {
    const axes = runYAxes(input({ hidden: new Set(['key:job-c']) }), true);
    expect(axes.length).toBe(8);
    expect(axes[0]?.max).toBe(1800);
    expect(axes[1]?.max).toBe(600);
    const single = runYAxes(input(), false);
    expect(single.length).toBe(1);
    expect(single[0]?.interval).toBe(300);
  });

  test('a single visible line on a split reads as a single plot', () => {
    const hidden = new Set(NAMES.slice(1).map((n) => `key:${n}`));
    expect(runYAxes(input({ hidden }), true)).toEqual([{ min: 0, max: 1500, interval: 300 }]);
  });

  test('the builder applies the axes', () => {
    expect(single().yAxis[0]?.max).toBe(1500);
    expect(single({ zoom: zoomOf(1, 27) }).yAxis[0]?.max).toBe(480);
  });
});

describe('dots and lines', () => {
  test('lines join across runs they lack', () => {
    const r = result([line('a', [1, null, 3])], 3);
    const s = lineSeries(build({ result: r }))[0];
    expect(s?.connectNulls).toBe(true);
    expect(s?.data.map((d) => d.value)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  test('a pickable chart has the pointer cursor, and any other the default', () => {
    for (const s of lineSeries(build({ pickable: true }))) expect(s.cursor).toBe('pointer');
    for (const s of lineSeries(build({ pickable: false }))) expect(s.cursor).toBe('default');
  });

  test('a failed point is a status-colored diamond', () => {
    const r = result([line('a', [1, 2], 's', [1])], 2);
    const data = lineSeries(build({ result: r }))[0]?.data ?? [];
    expect(data[1]?.symbol).toBe('diamond');
    expect(data[1]?.itemStyle?.color).toBe(STATUS.critical);
    expect(data[0]?.symbol).toBeUndefined();
  });

  test('each item carries its meta', () => {
    const r = result([line('a', [1, 2], 's', [1])], 2);
    expect(lineSeries(build({ result: r }))[0]?.data[1]?.meta).toEqual({
      line: 'key:a',
      label: 'a',
      value: 2,
      failed: true,
      run: r.runs[1],
      runIndex: 1,
    });
  });

  test('hover dims other lines on a single plot only', () => {
    for (const s of lineSeries(single())) expect(s.emphasis?.focus).toBe('series');
    for (const s of lineSeries(build())) expect(s.emphasis?.focus).toBeUndefined();
  });
});

describe('color', () => {
  const colorsOf = (o: Opt): Map<string, string | undefined> =>
    new Map(lineSeries(o).map((s) => [s.name ?? '', s.lineStyle.color]));

  test('a line keeps its color when another is hidden or the zoom changes, on a fresh assigner too', () => {
    const before = colorsOf(build());
    const hiddenFirst = colorsOf(build({ hidden: new Set([`key:${OUTLIER}`]) }));
    const zoomed = colorsOf(build({ zoom: zoomOf(3, 9) }));
    for (const name of NAMES.slice(1)) {
      expect(hiddenFirst.get(name)).toBe(before.get(name));
      expect(zoomed.get(name)).toBe(before.get(name));
    }
    expect(new Set(before.values()).size).toBe(NAMES.length);
  });

  test('lines past the seventh keep colors of their own, not the other color', () => {
    const colors = lineSeries(build()).map((s) => s.lineStyle.color);
    expect(colors).not.toContain(OTHER_COLOR);
    expect(new Set(colors).size).toBe(NAMES.length);
  });
});

describe('swatch', () => {
  test('lineColors is what the series draw, hidden lines included', () => {
    const r = fixture();
    const colors = lineColors(r, createColorAssigner());
    const hidden = new Set(['key:job-a']);
    for (const s of lineSeries(build({ result: r, hidden }))) {
      expect(s.lineStyle.color).toBe(colors.get(s.id.slice('line:'.length)));
    }
  });
});

describe('tooltip', () => {
  const r = (): RunQueryResult => result([line('<img src=x>', [1, 90], 's', [1]), line('b', [3, 4])], 2);
  const tip = (data: unknown): string => build({ result: r() }).tooltip.formatter({ marker: '', data });
  const itemAt = (i: number): Item | undefined => lineSeries(build({ result: r() }))[0]?.data[i];

  test('opens only on a dot and stays inside the widget', () => {
    const t = build().tooltip;
    expect(t.trigger).toBe('item');
    expect(t.confine).toBe(true);
    expect(t.extraCssText).toContain('max-width:280px');
  });

  test('escapes what comes from the data', () => {
    const html = tip(itemAt(0));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
  });

  test('escapes the revision too', () => {
    const q = r();
    const run = q.runs[0];
    if (run !== undefined) run.revision = '<b>xxxxxx';
    const o = build({ result: q });
    const html = o.tooltip.formatter({ marker: '', data: lineSeries(o)[0]?.data[0] });
    expect(html).not.toContain('<b>x');
  });

  test('says failed only for a failed point', () => {
    expect(tip(itemAt(0))).not.toContain('failed');
    expect(tip(itemAt(1))).toContain('failed');
  });

  test('shows the value, the local time and the short commit', () => {
    const html = tip(itemAt(1));
    const d = runDateTime(EPOCH, 2 * HOUR);
    expect(html).toContain('90 s');
    expect(html).toContain(d.time);
    expect(html).toContain(d.date);
    expect(html).toContain('abcdef0');
    expect(html).not.toContain('abcdef01');
  });
});

describe('guide', () => {
  test('every plot has an empty guide series when no run is selected', () => {
    const g = guides(build());
    expect(g.map((s) => s.id)).toEqual(Array.from({ length: 9 }, (_, i) => `guide${i}`));
    for (const s of g) expect(s.markLine?.data).toEqual([]);
  });

  test('selectedRun draws it on every plot', () => {
    for (const s of guides(build({ selectedRun: 'run-3' }))) expect(s.markLine?.data).toEqual([{ xAxis: 3 }]);
    const o = timeAxis({ selectedRun: 'run-3' });
    expect(guides(o)[8]?.markLine?.data).toEqual([{ xAxis: lineSeries(o)[0]?.data[3]?.value[0] }]);
  });

  test('a selected run that is not in the result draws nothing', () => {
    expect(guides(build({ selectedRun: 'nope' }))[0]?.markLine?.data).toEqual([]);
  });

  test('guideSeries sits on its plot', () => {
    const g = guideSeries(2, 5) as unknown as Series;
    expect(g.id).toBe('guide2');
    expect(g.xAxisIndex).toBe(2);
    expect(g.yAxisIndex).toBe(2);
    expect(g.markLine?.data).toEqual([{ xAxis: 5 }]);
  });
});

describe('edge cases', () => {
  test('one run draws dots and one column', () => {
    const o = build({ result: result([line('a', [5]), line('b', [6])], 1) });
    expect(o.xAxis[0]?.data?.length).toBe(1);
    for (const s of lineSeries(o)) {
      expect(s.showSymbol).toBe(true);
      expect(s.data.length).toBe(1);
    }
  });

  test('no runs gives no series', () => {
    expect(build({ result: result([], 0) }).series).toEqual([]);
    expect(build({ result: result([], 0), controls: { ...CONTROLS, evenSpacing: false } }).series).toEqual(
      [],
    );
  });

  test('echarts merges last', () => {
    const o = build({ echarts: { animation: true } });
    expect(o.animation).toBe(true);
    expect(build().animation).toBe(false);
  });
});

describe('in the real ECharts', () => {
  // ECharts measures text on a canvas, which jsdom lacks; with none it estimates, which is enough here.
  beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  /** Renders through ECharts itself, since a wrong option often only throws or draws nothing there. */
  function render(over: Partial<RunChartInput>): string {
    const chart = init(null as unknown as HTMLElement, undefined, {
      renderer: 'svg',
      ssr: true,
      width: 1200,
      height: 600,
    });
    chart.setOption(buildRunChartOption(input(over)).option);
    const svg = chart.renderToSVGString();
    chart.dispose();
    return svg;
  }
  const realTime = { ...CONTROLS, evenSpacing: false };
  const oneRun = result([line('a', [5]), line('b', [6])], 1);

  test.each([
    ['even, split', {}],
    ['real time, split', { controls: realTime }],
    ['a zoom', { zoom: zoomOf(3, 9) }],
    ['a real time zoom holding no run', { controls: realTime, zoom: { start: 1.2 * HOUR, end: 1.3 * HOUR } }],
    ['one run', { result: oneRun }],
    ['one run on real time', { result: oneRun, controls: realTime }],
    ['no runs', { result: result([], 0) }],
    ['no runs on real time', { result: result([], 0), controls: realTime }],
  ] as [string, Partial<RunChartInput>][])('%s renders', (_, over) => {
    expect(render(over)).toContain('<svg');
  });

  test('a one-run chart draws the same dots on both axes, and a time axis shows local labels', () => {
    const d = runDateTime(EPOCH, HOUR);
    expect(render({ result: oneRun })).toContain(d.time);
    const circles = (s: string): number => (s.match(/<path d="M[^"]*A[^"]*"/g) ?? []).length;
    expect(circles(render({ result: oneRun }))).toBeGreaterThan(0);
    expect(circles(render({ result: oneRun, controls: realTime }))).toBeGreaterThan(0);
  });

  test('labels name the right runs under a zoom, and on real time', () => {
    const time = (i: number): string => runDateTime(EPOCH, (i + 1) * HOUR).time;
    const zoomed = render({ controls: { ...CONTROLS, split: false }, zoom: zoomOf(3, 9) });
    expect(zoomed).toContain(time(3));
    expect(zoomed).not.toContain(time(0));
    const real = render({ controls: { ...realTime, split: false } });
    expect(real).toContain(runDateTime(EPOCH, HOUR).date);
    expect(real).not.toContain('1970');
  });

  test('a time axis puts the ticks between its ends on round local times', () => {
    const ticksOf = (controls: RunControls, r: RunQueryResult, width: number): number[] => {
      const seen = new Set<number>();
      const { option } = buildRunChartOption(input({ result: r, controls, width }));
      const axis = (option as unknown as Opt).xAxis[0];
      const format = axis?.axisLabel.formatter;
      if (axis === undefined || format === undefined) throw new Error('no axis');
      axis.axisLabel.formatter = (v) => {
        seen.add(Number(v));
        return format(v);
      };
      const chart = init(null as unknown as HTMLElement, undefined, {
        renderer: 'svg',
        ssr: true,
        width,
        height: 600,
      });
      chart.setOption(option);
      chart.renderToSVGString();
      chart.dispose();
      return [...seen].sort((a, b) => a - b);
    };
    // Runs 7 minutes apart, off the epoch by seconds: nothing about the runs themselves lands on a round time.
    const r = result(
      [
        line(
          'a',
          Array.from({ length: 12 }, (_, i) => i + 1),
        ),
      ],
      12,
    );
    for (const [i, run] of r.runs.entries()) run.time = (i * 7 * 60 + 43) * 1e9;
    const ticks = ticksOf({ ...CONTROLS, evenSpacing: false, split: false }, r, 1200);
    const inner = ticks.slice(1, -1);
    expect(inner.length).toBeGreaterThan(0);
    for (const t of ticks) expect(t).toBeGreaterThanOrEqual(EPOCH_MS);
    for (const t of inner) {
      const d = new Date(t);
      expect(d.getSeconds()).toBe(0);
      expect(d.getMinutes() % 5).toBe(0);
    }
  });

  test('a guide draws on a category axis and on a real time axis', () => {
    const count = (over: Partial<RunChartInput>): number =>
      (render(over).match(/stroke-dasharray/g) ?? []).length;
    expect(count({ selectedRun: 'run-3' })).toBeGreaterThan(count({}));
    expect(count({ selectedRun: 'run-3', controls: realTime })).toBeGreaterThan(
      count({ controls: realTime }),
    );
  });
});
