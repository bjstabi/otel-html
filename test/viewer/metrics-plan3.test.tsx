import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import { useHasMetrics } from '../../src/viewer/metrics/metric-grid.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { manifestV4 } from './v4-manifest.js';

const MESSAGE = 'the metrics pages must not query';

/** An engine that refuses everything: its failure is what the metrics pages show as their error state. */
const engine: QueryEngine = {
  query: () => Promise.reject(new Error('the metrics pages must not query')),
  exec: () => Promise.reject(new Error('the metrics pages must not query')),
  registerText: () => Promise.reject(new Error('the metrics pages must not query')),
  close: () => Promise.resolve(),
};
const source = () => createDuckDbDataSource({ engine, manifest: manifestV4(5) });

afterEach(cleanup);

function mount(hash: string): void {
  window.location.hash = hash;
  render(
    <ThemeProvider>
      <Shell dataSource={source()} history={createHashHistory(window)} />
    </ThemeProvider>,
  );
}

function Probe(props: { ds: DataSource; seen: boolean[] }): null {
  props.seen.push(useHasMetrics(props.ds, []));
  return null;
}

describe('metrics pages when the engine fails', () => {
  test('the Explorer shows the engine failure as its error state', async () => {
    mount('#/metrics');
    // the catalog card and the queries card both carry it
    expect((await screen.findAllByText(MESSAGE)).length).toBeGreaterThan(0);
  });

  test('the Catalog shows the engine failure as its error state', async () => {
    mount('#/metrics/catalog');
    expect(await screen.findByText(MESSAGE)).toBeTruthy();
  });

  test('useHasMetrics is false when the lookup rejects', async () => {
    const seen: boolean[] = [];
    render(<Probe ds={source()} seen={seen} />);
    await waitFor(() => expect(seen.length).toBeGreaterThan(1));
    expect(seen.every((v) => !v)).toBe(true);
  });
});
