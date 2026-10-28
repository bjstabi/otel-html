import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';

vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string }): React.JSX.Element => <div role="img" aria-label={p.ariaLabel} />,
}));

import { createDataSource, type DataSource } from '../../src/viewer/data/data-source.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { currentD, renderShell } from './dashboard-shell.js';
import { buildEmbeddedMetricsReport, LINKED_TRACE } from './report-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

async function linked(): Promise<DataSource> {
  const report = await buildEmbeddedMetricsReport();
  return createDataSource(createScriptedLoader(report.files), report.manifest, 1);
}

/** The widget frame by its id (the sidebar has regions with the same names). */
function regionEl(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-widget="${name.toLowerCase()}"]`);
  if (el === null) throw new Error(`no ${name} widget`);
  return el;
}
const region = (name: string) => within(regionEl(name));

async function tracesWidget() {
  renderShell('#/dashboards/fusion', await linked());
  const traces = await waitFor(() => {
    const r = region('Traces');
    expect(r.getAllByRole('row').length).toBeGreaterThan(1);
    return r;
  });
  return traces;
}

describe('the Traces widget', () => {
  test('lists the report traces, says how many, and shows no flame graph until one is selected', async () => {
    const traces = await tracesWidget();
    expect(traces.getAllByRole('row')).toHaveLength(2); // header + the one linked trace
    await waitFor(() => expect(regionEl('Traces').textContent).toContain('1 traces'));
    expect(traces.queryByTestId('flame-graph')).toBeNull();
  });

  test('a row click sets d.sel.trace and renders a compact flame graph without minimap, legend or color-by', async () => {
    const user = userEvent.setup();
    const traces = await tracesWidget();
    const row = traces.getAllByRole('row')[1];
    if (row === undefined) throw new Error('no row');
    await user.click(row);
    await waitFor(() => expect(currentD()?.sel.trace).toBe(LINKED_TRACE));
    await waitFor(() => expect(traces.getByTestId('flame-graph')).toBeTruthy());
    expect(traces.queryByLabelText('Color by')).toBeNull();
    expect(traces.queryByRole('heading', { name: /Share of exclusive execution time/ })).toBeNull();
  });

  test('"open trace panel" opens the trace panel through the selection store', async () => {
    const user = userEvent.setup();
    const traces = await tracesWidget();
    const row = traces.getAllByRole('row')[1];
    if (row === undefined) throw new Error('no row');
    await user.click(row);
    await user.click(await traces.findByRole('button', { name: /open trace panel/ }));
    await waitFor(() => expect(parseUrlState(window.location.hash).state.trace).toBe(LINKED_TRACE));
    expect(await screen.findByTestId('trace-panel')).toBeTruthy();
  });

  test('with the follow toggle off the selected trace is not highlighted and the flame graph is gone', async () => {
    const user = userEvent.setup();
    const traces = await tracesWidget();
    const row = traces.getAllByRole('row')[1];
    if (row === undefined) throw new Error('no row');
    await user.click(row);
    await traces.findByTestId('flame-graph');
    await user.click(traces.getByRole('button', { name: /follows selection/ }));
    await waitFor(() => expect(traces.queryByTestId('flame-graph')).toBeNull());
  });

  test('Open in Traces carries the window, the query, and the mode', async () => {
    const user = userEvent.setup();
    const traces = await tracesWidget();
    await user.click(traces.getByRole('button', { name: /Open in Traces/ }));
    await waitFor(() => expect(window.location.hash.startsWith('#/traces')).toBe(true));
    // Fusion's Traces widget is in traces mode, which is not the Traces page's default (spans).
    expect(parseUrlState(window.location.hash).state.mode).toBe('traces');
  });
});
