import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const order: string[] = [];
const fakeChart = {
  on: (): void => undefined,
  off: (): void => undefined,
  setOption: (): void => void order.push('setOption'),
  dispatchAction: (a: { type: string }): void => void order.push(a.type),
};

// As the real Chart: the instance first, and every change of option is a `setOption`.
vi.mock('../../src/viewer/components/chart.js', async () => {
  const { useEffect } = await import('react');
  return {
    Chart: (p: { option: unknown; onInstance?: (c: unknown) => void }): React.JSX.Element => {
      useEffect(() => {
        p.onInstance?.(fakeChart);
      }, [p.onInstance]);
      useEffect(() => {
        fakeChart.setOption();
      }, [p.option]);
      return <div role="img" aria-label="chart" />;
    },
  };
});

import { RunChartCard } from '../../src/viewer/components/run-chart-card.js';

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  order.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const controls = { slider: true, evenSpacing: true, split: false, legend: true };

// ECharts only leaves a blur its current series models remember, and a rebuild replaces them.
test('a rebuild with the pointer over the body leaves any hover before the new option goes in, and otherwise adds nothing', () => {
  const props = {
    title: 't',
    subtitle: '',
    result: {
      queryId: 'a',
      runs: [{ id: 'r', time: 0, revision: null }],
      lines: [{ key: 'k', label: 'k', unit: 's', points: [{ value: 1, failed: false }] }],
      leftOut: 0,
      window: { start: 0, end: 1 },
      notes: [],
    },
    configured: controls,
    onControls: () => undefined,
    height: 600,
    epochUnixNano: '0',
    selectedRun: null,
    echarts: null,
    onPickRun: null,
    notes: [],
  };
  const { rerender } = render(<RunChartCard {...props} controls={controls} />);
  order.length = 0;
  rerender(<RunChartCard {...props} controls={{ ...controls, slider: false }} />);
  expect(order).toEqual(['setOption']);

  order.length = 0;
  fireEvent.mouseEnter(screen.getByRole('button', { name: /^k/ }));
  rerender(<RunChartCard {...props} controls={controls} />);
  expect(order).toEqual(['highlight', 'downplay', 'setOption']);

  // Over the chart a line can be blurred with no event to the card.
  fireEvent.mouseLeave(screen.getByRole('button', { name: /^k/ }));
  order.length = 0;
  fireEvent.mouseEnter(screen.getByRole('img'));
  rerender(<RunChartCard {...props} controls={{ ...controls, slider: false }} />);
  expect(order).toEqual(['downplay', 'setOption']);

  order.length = 0;
  fireEvent.mouseLeave(screen.getByRole('img'));
  rerender(<RunChartCard {...props} controls={controls} />);
  expect(order).toEqual(['setOption']);
});
