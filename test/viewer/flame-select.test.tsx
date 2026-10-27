import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import { FlameGraph } from '../../src/viewer/components/flame-graph.js';
import { createColorAssigner } from '../../src/viewer/theme/palette.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { detailOf, spanIdOf, traceRow } from './trace-rows.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ChartProps {
  option: { series?: { markLine?: { data: { xAxis: number }[] } }[] };
  onInstance?: (chart: unknown) => void;
  ariaLabel: string;
}
const charts = vi.hoisted((): ChartProps[] => []);
vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: ChartProps): null => {
    charts.push(p);
    return null;
  },
}));
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
afterEach(() => {
  cleanup();
  charts.length = 0;
});

const detail = detailOf([
  traceRow(1, null, 0, 1000, { service: 'web' }),
  traceRow(2, 1, 100, 400, { service: 'db' }),
]);

function mount(extra: { markers?: { time: RelNanos; label: string }[] } = {}) {
  const onSelect = vi.fn();
  render(
    <ThemeProvider>
      <FlameGraph
        detail={detail}
        selectedSpanId={null}
        onSelect={onSelect}
        colors={createColorAssigner()}
        {...extra}
      />
    </ThemeProvider>,
  );
  const main = charts.find((c) => c.ariaLabel.startsWith('Flame graph'));
  if (main === undefined) throw new Error('the main chart did not render');
  return { onSelect, main };
}

/** A chart whose pixel space is the data space (x is time, y is depth), recording the zrender handlers. */
function fakeChart() {
  const handlers = new Map<string, (e: { offsetX: number; offsetY: number }) => void>();
  const chart = {
    getZr: () => ({
      on: (name: string, fn: (e: { offsetX: number; offsetY: number }) => void) => handlers.set(name, fn),
    }),
    convertFromPixel: (_finder: unknown, [x, y]: [number, number]) => [x, y],
  };
  const click = (time: number, depth: number): void =>
    handlers.get('click')?.({ offsetX: time, offsetY: depth + 0.5 });
  return { chart, click };
}

describe('FlameGraph', () => {
  test('clicking a bar selects its span; empty space and other depths select nothing', () => {
    const { onSelect, main } = mount();
    const { chart, click } = fakeChart();
    main.onInstance?.(chart);
    click(50, 0);
    expect(onSelect).toHaveBeenLastCalledWith(spanIdOf(1));
    click(250, 1);
    expect(onSelect).toHaveBeenLastCalledWith(spanIdOf(2));
    onSelect.mockClear();
    click(600, 1);
    click(250, 5);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
