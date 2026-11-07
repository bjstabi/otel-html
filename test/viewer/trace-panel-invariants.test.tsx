import { Tooltip } from '@base-ui/react/tooltip';
import { cleanup, render, screen } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Manifest } from '../../src/format/manifest.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { TracePanel } from '../../src/viewer/traces/trace-panel.js';
import { detailOf, TRACE_ID, traceRow } from './trace-rows.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
// A tab id outside the union: the panel's exhaustive switch must fail with a typed error.
vi.mock('../../src/viewer/traces/tabs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/viewer/traces/tabs.js')>()),
  availableTabs: () => [{ id: 'bogus', label: 'Bogus', available: () => true }],
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

class Catch extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }
  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <p data-testid="caught">{`${error instanceof OtelHtmlError ? 'typed' : 'bare'}: ${String(error)}`}</p>
    );
  }
}

describe('TracePanel invariants', () => {
  test('an unknown tab id fails with an OtelHtmlError, not a bare Error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ds = {
      manifest: {
        epochUnixNano: '1700000000000000000',
        totals: { spans: 1, logs: 0, metrics: 0 },
      } as Manifest,
      strategy: 'eager',
      getTrace: () =>
        Promise.resolve(detailOf([traceRow(1, null, 0, 100, { service: 'web', name: 'GET /' })])),
      percentileOf: () => null,
    } as unknown as DataSource;
    render(
      <ThemeProvider>
        <SelectionProvider store={createSelectionStore({})}>
          <Tooltip.Provider>
            <Catch>
              <TracePanel dataSource={ds} traceId={TRACE_ID} layout="overlay" onClose={() => {}} />
            </Catch>
          </Tooltip.Provider>
        </SelectionProvider>
      </ThemeProvider>,
    );
    expect((await screen.findByTestId('caught')).textContent).toMatch(/^typed: .*bogus/);
  });
});
