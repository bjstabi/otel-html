import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// A click opens the Explorer, whose charts need a canvas; the Catalog itself draws none.
vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string }): React.JSX.Element => <div role="img" aria-label={p.ariaLabel} />,
}));

import { createDataSource } from '../../src/viewer/data/data-source.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { parseUrlState } from '../../src/viewer/state/url-state.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { openSession } from '../../src/writer/session.js';
import { attr, type JsonObject } from '../../test-support/otlp-builders.js';
import { createScriptedLoader, reportFilesFromSnapshot } from '../../test-support/scripted-loader.js';
import { createTestWriter, EPOCH_NS, otlp, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf } from '../writer/helpers.js';
import { buildMetricExplorerReport, type Fixture } from './report-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOSTILE = '</script><img src=x onerror=alert(1)>';
const TEST_CAP = 2;

/** The explorer report has 6 definitions: 3 plain metrics, the histogram, and `jobs.active` twice (conflicting). */
const EXPLORER_DEFINITIONS = 6;

/** One gauge `capped.gauge` with 3 series under a cap of 2 (so it folds), and one gauge with a hostile name. */
async function buildCappedReport(): Promise<Fixture> {
  const w = createTestWriter();
  const session = await openSession(w.deps, {
    out: 'rep',
    config: testConfig({ writer: { metricSeriesCap: TEST_CAP } }),
    mode: 'create',
  });
  const at = (s: number): string => String(BigInt(EPOCH_NS) + BigInt(s) * 1_000_000_000n);
  const point = (v: number, s: number, key: string): JsonObject => ({
    timeUnixNano: at(s),
    asInt: String(v),
    attributes: [attr('k', { stringValue: key })],
  });
  const gauge = (name: string, dataPoints: JsonObject[]): JsonObject => ({
    name,
    unit: '1',
    gauge: { dataPoints },
  });
  await session.add(
    otlp({
      resourceMetrics: [
        {
          resource: { attributes: [attr('service.name', { stringValue: 'checkout' })] },
          scopeMetrics: [
            {
              scope: { name: 'test-scope' },
              metrics: [
                gauge('capped.gauge', [
                  point(1, 1, 'a'),
                  point(2, 1, 'b'),
                  point(3, 1, 'c'),
                  point(4, 2, 'd'),
                ]),
                gauge(HOSTILE, [point(1, 1, 'a')]),
              ],
            },
          ],
        },
      ],
    }),
    'metrics',
  );
  await session.close();
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), 'rep'), manifest: manifestOf(w, 'rep') };
}

let explorer: Fixture;
let capped: Fixture;
beforeAll(async () => {
  explorer = await buildMetricExplorerReport();
  capped = await buildCappedReport();
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

async function renderCatalog(report: Fixture): Promise<void> {
  const ds = await createDataSource(createScriptedLoader(report.files), report.manifest, 10_000_000);
  window.location.hash = '#/metrics/catalog';
  render(
    <ThemeProvider>
      <Shell dataSource={ds} history={createHashHistory(window)} />
    </ThemeProvider>,
  );
}

const rowsOf = (): HTMLElement[] =>
  screen.getAllByRole('row').filter((r) => r.getAttribute('data-row-index') !== null);

describe('Metrics Catalog', () => {
  test('lists every definition and counts metrics and scopes in the header', async () => {
    await renderCatalog(explorer);
    await screen.findByText(
      (_, el) => el?.tagName === 'P' && el.textContent === `${EXPLORER_DEFINITIONS} metrics · 1 scopes`,
    );
    expect(rowsOf()).toHaveLength(EXPLORER_DEFINITIONS);
    expect(screen.getByRole('link', { name: 'Catalog' }).getAttribute('aria-current')).toBe('page');
  });

  test('filtering by http. leaves the two http metrics', async () => {
    const user = userEvent.setup();
    await renderCatalog(explorer);
    await screen.findByRole('grid');
    await user.type(screen.getByRole('searchbox', { name: 'Filter metrics' }), 'http.');
    await waitFor(() => expect(rowsOf()).toHaveLength(2));
  });

  test('a capped metric shows its cap and other, and a conflicting name says 2 definitions', async () => {
    await renderCatalog(capped);
    await screen.findByRole('grid');
    const row = rowsOf().find((r) => r.textContent?.includes('capped.gauge'));
    expect(within(row as HTMLElement).getByText(`${TEST_CAP} + other`)).toBeTruthy();
    cleanup();
    await renderCatalog(explorer);
    await screen.findByRole('grid');
    expect(screen.getAllByText('2 definitions')).toHaveLength(2);
  });

  test('a click on a row opens the Explorer on that metric with its default show', async () => {
    const user = userEvent.setup();
    await renderCatalog(explorer);
    await screen.findByRole('grid');
    const row = rowsOf().find((r) => r.textContent?.includes('http.server.request.duration'));
    await user.click(row as HTMLElement);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/metrics\?/));
    const q = parseUrlState(window.location.hash).state.m?.queries[0];
    expect(q).toMatchObject({ metric: 'http.server.request.duration', show: 'p95', kind: null, unit: null });
  });

  test('a conflicting entry carries kind and unit into the query', async () => {
    const user = userEvent.setup();
    await renderCatalog(explorer);
    await screen.findByRole('grid');
    const row = rowsOf().find(
      (r) => r.textContent?.includes('jobs.active') && r.textContent.includes('{job}'),
    );
    await user.click(row as HTMLElement);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/metrics\?/));
    expect(parseUrlState(window.location.hash).state.m?.queries[0]).toMatchObject({
      metric: 'jobs.active',
      kind: 'sum',
      unit: '{job}',
    });
  });

  test('a hostile metric name renders as text', async () => {
    await renderCatalog(capped);
    await screen.findByRole('grid');
    expect(screen.getByText(HOSTILE)).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});
