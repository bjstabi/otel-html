import { Tooltip } from '@base-ui/react/tooltip';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { LOG_SEVERITY_KEYS, type LogSeverityKey } from '../../src/semconv/severity.js';
import { useAttributeFacets } from '../../src/viewer/components/facet-panel.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import {
  CORE_LOG_FACET_KEYS,
  CORE_SPAN_FACET_KEYS,
  type LogQuery,
  type LogQueryResult,
  type SpanQuery,
  type SpanQueryResult,
} from '../../src/viewer/data/results.js';
import { LogsExplorer } from '../../src/viewer/logs/explorer.js';
import { GoToContext } from '../../src/viewer/shell/go-to.js';
import { TimeRange } from '../../src/viewer/shell/time-range.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';
import { SelectionProvider } from '../../src/viewer/state/selection-context.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { TracesExplorer } from '../../src/viewer/traces/explorer.js';
import { manifestV4 } from './v4-manifest.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const HOUR = 3_600_000_000_000;
const NOTE = 'Attribute facets are not loaded for windows of 4 h 40 min or longer.';
const TITLE = 'Percentiles over windows of 4 h 40 min or longer are within about 5 %.';
const SHORT = { start: 0, end: 15 * 60_000_000_000 };

/** A report whose range is 6 h, so "no window" is a long window. */
function longManifest(): ManifestV4 {
  const m = manifestV4(10);
  const start = BigInt(m.epochUnixNano);
  return { ...m, range: { start: start.toString(), end: (start + BigInt(6 * HOUR)).toString() } };
}

function spanResult(): SpanQueryResult {
  const facets = new FacetCounts(100, 50, ['service.name']);
  facets.add('service.name', 'web');
  return {
    rows: [],
    total: 0,
    facets,
    buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
    red: null,
    durations: { summary: null, bins: [] },
    groups: null,
    residual: null,
    tables: { resources: [], scopes: [] },
  };
}

function logResult(): LogQueryResult {
  const facets = new FacetCounts(100, 50, ['service.name']);
  return {
    mode: 'logs',
    rows: [],
    total: 0,
    matched: 0,
    facets,
    buckets: new TimeBuckets<LogSeverityKey>(LOG_SEVERITY_KEYS, 8),
    residual: null,
  };
}

function mount(
  page: 'traces' | 'logs',
  initial: Parameters<typeof createSelectionStore>[0],
  window: typeof SHORT | null,
  manifest = longManifest(),
) {
  const spanCalls: SpanQuery[] = [];
  const logCalls: LogQuery[] = [];
  const ds = {
    manifest,
    epoch: BigInt(manifest.epochUnixNano),
    querySpans: (q: SpanQuery) => {
      spanCalls.push(q);
      return Promise.resolve(spanResult());
    },
    queryLogs: (q: LogQuery) => {
      logCalls.push(q);
      return Promise.resolve(logResult());
    },
  } as unknown as DataSource;
  const store = createSelectionStore(initial, BigInt(manifest.epochUnixNano));
  if (window !== null) store.getState().setWindow(window);
  render(
    <ThemeProvider>
      <SelectionProvider store={store}>
        <GoToContext.Provider value={() => {}}>
          <Tooltip.Provider>
            {page === 'traces' ? <TracesExplorer dataSource={ds} /> : <LogsExplorer dataSource={ds} />}
          </Tooltip.Provider>
        </GoToContext.Provider>
      </SelectionProvider>
    </ThemeProvider>,
  );
  return { store, spanCalls, logCalls };
}

describe.each([
  ['traces', CORE_SPAN_FACET_KEYS],
  ['logs', CORE_LOG_FACET_KEYS],
] as const)('%s explorer under a long window', (page, core) => {
  const calls = (
    m: ReturnType<typeof mount>,
  ): { facetKeys: readonly string[] | null; needs: readonly string[] }[] =>
    page === 'traces' ? m.spanCalls : m.logCalls;

  test('long window: the page loads without the attribute-facet statement and shows the section text and the button', async () => {
    const m = mount(page, {}, null);
    expect(await screen.findByText(NOTE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load attribute facets' })).toBeTruthy();
    expect(calls(m)[0]?.facetKeys).toEqual(core);
  });

  test('pressing the button loads them once; changing the filter or the window shows the button again', async () => {
    const user = userEvent.setup();
    const m = mount(page, {}, null);
    await user.click(await screen.findByRole('button', { name: 'Load attribute facets' }));
    await waitFor(() => expect(screen.queryByText(NOTE)).toBeNull());
    const extra = calls(m).filter((c) => c.facetKeys === null);
    expect(extra).toHaveLength(1);
    expect(extra[0]?.needs).toEqual(['facets']);
    act(() => m.store.getState().setCondition('severity_number >= 17'));
    expect(await screen.findByText(NOTE)).toBeTruthy();
  });

  test('short window: attribute facets load with the page and there is no button', async () => {
    const m = mount(page, {}, SHORT);
    await waitFor(() => expect(calls(m).length).toBeGreaterThan(0));
    expect(calls(m)[0]?.facetKeys).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load attribute facets' })).toBeNull();
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});

describe('the time-range label', () => {
  function range(window: typeof SHORT | null, initial: Parameters<typeof createSelectionStore>[0] = {}) {
    const manifest = longManifest();
    const store = createSelectionStore(initial, BigInt(manifest.epochUnixNano));
    if (window !== null) store.getState().setWindow(window);
    render(
      <SelectionProvider store={store}>
        <Tooltip.Provider>
          <TimeRange manifest={manifest} />
        </Tooltip.Provider>
      </SelectionProvider>,
    );
    return store;
  }

  test('long window: the time-range control says "percentiles approximate"; short window: it does not', () => {
    range(null);
    expect(screen.getByText('percentiles approximate').getAttribute('title')).toBe(TITLE);
    cleanup();
    range(SHORT);
    expect(screen.queryByText('percentiles approximate')).toBeNull();
  });

  test('the label follows the window, not the condition: adding an attribute condition changes nothing', () => {
    const store = range(SHORT);
    act(() => store.getState().setCondition('attributes["http.route"] == "/x"'));
    expect(screen.queryByText('percentiles approximate')).toBeNull();
    cleanup();
    const long = range(null);
    act(() => long.getState().setCondition('attributes["http.route"] == "/x"'));
    expect(screen.getByText('percentiles approximate')).toBeTruthy();
  });
});

function Harness(props: { k: string; source: object; load: () => Promise<FacetCounts> }): React.JSX.Element {
  const { facets, notice } = useAttributeFacets(true, props.k, props.source, props.load, null);
  return (
    <div>
      {notice}
      {facets === null ? null : <p>loaded</p>}
    </div>
  );
}

describe('useAttributeFacets', () => {
  const pending = (): { load: () => Promise<FacetCounts>; resolve: () => void } => {
    let resolve: () => void = () => {};
    const load = (): Promise<FacetCounts> =>
      new Promise((r) => {
        resolve = () => r(new FacetCounts(100, 50, ['service.name']));
      });
    return { load, resolve: () => resolve() };
  };
  const button = () => screen.getByRole('button', { name: 'Load attribute facets' });

  test('a response for a request that is no longer current does not re-enable the button', async () => {
    const user = userEvent.setup();
    const source = {};
    const a = pending();
    const b = pending();
    const { rerender } = render(<Harness k="a" source={source} load={a.load} />);
    await user.click(button());
    rerender(<Harness k="b" source={source} load={b.load} />);
    await user.click(button());
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => a.resolve());
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => b.resolve());
    expect(await screen.findByText('loaded')).toBeTruthy();
  });

  test('loaded facets are for the data source that loaded them: a Refresh brings the button back', async () => {
    const user = userEvent.setup();
    const a = pending();
    const first = {};
    const { rerender } = render(<Harness k="a" source={first} load={a.load} />);
    await user.click(button());
    await act(async () => a.resolve());
    expect(await screen.findByText('loaded')).toBeTruthy();
    rerender(<Harness k="a" source={{}} load={a.load} />);
    expect(screen.queryByText('loaded')).toBeNull();
    expect(button()).toBeTruthy();
  });
});
