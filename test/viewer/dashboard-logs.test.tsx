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

/** Fusion with the one linked trace selected through the Traces widget. */
async function withTraceSelected() {
  const user = userEvent.setup();
  renderShell('#/dashboards/fusion', await linked());
  const traces = await waitFor(() => {
    const r = region('Traces');
    expect(r.getAllByRole('row').length).toBeGreaterThan(1);
    return r;
  });
  const row = traces.getAllByRole('row')[1];
  if (row === undefined) throw new Error('no row');
  await user.click(row);
  await waitFor(() => expect(currentD()?.sel.trace).toBe(LINKED_TRACE));
  return user;
}

describe('the Logs widget', () => {
  test('lists every log in the window until a trace is selected', async () => {
    renderShell('#/dashboards/fusion', await linked());
    await waitFor(() => expect(region('Logs').getByText('charge declined')).toBeTruthy());
    const logs = region('Logs');
    expect(logs.getByText('web log')).toBeTruthy();
  });

  test('follows the selected trace: only its logs, "N for the selected trace"; ⛓ off lists them all', async () => {
    const user = await withTraceSelected();
    const logs = region('Logs');
    await waitFor(() => expect(logs.queryByText('web log')).toBeNull());
    expect(logs.getByText('charge declined')).toBeTruthy();
    expect(regionEl('Logs').textContent).toContain('1 for the selected trace');
    await user.click(logs.getByRole('button', { name: /follows selection/ }));
    await waitFor(() => expect(logs.getByText('web log')).toBeTruthy());
    expect(regionEl('Logs').textContent).not.toContain('for the selected trace');
  });

  test('Show context lists every log in the window and marks the matching rows', async () => {
    const user = await withTraceSelected();
    const logs = region('Logs');
    await waitFor(() => expect(logs.queryByText('web log')).toBeNull());
    const matches = logs.getByRole('button', { name: 'Only matches' });
    expect(matches.getAttribute('aria-pressed')).toBe('true');
    await user.click(logs.getByRole('button', { name: 'Show context' }));
    expect(currentD()?.logView).toEqual({ logs: 'context' });
    await waitFor(() => expect(logs.getByText('web log')).toBeTruthy());
    const rowOf = (text: string): HTMLElement | null => logs.getByText(text).closest('[role="row"]');
    expect(rowOf('charge declined')?.hasAttribute('data-match')).toBe(true);
    expect(rowOf('web log')?.hasAttribute('data-match')).toBe(false);
  });

  test('a log row click opens the log panel through the selection store', async () => {
    const user = userEvent.setup();
    renderShell('#/dashboards/fusion', await linked());
    await waitFor(() => expect(region('Logs').getByText('charge declined')).toBeTruthy());
    await user.click(region('Logs').getByText('charge declined'));
    await waitFor(() => expect(parseUrlState(window.location.hash).state.log).toBe('0.0'));
  });

  test('Open in Logs navigates with the trace condition, and that page shows it', async () => {
    const user = await withTraceSelected();
    const logs = region('Logs');
    await waitFor(() => expect(logs.queryByText('web log')).toBeNull());
    await user.click(logs.getByRole('button', { name: /Open in Logs/ }));
    await waitFor(() => expect(window.location.hash.startsWith('#/logs')).toBe(true));
    expect(parseUrlState(window.location.hash).state.q).toBe(`trace_id.string == "${LINKED_TRACE}"`);
    const value = await screen.findByLabelText('Value of trace_id.string');
    expect((value as HTMLInputElement).value).toBe(LINKED_TRACE);
  });
});
