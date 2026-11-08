import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MetricPageState } from '../../src/query/metric-query.js';
import { defaultShowOf } from '../../src/viewer/data/metric-tables.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { serializeUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { metricsSource } from './metrics-fixture.js';

// jsdom cannot lay out ECharts; the stand-in keeps the label the card gives the chart (its series count).
vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string }) => <div role="img" aria-label={p.ariaLabel} />,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = metricsSource();

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const state = (over: Partial<MetricPageState['queries'][number]>): MetricPageState => ({
  queries: [
    {
      id: 'a',
      metric: 'queue.depth',
      kind: null,
      unit: null,
      show: 'avg',
      by: [],
      where: null,
      fn: [],
      alias: null,
      hidden: false,
      ...over,
    },
  ],
  formulas: [],
  display: 'lines',
  scale: 'linear',
  split: false,
  exemplars: false,
});

function open(m: MetricPageState): void {
  window.location.hash = `#/metrics?${serializeUrlState({ m })}`;
  render(
    <ThemeProvider>
      <Shell dataSource={source()} history={createHashHistory(window)} />
    </ThemeProvider>,
  );
}

describe('the Metrics Explorer over format 4', () => {
  test('draws the series of a query from the URL m param', async () => {
    open(state({ by: ['attributes["host"]'] }));
    expect(await screen.findByRole('img', { name: /queue\.depth.*: 2 series/ })).toBeTruthy();
  });

  test('notes a where term the browser evaluates', async () => {
    open(state({ where: 'Len(attributes["k"]) > 2' }));
    expect(await screen.findByText(/Evaluated in the browser: /)).toBeTruthy();
  });

  test('lists by options from the entry attribute keys and the catalog resources', async () => {
    open(state({}));
    await screen.findByRole('img', { name: /queue\.depth/ });
    await userEvent.click(await screen.findByRole('button', { name: 'By of a' }));
    for (const path of ['attributes["host"]', 'attributes["k"]', 'resource.attributes["service.name"]']) {
      expect(await screen.findByText(path)).toBeTruthy();
    }
    expect(screen.queryByText('attributes["nope"]')).toBeNull();
  });

  test('a pending query takes the first metric with its default show', async () => {
    open({ ...state({ metric: '', show: '' }) });
    expect(await screen.findByRole('img', { name: /queue\.depth.*series/ })).toBeTruthy();
  });

  test('a picked summary gets its highest quantile as the show', async () => {
    const ds = source();
    const cat = await ds.metricCatalog();
    const s = cat.entries.find((e) => e.name === 'rpc.latency');
    if (s === undefined) throw new Error('no summary');
    expect(defaultShowOf('summary', await ds.metricShowOptions(s.id))).toBe('q0.99');
    expect(defaultShowOf('counter', [])).toBe('rate');
  });
});
