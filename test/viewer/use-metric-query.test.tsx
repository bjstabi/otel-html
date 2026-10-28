import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { MetricCatalog } from '../../src/rollups/metric-catalog.js';
import { createDataSource, type DataSource } from '../../src/viewer/data/data-source.js';
import { type MetricQueries, useMetricQueries } from '../../src/viewer/metrics/use-metric-query.js';
import { defaultMetricState, type MetricPageState } from '../../src/viewer/state/metric-state.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';
import { buildMetricExplorerReport, type Fixture } from './report-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

let report: Fixture;
beforeAll(async () => {
  report = await buildMetricExplorerReport();
});

const S = 1_000_000_000;
const seed = defaultMetricState(null);
const STATE: MetricPageState = {
  ...seed,
  queries: seed.queries.map((q) => ({ ...q, metric: 'http.server.requests', show: 'increase' })),
};

function Probe(props: { ds: DataSource; end: number; onState(s: MetricQueries): void }): null {
  props.onState(useMetricQueries(props.ds, STATE, { start: 0, end: props.end }));
  return null;
}

describe('useMetricQueries', () => {
  test('after a failed run, the next run shows nothing from before the failure while it loads', async () => {
    const real = await createDataSource(createScriptedLoader(report.files), report.manifest, 10_000_000);
    let catalog: () => Promise<MetricCatalog> = () => real.metricCatalog();
    const ds: DataSource = { ...real, metricCatalog: () => catalog(), metric: (id) => real.metric(id) };
    const seen: { latest: MetricQueries | null } = { latest: null };
    const onState = (s: MetricQueries): void => {
      seen.latest = s;
    };
    const view = render(<Probe ds={ds} end={6000 * S} onState={onState} />);
    await act(async () => {});
    expect(seen.latest?.results.get('a')?.series.length).toBe(1);

    catalog = () => Promise.reject(new Error('catalog gone'));
    view.rerender(<Probe ds={ds} end={5000 * S} onState={onState} />);
    await act(async () => {});
    expect(seen.latest?.failure).toBe('catalog gone');
    expect(seen.latest?.results.size).toBe(0);

    catalog = () => new Promise(() => undefined);
    view.rerender(<Probe ds={ds} end={4000 * S} onState={onState} />);
    await act(async () => {});
    expect(seen.latest?.loading).toBe(true);
    expect(seen.latest?.failure).toBeNull();
    expect(seen.latest?.results.size).toBe(0);
  });
});
