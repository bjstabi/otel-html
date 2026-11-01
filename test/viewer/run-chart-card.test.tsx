import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RunControls } from '../../src/dashboards/schema.js';
import type { RunLine, RunQueryResult } from '../../src/viewer/data/metric-run-query.js';
import { ColorsProvider, useColorAssigner } from '../../src/viewer/theme/colors-context.js';

use([
  LineChart,
  DataZoomComponent,
  GridComponent,
  MarkLineComponent,
  TitleComponent,
  TooltipComponent,
  SVGRenderer,
]);

interface Opt {
  grid: { width: number; height: number }[];
  yAxis: { max: number }[];
  dataZoom: { startValue?: number; endValue?: number }[];
  series: {
    id: string;
    cursor?: string;
    markLine?: { data: { xAxis: number }[] };
    lineStyle?: { color?: string };
  }[];
}

type Handler = (e: unknown) => void;
const handlers = new Map<string, Handler>();
const calls: { option: Partial<Opt>; notMerge: boolean }[] = [];
const dispatched: unknown[] = [];
const zoomWindow = { startValue: 0, endValue: 0 };
const fakeChart = {
  on: (n: string, h: Handler): void => void handlers.set(n, h),
  off: (n: string): void => void handlers.delete(n),
  setOption: (option: Partial<Opt>, notMerge?: boolean): void => {
    calls.push({ option, notMerge: notMerge === true });
  },
  getOption: (): unknown => ({ dataZoom: [zoomWindow] }),
  dispatchAction: (a: unknown): void => void dispatched.push(a),
};
/** A real instance standing in for the fake, for what only ECharts itself can prove. */
let instance: typeof fakeChart | ReturnType<typeof init> = fakeChart;

// As the real Chart: the instance first, and every change of option or events is a `setOption(option, true)`.
vi.mock('../../src/viewer/components/chart.js', async () => {
  const { useEffect } = await import('react');
  return {
    Chart: (p: {
      ariaLabel: string;
      option: unknown;
      height?: number;
      onEvents?: Record<string, Handler>;
      onInstance?: (c: unknown) => void;
    }): React.JSX.Element => {
      useEffect(() => {
        p.onInstance?.(instance);
        return () => p.onInstance?.(null);
      }, [p.onInstance]);
      useEffect(() => {
        const entries = Object.entries(p.onEvents ?? {});
        for (const [name, h] of entries) (instance.on as (n: string, h: Handler) => void)(name, h);
        (instance.setOption as (o: unknown, n: boolean) => void)(p.option, true);
        return () => {
          for (const [name, h] of entries) (instance.off as (n: string, h: Handler) => void)(name, h);
        };
      }, [p.option, p.onEvents]);
      return <div role="img" aria-label={p.ariaLabel} data-height={p.height} />;
    },
  };
});

import {
  RunChartCard,
  type RunChartCardProps,
  type RunChartView,
} from '../../src/viewer/components/run-chart-card.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S = 1e9;
const size = { width: 1000, height: 600 };
const observers = new Set<() => void>();

class FakeResizeObserver {
  private readonly cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe(): void {
    observers.add(this.cb);
  }
  disconnect(): void {
    observers.delete(this.cb);
  }
}

async function resize(width: number, height: number): Promise<void> {
  size.width = width;
  size.height = height;
  await act(async () => {
    for (const cb of observers) cb();
  });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => size.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => size.height);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  handlers.clear();
  calls.length = 0;
  dispatched.length = 0;
  observers.clear();
  instance = fakeChart;
  size.width = 1000;
  size.height = 600;
  document.documentElement.removeAttribute('data-theme');
});

const line = (key: string, values: (number | null)[], label = key): RunLine => ({
  key,
  label,
  unit: 's',
  points: values.map((value) => (value === null ? null : { value, failed: false })),
});

function result(over: Partial<RunQueryResult> = {}): RunQueryResult {
  return {
    queryId: 'a',
    runs: [0, 1, 2, 3].map((n) => ({ id: `run${n}`, time: n * 100 * S, revision: null })),
    // The 1254 s outlier sits in run 2, and `fast` always sorts below `slow`.
    lines: [line('fast', [10, 20, 30, 40]), line('slow', [100, 470, 1254, 200])],
    leftOut: 0,
    window: { start: 0, end: 1000 * S },
    notes: [],
    ...over,
  };
}

const CONTROLS: RunControls = { slider: true, evenSpacing: true, split: false, legend: true };
const EPOCH_MS = 1_700_000_000_000;

function props(over: Partial<RunChartCardProps> = {}): RunChartCardProps {
  return {
    title: 'Job duration',
    subtitle: 's',
    result: result(),
    configured: CONTROLS,
    controls: CONTROLS,
    onControls: () => undefined,
    height: 700,
    epochUnixNano: `${EPOCH_MS}000000`,
    selectedRun: null,
    echarts: null,
    onPickRun: null,
    notes: [],
    ...over,
  };
}

/** Stands in for widgets that take every shared color before a run chart renders. */
function UseUpShared(): null {
  const shared = useColorAssigner();
  for (let i = 0; i < 8; i++) shared.colorFor(`step ${i}`);
  return null;
}

const toggle = (name: string): HTMLElement => screen.getByRole('button', { name });
const reset = (): HTMLElement => toggle('Reset');
const row = (name: RegExp): HTMLElement =>
  within(screen.getByRole('list', { name: 'Lines' })).getByRole('button', { name });
const lastFull = (): Partial<Opt> => {
  const full = calls.filter((c) => c.notMerge);
  const last = full[full.length - 1];
  if (last === undefined) throw new Error('no full setOption');
  return last.option;
};
const fire = async (name: string, e: unknown = {}): Promise<void> => {
  await act(async () => handlers.get(name)?.(e));
};
const zoomTo = async (startValue: number, endValue: number): Promise<void> => {
  zoomWindow.startValue = startValue;
  zoomWindow.endValue = endValue;
  await fire('datazoom');
};
const dot = (n: number): unknown => ({
  value: [n, 1],
  data: { value: [n, 1], meta: { run: result().runs[n] } },
});
const guides = (o: Partial<Opt>): (number | undefined)[] =>
  (o.series ?? []).filter((s) => s.id.startsWith('guide')).map((s) => s.markLine?.data[0]?.xAxis);
const lineIds = (o: Partial<Opt>): string[] =>
  (o.series ?? []).map((s) => s.id).filter((id) => id.startsWith('line:'));

describe('RunChartCard toggles', () => {
  test('shows the four toggles with aria-pressed from controls, and Reset', () => {
    render(<RunChartCard {...props()} />);
    expect(toggle('Slider').getAttribute('aria-pressed')).toBe('true');
    expect(toggle('Even spacing').getAttribute('aria-pressed')).toBe('true');
    expect(toggle('Split').getAttribute('aria-pressed')).toBe('false');
    expect(toggle('Legend').getAttribute('aria-pressed')).toBe('true');
    expect(reset()).toBeTruthy();
  });

  test.each([
    ['Slider', 'slider'],
    ['Even spacing', 'evenSpacing'],
    ['Split', 'split'],
    ['Legend', 'legend'],
  ] as const)('%s flips only its own key', (name, key) => {
    const onControls = vi.fn();
    render(<RunChartCard {...props({ onControls })} />);
    fireEvent.click(toggle(name));
    expect(onControls).toHaveBeenCalledExactlyOnceWith({ ...CONTROLS, [key]: !CONTROLS[key] });
  });

  test('turning the legend or the slider off gives its space to the plots, at the same widget size', async () => {
    const { rerender, container } = render(<RunChartCard {...props()} />);
    const section = container.querySelector('section');
    const beside = lastFull().grid?.[0];
    rerender(<RunChartCard {...props({ controls: { ...CONTROLS, legend: false } })} />);
    const wide = lastFull().grid?.[0];
    expect(beside?.width).toBe(1000 - 290 - 8 - 56 - 16);
    expect(wide?.width).toBe(1000 - 56 - 16);
    rerender(<RunChartCard {...props({ controls: { ...CONTROLS, legend: false, slider: false } })} />);
    expect(lastFull().grid?.[0]?.height).toBe((wide?.height ?? 0) + 40);
    expect(section?.style.height).toBe('700px');
  });

  test('below 820px the legend sits under the plot and takes its height, not its width', async () => {
    size.width = 600;
    render(<RunChartCard {...props()} />);
    const g = lastFull().grid?.[0];
    expect(g?.width).toBe(600 - 56 - 16);
    expect(screen.getByRole('img').getAttribute('data-height')).toBe(String(600 - 2 * 28 - 8));
  });
});

describe('RunChartCard view', () => {
  const windowOf = (): RunChartView['zoomWindow'] => result().window;
  const zoomOf = (): NonNullable<RunChartView['zoom']> => {
    const [, second, third] = result().runs;
    return { start: second?.time ?? 0, end: third?.time ?? 0 };
  };

  test('starts from a given zoom and hidden lines', () => {
    const view = { zoom: zoomOf(), zoomWindow: windowOf(), hidden: new Set(['slow']) };
    render(<RunChartCard {...props({ view })} />);
    expect(lastFull().dataZoom?.[0]?.startValue).toBe(1);
    expect(lineIds(lastFull())).toEqual(['line:fast']);
    expect((reset() as HTMLButtonElement).disabled).toBe(false);
  });

  test('drops a given zoom taken in another window, and keeps the hidden lines', () => {
    const w = windowOf();
    const view = {
      zoom: zoomOf(),
      zoomWindow: { start: w?.start ?? 0, end: (w?.end ?? 0) + 1 },
      hidden: new Set(['slow']),
    };
    const onView = vi.fn();
    render(<RunChartCard {...props({ view, onView })} />);
    expect(lastFull().dataZoom?.[0]?.startValue).toBeUndefined();
    expect(lineIds(lastFull())).toEqual(['line:fast']);
    expect(onView).toHaveBeenLastCalledWith({ zoom: null, zoomWindow: null, hidden: new Set(['slow']) });
  });

  test('reports a zoom and a hidden line, and Reset reports them gone', async () => {
    const onView = vi.fn();
    render(<RunChartCard {...props({ onView })} />);
    await zoomTo(1, 2);
    expect(onView).toHaveBeenLastCalledWith({ zoom: zoomOf(), zoomWindow: windowOf(), hidden: new Set() });
    fireEvent.click(row(/^slow/));
    expect(onView).toHaveBeenLastCalledWith({
      zoom: zoomOf(),
      zoomWindow: windowOf(),
      hidden: new Set(['slow']),
    });
    fireEvent.click(reset());
    expect(onView).toHaveBeenLastCalledWith({ zoom: null, zoomWindow: null, hidden: new Set() });
  });

  test('a window change reports the zoom gone', async () => {
    const onView = vi.fn();
    const { rerender } = render(<RunChartCard {...props({ onView })} />);
    await zoomTo(1, 2);
    const moved = { ...result(), window: { start: 0, end: 1 } };
    rerender(<RunChartCard {...props({ onView, result: moved })} />);
    expect(onView).toHaveBeenLastCalledWith({ zoom: null, zoomWindow: null, hidden: new Set() });
  });
});

describe('RunChartCard reset', () => {
  test('is disabled when the widget matches its configuration', () => {
    render(<RunChartCard {...props()} />);
    expect((reset() as HTMLButtonElement).disabled).toBe(true);
  });

  test('a differing toggle enables it, and a click restores the toggles', () => {
    const onControls = vi.fn();
    render(<RunChartCard {...props({ onControls, controls: { ...CONTROLS, slider: false } })} />);
    expect((reset() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reset());
    expect(onControls).toHaveBeenCalledExactlyOnceWith(CONTROLS);
  });

  test('a zoom enables it, and a click rebuilds with every run in view', async () => {
    render(<RunChartCard {...props()} />);
    await zoomTo(0, 1);
    expect((reset() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reset());
    await act(async () => undefined);
    expect(lastFull().dataZoom?.[0]?.startValue).toBeUndefined();
    expect(lastFull().yAxis?.[0]?.max).toBe(1500);
    expect((reset() as HTMLButtonElement).disabled).toBe(true);
  });

  test('a hidden line enables it, and a click shows the line again', async () => {
    render(<RunChartCard {...props()} />);
    fireEvent.click(row(/^slow/));
    expect((reset() as HTMLButtonElement).disabled).toBe(false);
    expect(lineIds(lastFull())).toEqual(['line:fast']);
    fireEvent.click(reset());
    expect(lineIds(lastFull())).toEqual(['line:fast', 'line:slow']);
    expect((reset() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('RunChartCard zoom', () => {
  test('a datazoom sets only new y axis values and leaves the series alone', async () => {
    render(<RunChartCard {...props()} />);
    expect(lastFull().yAxis?.[0]?.max).toBe(1500);
    const before = calls.length;
    await zoomTo(0, 1);
    expect(calls.slice(before)).toEqual([
      { option: { yAxis: [{ min: 0, max: 480, interval: 120 }] }, notMerge: false },
    ]);
  });

  test('zooming back out grows the y axis again', async () => {
    render(<RunChartCard {...props()} />);
    await zoomTo(0, 1);
    await zoomTo(0, 3);
    expect(calls[calls.length - 1]?.option.yAxis?.[0]?.max).toBe(1500);
    expect((reset() as HTMLButtonElement).disabled).toBe(true);
  });

  test('a split that fell back to one plot gets one y axis from a datazoom', async () => {
    render(<RunChartCard {...props({ controls: { ...CONTROLS, split: true } })} />);
    await resize(1000, 100);
    await zoomTo(0, 1);
    expect(calls[calls.length - 1]?.option.yAxis).toEqual([{ min: 0, max: 480, interval: 120 }]);
  });

  test('a different window clears the zoom; an identical one keeps it', async () => {
    const { rerender } = render(<RunChartCard {...props()} />);
    await zoomTo(0, 1);
    rerender(<RunChartCard {...props({ result: result() })} />);
    expect(lastFull().dataZoom?.[0]).toMatchObject({ startValue: 0, endValue: 1 });
    expect((reset() as HTMLButtonElement).disabled).toBe(false);
    rerender(<RunChartCard {...props({ result: result({ window: { start: 0, end: 999 * S } }) })} />);
    expect(lastFull().dataZoom?.[0]?.startValue).toBeUndefined();
    expect((reset() as HTMLButtonElement).disabled).toBe(true);
  });

  test('a resize and a theme change keep the zoom, the hidden lines and the toggles', async () => {
    const onControls = vi.fn();
    render(<RunChartCard {...props({ onControls })} />);
    await zoomTo(0, 1);
    fireEvent.click(row(/^fast/));
    const check = (): void => {
      const o = lastFull();
      expect(o.dataZoom?.[0]).toMatchObject({ startValue: 0, endValue: 1 });
      expect(o.yAxis?.[0]?.max).toBe(480);
      expect(lineIds(o)).toEqual(['line:slow']);
    };
    check();

    const beforeResize = calls.length;
    await resize(1400, 800);
    expect(calls.length).toBeGreaterThan(beforeResize);
    expect(lastFull().grid?.[0]?.width).toBe(1400 - 290 - 8 - 56 - 16);
    check();

    const beforeTheme = calls.length;
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      await Promise.resolve();
    });
    expect(calls.length).toBeGreaterThan(beforeTheme);
    check();

    expect(onControls).not.toHaveBeenCalled();
    expect(toggle('Legend').getAttribute('aria-pressed')).toBe('true');
    expect((reset() as HTMLButtonElement).disabled).toBe(false);
  });

  test('switching spacing keeps the same runs in view', async () => {
    const { rerender } = render(<RunChartCard {...props()} />);
    await zoomTo(1, 2);
    rerender(<RunChartCard {...props({ controls: { ...CONTROLS, evenSpacing: false } })} />);
    expect(lastFull().dataZoom?.[0]).toMatchObject({
      startValue: EPOCH_MS + 100_000,
      endValue: EPOCH_MS + 200_000,
    });
  });
});

describe('RunChartCard legend', () => {
  test('with the legend off there is none', () => {
    render(<RunChartCard {...props({ controls: { ...CONTROLS, legend: false } })} />);
    expect(screen.queryByRole('list', { name: 'Lines' })).toBeNull();
  });

  test('has one row per line, slowest first, with the latest value and its change from the median', () => {
    render(<RunChartCard {...props()} />);
    const rows = within(screen.getByRole('list', { name: 'Lines' })).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual([
      // slow: median of 100, 200, 470, 1254 is 335, and 200 is 40% below it.
      expect.stringMatching(/^slow.*200.*-40%$/),
      // fast: median of 10, 20, 30, 40 is 25, and 40 is 60% above it.
      expect.stringMatching(/^fast.*40.*\+60%$/),
    ]);
  });

  test('values and medians follow the zoom, and the order does not', async () => {
    render(<RunChartCard {...props()} />);
    await zoomTo(0, 1);
    const rows = within(screen.getByRole('list', { name: 'Lines' })).getAllByRole('button');
    expect(rows[0]?.textContent).toMatch(/^slow.*470.*\+65%$/);
    expect(rows[1]?.textContent).toMatch(/^fast.*20.*\+33%$/);
  });

  test('a line with no point in that run shows a dash', () => {
    render(
      <RunChartCard
        {...props({ result: result({ lines: [line('a', [1, 2, 3, null]), line('b', [1, 1, 1, 1])] }) })}
      />,
    );
    expect(row(/^a/).textContent).toMatch(/^a—$/);
  });

  test('hovering a row highlights its line, and leaving it stops', () => {
    render(<RunChartCard {...props()} />);
    fireEvent.mouseEnter(row(/^slow/));
    expect(dispatched).toEqual([{ type: 'highlight', seriesId: 'line:slow' }]);
    fireEvent.mouseLeave(row(/^slow/));
    expect(dispatched[1]).toEqual({ type: 'downplay', seriesId: 'line:slow' });
  });

  test('a click hides the line, but never the last visible one', () => {
    render(<RunChartCard {...props()} />);
    fireEvent.click(row(/^slow/));
    expect(row(/^slow/).getAttribute('aria-pressed')).toBe('false');
    expect(lineIds(lastFull())).toEqual(['line:fast']);
    const before = calls.length;
    fireEvent.click(row(/^fast/));
    expect(row(/^fast/).getAttribute('aria-pressed')).toBe('true');
    expect(calls.length).toBe(before);
    fireEvent.click(row(/^slow/));
    expect(lineIds(lastFull())).toEqual(['line:fast', 'line:slow']);
  });

  test('hiding a line recomputes the y axis and leaves the others colors alone', () => {
    render(<RunChartCard {...props()} />);
    const colorOf = (id: string): string | undefined =>
      lastFull().series?.find((s) => s.id === id)?.lineStyle?.color;
    const before = colorOf('line:fast');
    expect(lastFull().yAxis?.[0]?.max).toBe(1500);
    fireEvent.click(row(/^slow/));
    expect(lastFull().yAxis?.[0]?.max).toBe(40);
    expect(colorOf('line:fast')).toBe(before);
  });

  test('other widgets using up the shared colors leave the lines colored, and the same on every run chart', () => {
    const root = document.documentElement.style;
    for (let i = 1; i <= 7; i++) root.setProperty(`--oh-series-${i}`, `#00000${i}`);
    const colorOf = (id: string): string | undefined =>
      lastFull().series?.find((s) => s.id === id)?.lineStyle?.color;
    try {
      const { rerender } = render(
        <ColorsProvider>
          <UseUpShared />
          <RunChartCard {...props()} />
        </ColorsProvider>,
      );
      const first = colorOf('line:fast');
      expect(first).toMatch(/^#00000[1-7]$/);
      expect(colorOf('line:slow')).toMatch(/^#00000[1-7]$/);
      expect(colorOf('line:slow')).not.toBe(first);
      rerender(
        <ColorsProvider>
          <UseUpShared />
          <RunChartCard {...props({ title: 'Another run chart' })} />
        </ColorsProvider>,
      );
      expect(colorOf('line:fast')).toBe(first);
    } finally {
      for (let i = 1; i <= 7; i++) root.removeProperty(`--oh-series-${i}`);
    }
  });

  test('a line hidden and then gone from the result does not leave the chart empty', () => {
    const { rerender } = render(<RunChartCard {...props()} />);
    fireEvent.click(row(/^slow/));
    rerender(<RunChartCard {...props({ result: result({ lines: [line('slow', [1, 2, 3, 4])] }) })} />);
    expect(lineIds(lastFull())).toEqual(['line:slow']);
  });

  test('a hostile label is text, and a long one is shortened with the full name in its title', () => {
    render(
      <RunChartCard
        {...props({
          result: result({
            lines: [
              line('h', [1, 1, 1, 1], '<img src=x>'),
              line('b', [2, 2, 2, 2], 'binary (ubuntu-24.04-arm, linux-arm64)'),
            ],
          }),
        })}
      />,
    );
    const list = screen.getByRole('list', { name: 'Lines' });
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img src=x>');
    const long = within(list).getByTitle('binary (ubuntu-24.04-arm, linux-arm64)');
    expect(long.textContent).toContain('binary linux-arm64');
  });
});

describe('RunChartCard hover and click', () => {
  test('a dot moves the legend to its run and draws the guide; globalout restores the latest', async () => {
    render(<RunChartCard {...props()} />);
    await fire('mouseover', dot(1));
    expect(row(/^slow/).textContent).toMatch(/470/);
    expect(guides(calls[calls.length - 1]?.option ?? {})).toEqual([1]);
    await fire('globalout');
    expect(row(/^slow/).textContent).toMatch(/200/);
    expect(guides(calls[calls.length - 1]?.option ?? {})).toEqual([undefined]);
  });

  test('leaving a dot for empty plot also restores the latest', async () => {
    render(<RunChartCard {...props()} />);
    await fire('mouseover', dot(1));
    await fire('mouseout', dot(1));
    expect(row(/^slow/).textContent).toMatch(/200/);
    expect(guides(calls[calls.length - 1]?.option ?? {})).toEqual([undefined]);
  });

  test('on a split the guide goes through every plot', async () => {
    render(<RunChartCard {...props({ controls: { ...CONTROLS, split: true } })} />);
    await fire('mouseover', dot(2));
    expect(guides(calls[calls.length - 1]?.option ?? {})).toEqual([2, 2]);
  });

  test('leaving a dot goes back to the selected run guide, not to none', async () => {
    render(<RunChartCard {...props({ selectedRun: 'run3' })} />);
    expect(guides(lastFull())).toEqual([3]);
    await fire('mouseover', dot(1));
    await fire('globalout');
    expect(guides(calls[calls.length - 1]?.option ?? {})).toEqual([3]);
  });

  test('a repeat hover on the same run does not set the option again', async () => {
    render(<RunChartCard {...props()} />);
    await fire('mouseover', dot(1));
    const before = calls.length;
    await fire('mouseover', dot(1));
    expect(calls.length).toBe(before);
  });

  test('hover never rebuilds the chart', async () => {
    render(<RunChartCard {...props()} />);
    const full = calls.filter((c) => c.notMerge).length;
    await fire('mouseover', dot(1));
    await fire('globalout');
    expect(calls.filter((c) => c.notMerge).length).toBe(full);
  });

  test('a dot click picks its run, and the cursor shows it', async () => {
    const onPickRun = vi.fn();
    render(<RunChartCard {...props({ onPickRun })} />);
    expect(lastFull().series?.[0]?.cursor).toBe('pointer');
    await fire('click', dot(2));
    expect(onPickRun).toHaveBeenCalledExactlyOnceWith('run2');
  });

  test('without onPickRun the cursor is default and a click does nothing', async () => {
    render(<RunChartCard {...props()} />);
    expect(lastFull().series?.[0]?.cursor).toBe('default');
    await fire('click', dot(2));
  });
});

describe('RunChartCard states', () => {
  test('a split that does not fit is pressed, disabled and explained', async () => {
    size.height = 100;
    render(<RunChartCard {...props({ controls: { ...CONTROLS, split: true }, height: 180 })} />);
    const split = toggle('Split') as HTMLButtonElement;
    expect(split.getAttribute('aria-pressed')).toBe('true');
    expect(split.disabled).toBe(true);
    expect(screen.getByText('Too small to split. Make this widget taller.')).toBeTruthy();
    expect(lastFull().grid).toHaveLength(1);
  });

  test('split off and too small to split cannot be turned on, and adds no note', () => {
    size.height = 100;
    const onControls = vi.fn();
    render(<RunChartCard {...props({ onControls })} />);
    const split = toggle('Split') as HTMLButtonElement;
    expect(split.getAttribute('aria-pressed')).toBe('false');
    expect(split.disabled).toBe(true);
    expect(split.title).toBe('Too small to split. Make this widget taller.');
    expect(screen.queryByText('Too small to split. Make this widget taller.')).toBeNull();
    fireEvent.click(split);
    expect(onControls).not.toHaveBeenCalled();
  });

  test('split off is enabled again once it would fit, with no title', async () => {
    size.height = 100;
    render(<RunChartCard {...props()} />);
    await resize(1000, 600);
    const split = toggle('Split') as HTMLButtonElement;
    expect(split.disabled).toBe(false);
    expect(split.title).toBe('');
  });

  test('split off with one visible line left has nothing to split, so it stays enabled', () => {
    size.height = 100;
    render(<RunChartCard {...props()} />);
    fireEvent.click(row(/^slow/));
    expect((toggle('Split') as HTMLButtonElement).disabled).toBe(false);
  });

  test('split off with mixed units draws split anyway, so the size does not disable it', () => {
    size.height = 100;
    const mixed = result({ lines: [line('a', [1, 2, 3, 4]), { ...line('b', [1, 2, 3, 4]), unit: 'By' }] });
    render(<RunChartCard {...props({ result: mixed })} />);
    expect((toggle('Split') as HTMLButtonElement).disabled).toBe(false);
  });

  test('a split that fits again takes the note away', async () => {
    size.height = 100;
    render(<RunChartCard {...props({ controls: { ...CONTROLS, split: true } })} />);
    await resize(1000, 600);
    expect(screen.queryByText('Too small to split. Make this widget taller.')).toBeNull();
    expect((toggle('Split') as HTMLButtonElement).disabled).toBe(false);
    expect(lastFull().grid).toHaveLength(2);
  });

  test('shows its notes prop and not the result notes', () => {
    render(<RunChartCard {...props({ notes: ['passed'], result: result({ notes: ['not passed'] }) })} />);
    expect(screen.getByText('passed')).toBeTruthy();
    expect(screen.queryByText('not passed')).toBeNull();
  });

  test('one run renders and survives a datazoom', async () => {
    const one = result({
      runs: [{ id: 'only', time: 5 * S, revision: null }],
      lines: [line('a', [3])],
    });
    render(<RunChartCard {...props({ result: one })} />);
    await zoomTo(0, 0);
    expect(row(/^a/).textContent).toMatch(/3/);
    expect((reset() as HTMLButtonElement).disabled).toBe(true);
  });

  test('no runs shows the empty state and no chart', () => {
    render(<RunChartCard {...props({ result: result({ runs: [], lines: [] }) })} />);
    expect(screen.getByText('No data points in this window')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(toggle('Slider')).toBeTruthy();
  });

  test('a fresh callback alone does not rebuild the chart', async () => {
    const same = result();
    const { rerender } = render(<RunChartCard {...props({ result: same })} />);
    const before = calls.length;
    rerender(<RunChartCard {...props({ result: same, onPickRun: () => undefined })} />);
    rerender(<RunChartCard {...props({ result: same, onPickRun: () => undefined })} />);
    // `pickable` went from false to true once.
    expect(calls.length).toBe(before + 1);
  });
});

describe('RunChartCard on real ECharts', () => {
  const real = (): ReturnType<typeof init> =>
    init(null, null, { renderer: 'svg', ssr: true, width: 702, height: 500 });
  type Live = { yAxis: { max: number }[]; dataZoom: { startValue: number }[] };

  // zrender measures text on a canvas, which jsdom answers with null and a complaint.
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  test('a dataZoom action reaches the card, and the y axis follows in both directions', async () => {
    const chart = real();
    instance = chart;
    render(<RunChartCard {...props()} />);
    const yMax = (): number | undefined => (chart.getOption() as unknown as Live).yAxis[0]?.max;
    expect(yMax()).toBe(1500);
    await act(async () => void chart.dispatchAction({ type: 'dataZoom', startValue: 0, endValue: 1 }));
    expect(yMax()).toBe(480);
    expect((reset() as HTMLButtonElement).disabled).toBe(false);
    expect(row(/^slow/).textContent).toMatch(/470/);
    await act(async () => void chart.dispatchAction({ type: 'dataZoom', startValue: 0, endValue: 3 }));
    expect(yMax()).toBe(1500);
    expect((reset() as HTMLButtonElement).disabled).toBe(true);
    chart.dispose();
  });

  test('on real time too, and a rebuild keeps the window', async () => {
    const chart = real();
    instance = chart;
    const controls = { ...CONTROLS, evenSpacing: false };
    render(<RunChartCard {...props({ controls, configured: controls })} />);
    const live = (): Live => chart.getOption() as unknown as Live;
    await act(
      async () =>
        void chart.dispatchAction({ type: 'dataZoom', startValue: EPOCH_MS, endValue: EPOCH_MS + 100_000 }),
    );
    expect(live().yAxis[0]?.max).toBe(480);
    await resize(1200, 500);
    expect(live().yAxis[0]?.max).toBe(480);
    expect(live().dataZoom[0]?.startValue).toBe(EPOCH_MS);
    chart.dispose();
  });

  test('a guide drawn and removed by id leaves the lines in place', async () => {
    const chart = real();
    instance = chart;
    render(<RunChartCard {...props()} />);
    const series = (): Opt['series'] => (chart.getOption() as unknown as Opt).series;
    const trigger = (name: string, e: unknown): Promise<void> =>
      act(async () => void (chart as unknown as { trigger(n: string, e: unknown): void }).trigger(name, e));
    await trigger('mouseover', dot(1));
    expect(series().map((s) => s.id)).toEqual(['line:fast', 'line:slow', 'guide0']);
    expect(series()[2]?.markLine?.data).toHaveLength(1);
    expect(row(/^slow/).textContent).toMatch(/470/);
    await trigger('globalout', {});
    expect(series()[2]?.markLine?.data).toHaveLength(0);
    chart.dispose();
  });
});
