import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

/** A card whose button drags out 1 s to 2 s, so the tests see where a grid zoom goes. */
vi.mock('../../src/viewer/components/metric-chart-card.js', () => ({
  MetricChartCard: (p: {
    title: string;
    window: { start: number; end: number };
    onZoom(w: { start: number; end: number }): void;
  }): React.JSX.Element => (
    <button
      type="button"
      data-window={`${p.window.start}-${p.window.end}`}
      onClick={() => p.onZoom({ start: 1e9, end: 2e9 })}
    >
      Zoom {p.title}
    </button>
  ),
}));

import type { TimeWindow } from '../../src/viewer/data/data-source.js';
import { createDataSource, type DataSource } from '../../src/viewer/data/data-source.js';
import { MetricGrid } from '../../src/viewer/metrics/metric-grid.js';
import { GoToContext } from '../../src/viewer/shell/go-to.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';
import { buildEmbeddedMetricsReport, type Fixture } from './report-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let report: Fixture;
beforeAll(async () => {
  report = await buildEmbeddedMetricsReport();
});
afterEach(cleanup);

async function mount(onZoom?: (w: TimeWindow) => void): Promise<void> {
  const ds: DataSource = await createDataSource(
    createScriptedLoader(report.files),
    report.manifest,
    10_000_000,
  );
  const resources = (await ds.metricCatalog()).resources();
  render(
    <ThemeProvider>
      <GoToContext.Provider value={() => undefined}>
        <MetricGrid
          dataSource={ds}
          origin={{ kind: 'dashboard', resources, at: null, window: { start: 0, end: 120e9 }, traceId: null }}
          {...(onZoom === undefined ? {} : { onZoom })}
        />
      </GoToContext.Provider>
    </ThemeProvider>,
  );
}

const card = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: /^Zoom process\.cpu\.utilization/ });

describe('a drag on a MetricGrid chart', () => {
  test('zooms the grid itself, with Reset zoom, when nobody takes it', async () => {
    const user = userEvent.setup();
    await mount();
    await user.click(await card());
    expect((await card()).getAttribute('data-window')).toBe('1000000000-2000000000');
    await user.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect((await card()).getAttribute('data-window')).toBe('0-120000000000');
  });

  test('goes to onZoom (a dashboard selection) and leaves the grid window alone', async () => {
    const user = userEvent.setup();
    const onZoom = vi.fn();
    await mount(onZoom);
    await user.click(await card());
    expect(onZoom).toHaveBeenCalledWith({ start: 1e9, end: 2e9 });
    expect((await card()).getAttribute('data-window')).toBe('0-120000000000');
    expect(screen.queryByRole('button', { name: 'Reset zoom' })).toBeNull();
  });
});
