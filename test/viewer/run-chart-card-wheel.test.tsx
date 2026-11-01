import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string }): React.JSX.Element => <div role="img" aria-label={p.ariaLabel} />,
}));

import { RunChartCard } from '../../src/viewer/components/run-chart-card.js';

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const controls = { slider: true, evenSpacing: true, split: true, legend: false };

// ECharts stops a wheel event over a plot whatever `zoomOnMouseWheel` says, so a plain one must not reach it.
test('only a ctrl wheel event reaches the chart', () => {
  render(
    <RunChartCard
      title="t"
      subtitle=""
      result={{
        queryId: 'a',
        runs: [{ id: 'r', time: 0, revision: null }],
        lines: [{ key: 'k', label: 'k', unit: 's', points: [{ value: 1, failed: false }] }],
        leftOut: 0,
        window: { start: 0, end: 1 },
        notes: [],
      }}
      configured={controls}
      controls={controls}
      onControls={() => undefined}
      height={600}
      epochUnixNano="0"
      selectedRun={null}
      echarts={null}
      onPickRun={null}
      notes={[]}
    />,
  );
  const chart = screen.getByRole('img');
  const reached = vi.fn();
  chart.addEventListener('wheel', reached);
  fireEvent.wheel(chart, { deltaY: 40 });
  expect(reached).not.toHaveBeenCalled();
  fireEvent.wheel(chart, { deltaY: 40, ctrlKey: true });
  expect(reached).toHaveBeenCalledTimes(1);
});
