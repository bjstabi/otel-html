import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const setTheme = vi.fn<(theme: unknown) => void>();
const resize = vi.fn<() => void>();
const chartSize = { width: 0, height: 0 };
// Mirrors ECharts: a synchronous setOption render emits `finished` before setOption returns.
const handlers = new Map<string, () => void>();
const initThemes: unknown[] = [];

vi.mock('echarts/core', () => ({
  use: (): void => undefined,
  init: (_el: unknown, theme: unknown): unknown => {
    initThemes.push(theme);
    return {
      setTheme,
      setOption: () => handlers.get('finished')?.(),
      on: (name: string, h: () => void) => handlers.set(name, h),
      off: (name: string) => handlers.delete(name),
      resize,
      getWidth: () => chartSize.width,
      getHeight: () => chartSize.height,
      dispose: () => undefined,
    };
  },
}));
vi.mock('echarts/charts', () => ({
  LineChart: {},
  BarChart: {},
  PieChart: {},
  ScatterChart: {},
  TreemapChart: {},
  CustomChart: {},
}));
vi.mock('echarts/components', () => ({
  DataZoomComponent: {},
  GridComponent: {},
  TooltipComponent: {},
  LegendComponent: {},
  MarkLineComponent: {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

import { Chart } from '../../src/viewer/components/chart.js';
import { type ThemePreference, ThemeProvider, useTheme } from '../../src/viewer/theme/theme-provider.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

// jsdom does not load tokens.css; emulate it by keying a variable off the data-theme attribute.
function installTokens(): void {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string): string => {
          if (name !== '--oh-series-1') return '';
          return document.documentElement.getAttribute('data-theme') === 'dark' ? '#3987e5' : '#2a78d6';
        },
      }) as CSSStyleDeclaration,
  );
}

let setter: ((p: ThemePreference) => void) | null = null;
function Grab(): null {
  setter = useTheme().setPreference;
  return null;
}

const firstColor = (theme: unknown): unknown => (theme as { color: unknown[] }).color[0];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  setTheme.mockClear();
  resize.mockClear();
  handlers.clear();
  initThemes.length = 0;
});

describe('Chart theming', () => {
  it('reads the already-applied theme at mount and on each toggle', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    window.localStorage.setItem('otel-html:theme', 'dark');
    installTokens();
    const host = document.createElement('div');
    await act(async () => {
      createRoot(host).render(
        <ThemeProvider>
          <Grab />
          <Chart option={{}} ariaLabel="Latency over time" />
        </ThemeProvider>,
      );
    });
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Latency over time');
    expect(firstColor(initThemes[0])).toBe('#3987e5');
    await act(async () => setter?.('light'));
    expect(firstColor(setTheme.mock.calls.at(-1)?.[0])).toBe('#2a78d6');
    await act(async () => setter?.('dark'));
    expect(firstColor(setTheme.mock.calls.at(-1)?.[0])).toBe('#3987e5');
  });
});

describe('Chart sizing', () => {
  it('resizes only when the host size differs from what the chart already laid out', async () => {
    const observer = { fire: (): void => undefined };
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observer.fire = cb;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    installTokens();
    const host = document.createElement('div');
    await act(async () => {
      createRoot(host).render(
        <ThemeProvider>
          <Chart option={{}} ariaLabel="Latency over time" />
        </ThemeProvider>,
      );
    });
    const el = host.querySelector<HTMLElement>('[role="img"]');
    if (el === null) throw new Error('chart host not rendered');
    let width = 640;
    let height = 240;
    vi.spyOn(el, 'clientWidth', 'get').mockImplementation(() => width);
    vi.spyOn(el, 'clientHeight', 'get').mockImplementation(() => height);
    chartSize.width = 640;
    chartSize.height = 240;

    // ResizeObserver reports the initial size once on observe; the chart was just laid out at that size.
    observer.fire();
    expect(resize).not.toHaveBeenCalled();

    width = 800;
    observer.fire();
    expect(resize).toHaveBeenCalledTimes(1);
    height = 300;
    chartSize.width = 800;
    observer.fire();
    expect(resize).toHaveBeenCalledTimes(2);
  });
});

describe('Chart events', () => {
  it('subscribes before setOption, so the first render reports finished', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    installTokens();
    const finished = vi.fn<() => void>();
    const host = document.createElement('div');
    await act(async () => {
      createRoot(host).render(
        <ThemeProvider>
          <Chart option={{}} onEvents={{ finished }} ariaLabel="Flame graph" />
        </ThemeProvider>,
      );
    });
    expect(finished).toHaveBeenCalledTimes(1);
  });
});
