import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FUSION } from '../../src/dashboards/fusion.js';
import { DashboardSchema } from '../../src/dashboards/schema.js';
import type { TraceId } from '../../src/model/ids.js';
import { dashboardToYaml } from '../../src/viewer/dashboards/copy-config.js';
import { WIDGETS } from '../../src/viewer/dashboards/dashboard-page.js';
import { widgetHeightPx } from '../../src/viewer/dashboards/grid.js';
import {
  baseManifest,
  CHECKOUT,
  currentD,
  dataSourceOf,
  manifestWith,
  renderShell,
} from './dashboard-shell.js';

// jsdom has no layout or ResizeObserver, which ECharts needs; the timeline's chart is covered by its own test.
vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TRACE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90' as TraceId;
const dParam = (d: object): string => `d=${encodeURIComponent(JSON.stringify(d))}`;

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const main = () => within(screen.getByRole('main'));

const VALUES = {
  'service.name': { values: ['web', 'db'], kind: 'string' as const, capped: false },
};

describe('the dashboard page', () => {
  test('Fusion renders four widget frames titled Timeline, Traces, Logs and Metrics', async () => {
    renderShell('#/dashboards/fusion', dataSourceOf(baseManifest, VALUES));
    expect(screen.getByRole('heading', { name: 'Fusion', level: 1 })).toBeTruthy();
    await waitFor(() => expect(main().getAllByRole('region')).toHaveLength(4));
    expect(
      main()
        .getAllByRole('region')
        .map((r) => r.querySelector('h2')?.textContent),
    ).toEqual(['Timeline', 'Traces', 'Logs', 'Metrics']);
  });

  test('an unknown id renders the not-found card with a link to the list', () => {
    renderShell('#/dashboards/nope', dataSourceOf(baseManifest));
    expect(screen.getByText('Dashboard not found')).toBeTruthy();
    expect(main().getByRole('link', { name: 'All dashboards' }).getAttribute('href')).toBe('#/dashboards');
  });

  test('the timeline has no follow toggle; toggling the Logs frame writes d.follow.logs = false', async () => {
    const user = userEvent.setup();
    renderShell('#/dashboards/fusion', dataSourceOf(baseManifest, VALUES));
    await waitFor(() => expect(main().getAllByRole('region')).toHaveLength(4));
    expect(
      within(main().getByRole('region', { name: 'Timeline' })).queryByRole('button', {
        name: /follows selection/,
      }),
    ).toBeNull();
    const logs = within(main().getByRole('region', { name: 'Logs' }));
    const toggle = logs.getByRole('button', { name: /follows selection/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(toggle);
    expect(currentD()?.follow).toEqual({ logs: false });
    expect(logs.getByRole('button', { name: /follows selection/ }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  test('a stale id in d shows the notice, and Reset clears it', async () => {
    const user = userEvent.setup();
    renderShell(
      `#/dashboards/fusion?${dParam({ follow: { zzz: false }, vars: { nope: 'x' } })}`,
      dataSourceOf(baseManifest, VALUES),
    );
    const notice = await screen.findByText(
      /This link refers to widgets or variables this dashboard does not have/,
    );
    expect(notice.textContent).toContain('follow.zzz');
    expect(notice.textContent).toContain('vars.nope');
    await user.click(
      within(notice.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Reset' }),
    );
    expect(screen.queryByText(/This link refers to widgets/)).toBeNull();
    expect(currentD()).toBeUndefined();
  });
});

describe('selection chips', () => {
  const SEL = { sel: { t: '3600000000000~3660000000000', trace: TRACE } };

  test('the chips show the window and the shortened trace id; each removes itself', async () => {
    const user = userEvent.setup();
    renderShell(`#/dashboards/fusion?${dParam(SEL)}`, dataSourceOf(baseManifest, VALUES));
    const chips = await screen.findByRole('list', { name: 'Selection' });
    expect(within(chips).getByText(/2023-11-14T23:13:20\.000Z – 2023-11-14T23:14:20\.000Z/)).toBeTruthy();
    const trace = within(chips).getByText('a1b2…90');
    expect(trace.getAttribute('title')).toBe(TRACE);

    await user.click(screen.getByRole('button', { name: 'Remove trace selection' }));
    expect(currentD()?.sel).toEqual({ t: SEL.sel.t, trace: null });
    await user.click(screen.getByRole('button', { name: 'Remove time selection' }));
    expect(screen.queryByRole('list', { name: 'Selection' })).toBeNull();
  });

  test('Clear all removes both chips', async () => {
    const user = userEvent.setup();
    renderShell(`#/dashboards/fusion?${dParam(SEL)}`, dataSourceOf(baseManifest, VALUES));
    await user.click(await screen.findByRole('button', { name: 'Clear all' }));
    expect(screen.queryByRole('list', { name: 'Selection' })).toBeNull();
    expect(currentD()).toBeUndefined();
  });

  test('a selection outside the page time range says so', async () => {
    renderShell(`#/dashboards/fusion?t=0~1000000000&${dParam(SEL)}`, dataSourceOf(baseManifest, VALUES));
    expect(await screen.findByText(/outside the time range/)).toBeTruthy();
  });
});

describe('variables', () => {
  test('a variable with no values is hidden and counted', async () => {
    renderShell('#/dashboards/fusion', dataSourceOf(baseManifest, VALUES));
    await screen.findByText('2 variables have no values in this report');
    expect(screen.getByText('service.name')).toBeTruthy();
    expect(screen.queryByText('host.name')).toBeNull();
  });

  test('choosing a value writes d.vars; all is first, and a capped list ends with a disabled note', async () => {
    const user = userEvent.setup();
    renderShell(
      '#/dashboards/fusion',
      dataSourceOf(baseManifest, {
        'service.name': { values: ['web', 'db'], kind: 'string', capped: true },
      }),
    );
    await user.click(await screen.findByRole('combobox', { name: 'service.name' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['all', 'web', 'db', '(more values not listed)']);
    expect(options[3]?.getAttribute('aria-disabled')).toBe('true');
    await user.click(options[1] as HTMLElement);
    expect(currentD()?.vars).toEqual({ 'service.name': 'web' });
  });

  test('the dashboard passes its window and asks again when the window changes', async () => {
    const resourceValues = vi.fn((_key: string, _opts: { window: { start: number; end: number } | null }) =>
      Promise.resolve(VALUES['service.name']),
    );
    renderShell('#/dashboards/checkout?t=0~1000000000', {
      ...dataSourceOf(manifestWith([CHECKOUT])),
      resourceValues,
    });
    await screen.findByRole('combobox', { name: 'service.name' });
    expect(resourceValues).toHaveBeenLastCalledWith(
      'service.name',
      { window: { start: 0, end: 1e9 } },
      expect.anything(),
    );
    window.location.hash = '#/dashboards/checkout?t=2000000000~3000000000';
    await waitFor(() =>
      expect(resourceValues).toHaveBeenLastCalledWith(
        'service.name',
        { window: { start: 2e9, end: 3e9 } },
        expect.anything(),
      ),
    );
    expect(screen.getByRole('combobox', { name: 'service.name' })).toBeTruthy(); // the bar stays while it reloads
  });

  test('a selection change asks the values again, with the selection', async () => {
    const resourceValues = vi.fn(() =>
      Promise.resolve({ values: ['5'], kind: 'int' as const, capped: false }),
    );
    renderShell('#/dashboards/checkout?t=0~1000000000', {
      ...dataSourceOf(manifestWith([CHECKOUT])),
      resourceValues,
    });
    await screen.findByRole('combobox', { name: 'service.name' });
    const before = resourceValues.mock.calls.length;
    window.location.hash = `#/dashboards/checkout?t=0~1000000000&${dParam({ vars: { 'service.name': 'abc' } })}`;
    // 'abc' is not among the window's values: the window is asked again, then the report for its kind
    await waitFor(() => expect(resourceValues.mock.calls.length).toBeGreaterThanOrEqual(before + 2));
    expect(resourceValues.mock.calls.slice(before).map((c) => (c as unknown[])[1])).toEqual([
      { window: { start: 0, end: 1e9 } },
      { window: null },
    ]);
  });

  test('a fast second window change aborts the first request and its late answer is ignored', async () => {
    const signals = new Map<number, AbortSignal>();
    const release: (() => void)[] = [];
    type Answer = { values: string[]; kind: 'string'; capped: boolean };
    const resourceValues = vi.fn(
      (_key: string, opts: { window: { start: number; end: number } | null }, signal?: AbortSignal) => {
        if (signal !== undefined && opts.window !== null) signals.set(opts.window.start, signal);
        if (opts.window?.start !== 2e9)
          return Promise.resolve<Answer>({ values: ['fresh'], kind: 'string', capped: false });
        return new Promise<Answer>((resolve) =>
          release.push(() => resolve({ values: ['late'], kind: 'string', capped: false })),
        );
      },
    );
    const user = userEvent.setup();
    renderShell('#/dashboards/checkout?t=0~1000000000', {
      ...dataSourceOf(manifestWith([CHECKOUT])),
      resourceValues,
    });
    await screen.findByRole('combobox', { name: 'service.name' });
    window.location.hash = '#/dashboards/checkout?t=2000000000~3000000000'; // not answered until released
    await waitFor(() => expect(release.length).toBeGreaterThan(0));
    window.location.hash = '#/dashboards/checkout?t=4000000000~5000000000';
    await waitFor(() => expect(signals.has(4e9)).toBe(true));
    expect(signals.get(2e9)?.aborted).toBe(true);
    for (const r of release) r(); // the first request answers after it was aborted
    await new Promise((r) => setTimeout(r, 20));
    await user.click(screen.getByRole('combobox', { name: 'service.name' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['all', 'fresh']);
  });

  test('a selected value with no data in the window stays selected and is shown in the list', async () => {
    const user = userEvent.setup();
    const optionTexts = async (): Promise<string[]> =>
      (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    renderShell(
      `#/dashboards/checkout?t=0~1000000000&${dParam({ vars: { 'service.name': 'run-a' } })}`,
      dataSourceOf(manifestWith([CHECKOUT]), {
        'service.name': { values: ['run-b'], kind: 'string', capped: false },
      }),
    );
    const box = await screen.findByRole('combobox', { name: 'service.name' });
    expect(box.textContent).toContain('run-a');
    await user.click(box);
    expect(await optionTexts()).toEqual(expect.arrayContaining(['run-a', 'run-b']));
    expect(window.location.hash).toContain('run-a');
  });

  test('a value that cannot be applied is reported, not dropped silently', async () => {
    const typed = {
      ...CHECKOUT,
      variables: [{ key: 'http.status', label: 'http.status', default: null }],
    };
    renderShell(
      `#/dashboards/checkout?${dParam({ vars: { 'http.status': 'abc' } })}`,
      dataSourceOf(manifestWith([typed]), {
        'http.status': { values: ['200', '500'], kind: 'int', capped: false },
      }),
    );
    const note = await screen.findByText(/http\.status = abc can't be applied: expected/);
    expect(note.getAttribute('role')).toBe('alert');
  });
});

describe('layout editing and Copy config', () => {
  test('Edit layout shows Done and Reset layout and a Move handle per widget', async () => {
    const user = userEvent.setup();
    renderShell('#/dashboards/fusion', dataSourceOf(baseManifest, VALUES));
    await waitFor(() => expect(main().getAllByRole('region')).toHaveLength(4));
    expect(screen.queryByRole('button', { name: 'Move Logs' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit layout' }));
    expect(screen.getByRole('button', { name: 'Move Logs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset layout' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: 'Move Logs' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit layout' })).toBeTruthy();
  });

  test('Copy config copies the dashboard YAML', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderShell('#/dashboards/fusion', dataSourceOf(baseManifest, VALUES));
    await user.click(screen.getByRole('button', { name: /Copy config/ }));
    expect(writeText).toHaveBeenCalledWith(dashboardToYaml(FUSION, FUSION.widgets));
    vi.unstubAllGlobals();
  });

  test('without a clipboard Copy config falls back to a dialog with the text', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    renderShell('#/dashboards/fusion', dataSourceOf(baseManifest, VALUES));
    await user.click(screen.getByRole('button', { name: /Copy config/ }));
    const box = await screen.findByRole('textbox', { name: 'Dashboard config' });
    expect((box as HTMLTextAreaElement).value).toContain('id: fusion-copy');
    vi.unstubAllGlobals();
  });
});

describe('Open in and narrow screens', () => {
  test('Open in Traces goes to the explorer with the widget window and the variable filter', async () => {
    const user = userEvent.setup();
    renderShell(
      `#/dashboards/fusion?t=0~3600000000000&${dParam({ vars: { 'service.name': 'web' } })}`,
      dataSourceOf(baseManifest, VALUES),
    );
    await user.click(await screen.findByRole('button', { name: /Open in Traces/ }));
    expect(window.location.hash.startsWith('#/traces?')).toBe(true);
    const q = new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?'))).get('q');
    expect(q).toBe('resource.attributes["service.name"] == "web"');
    expect(window.location.hash).toContain('t=0~3600000000000');
  });

  test('below 768 px the widgets stack in (y, x) order and Edit layout is disabled', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    // Listed out of reading order on purpose.
    const shuffled = DashboardSchema.parse({
      id: 'shuffled',
      title: 'Shuffled',
      widgets: [
        { type: 'logs', x: 6, y: 6, w: 6, h: 8 },
        { type: 'traces', x: 0, y: 6, w: 6, h: 8 },
        { type: 'timeline', x: 0, y: 0, w: 12, h: 6 },
      ],
    });
    renderShell('#/dashboards/shuffled', dataSourceOf(manifestWith([shuffled]), VALUES));
    await waitFor(() => expect(main().getAllByRole('region')).toHaveLength(3));
    expect(
      main()
        .getAllByRole('region')
        .map((r) => r.querySelector('h2')?.textContent),
    ).toEqual(['Timeline', 'Traces', 'Logs']);
    expect((screen.getByRole('button', { name: 'Edit layout' }) as HTMLButtonElement).disabled).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('what a run chart widget does to the page', () => {
  const RUN = 'cicd.pipeline.run.id';
  const QUERY = { id: 'a', metric: 'm', show: 'avg' };
  const widget = { type: 'metric', x: 0, y: 0, w: 12, h: 8, queries: [QUERY] };
  const RUNS = DashboardSchema.parse({
    id: 'runs',
    title: 'Runs',
    variables: [RUN],
    widgets: [
      {
        ...widget,
        id: 'jobs',
        title: 'Jobs',
        runBy: `resource.attributes["${RUN}"]`,
        controls: { legend: true },
      },
    ],
  });
  const OTHER = DashboardSchema.parse({
    id: 'other',
    title: 'Other',
    widgets: [{ type: 'timeline', x: 0, y: 0, w: 12, h: 6 }],
  });
  const RUN_VALUES = { [RUN]: { values: ['100', '200'], kind: 'string' as const, capped: false } };
  const OFF = { slider: false, evenSpacing: true, split: true, legend: true };

  /** The metric renderer swapped for buttons on its actions, so the page's state is all that's under test. */
  function probed(run: () => void): () => void {
    const original = WIDGETS.metric;
    WIDGETS.metric = ({ actions, controls, variables }) => (
      <div>
        <output aria-label="controls">{JSON.stringify(controls)}</output>
        <output aria-label="bound">{variables.map((v) => `${v.key}=${v.value}`).join()}</output>
        <button type="button" onClick={() => actions.setVariable(RUN, '200')}>
          pick
        </button>
        <button type="button" onClick={() => actions.setControls(OFF)}>
          toggle
        </button>
      </div>
    );
    run();
    return () => {
      WIDGETS.metric = original;
    };
  }
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  const shown = (name: string): string => screen.getByRole('status', { name }).textContent ?? '';

  test('controls start as the config has them, and setControls replaces them for the widget', async () => {
    const user = userEvent.setup();
    restore = probed(() => renderShell('#/dashboards/runs', dataSourceOf(manifestWith([RUNS]), RUN_VALUES)));
    await screen.findByRole('button', { name: 'toggle' });
    expect(JSON.parse(shown('controls'))).toEqual({
      slider: true,
      evenSpacing: true,
      split: true,
      legend: true,
    });
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(JSON.parse(shown('controls'))).toEqual(OFF);
  });

  test('a toggle survives the page re-rendering, and never reaches the URL', async () => {
    const user = userEvent.setup();
    restore = probed(() => renderShell('#/dashboards/runs', dataSourceOf(manifestWith([RUNS]), RUN_VALUES)));
    await user.click(await screen.findByRole('button', { name: 'toggle' }));
    const before = window.location.hash;
    expect(before).not.toMatch(/slider|controls/);
    await user.click(screen.getByRole('button', { name: /follows selection/ }));
    expect(currentD()?.follow).toEqual({ jobs: false });
    expect(JSON.parse(shown('controls'))).toEqual(OFF);
    expect(window.location.hash).not.toMatch(/slider|controls/);
  });

  test('a toggle lasts through leaving the dashboard and coming back', async () => {
    const user = userEvent.setup();
    restore = probed(() =>
      renderShell('#/dashboards/runs', dataSourceOf(manifestWith([RUNS, OTHER]), RUN_VALUES)),
    );
    await user.click(await screen.findByRole('button', { name: 'toggle' }));
    await user.click(screen.getByRole('button', { name: 'Dashboards' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Other' }));
    await screen.findByRole('heading', { name: 'Other', level: 1 });
    await user.click(screen.getByRole('button', { name: 'Dashboards' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Runs' }));
    await screen.findByRole('button', { name: 'toggle' });
    expect(JSON.parse(shown('controls'))).toEqual(OFF);
  });

  test('setVariable updates what the variables bar reads and shows, and binds the widget', async () => {
    const user = userEvent.setup();
    restore = probed(() => renderShell('#/dashboards/runs', dataSourceOf(manifestWith([RUNS]), RUN_VALUES)));
    await user.click(await screen.findByRole('button', { name: 'pick' }));
    expect(currentD()?.vars).toEqual({ [RUN]: '200' });
    expect(shown('bound')).toBe(`${RUN}=200`);
    expect(within(main().getByRole('combobox')).getByText('200')).toBeTruthy();
  });

  test('setVariable to the config default is no override, as in the variables bar', async () => {
    const user = userEvent.setup();
    const withDefault = DashboardSchema.parse({
      ...RUNS,
      variables: [{ key: RUN, default: '200' }],
    });
    const d = dParam({ vars: { [RUN]: '100' } });
    restore = probed(() =>
      renderShell(`#/dashboards/runs?${d}`, dataSourceOf(manifestWith([withDefault]), RUN_VALUES)),
    );
    await user.click(await screen.findByRole('button', { name: 'pick' }));
    expect(currentD()).toBeUndefined();
    expect(shown('bound')).toBe(`${RUN}=200`);
  });

  test('Copy config writes the current toggles', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn((_: string) => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    restore = probed(() => renderShell('#/dashboards/runs', dataSourceOf(manifestWith([RUNS]), RUN_VALUES)));
    await user.click(await screen.findByRole('button', { name: 'toggle' }));
    await user.click(screen.getByRole('button', { name: /Copy config/ }));
    expect(writeText).toHaveBeenCalledWith(
      dashboardToYaml(RUNS, [{ x: 0, y: 0, w: 12, h: 8 }], { jobs: OFF }),
    );
    expect(writeText.mock.calls[0]?.[0]).toContain('slider: false');
    vi.unstubAllGlobals();
  });
});

describe('a failing widget', () => {
  test('shows the error inside its frame while the other frames still render', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = WIDGETS.logs;
    WIDGETS.logs = () => {
      throw new Error('boom from logs');
    };
    try {
      renderShell('#/dashboards/fusion', dataSourceOf(baseManifest, VALUES));
      await waitFor(() => expect(main().getAllByRole('region')).toHaveLength(4));
      const logs = within(main().getByRole('region', { name: 'Logs' }));
      expect(logs.getByRole('alert').textContent).toContain('boom from logs');
      expect(
        await within(main().getByRole('region', { name: 'Traces' })).findByText('No traces match'),
      ).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Fusion', level: 1 })).toBeTruthy();
    } finally {
      WIDGETS.logs = original;
    }
  });
});

describe('navigation', () => {
  test('g d opens the configured default dashboard', async () => {
    const user = userEvent.setup();
    renderShell('#/traces', dataSourceOf(manifestWith([CHECKOUT], { defaultDashboard: 'checkout' })));
    await user.keyboard('gd');
    expect(window.location.hash).toBe('#/dashboards/checkout');
  });

  test('# lands on traces by default and on the default dashboard with viewer.home dashboards', () => {
    renderShell('', dataSourceOf(baseManifest));
    expect(window.location.hash.startsWith('#/traces')).toBe(true);
    cleanup();
    renderShell(
      '',
      dataSourceOf(manifestWith([CHECKOUT], { home: 'dashboards', defaultDashboard: 'checkout' })),
    );
    expect(window.location.hash).toBe('#/dashboards/checkout');
  });

  test('the Dashboards menu switches dashboards and drops d', async () => {
    const user = userEvent.setup();
    renderShell(
      `#/dashboards/fusion?${dParam({ follow: { logs: false } })}`,
      dataSourceOf(manifestWith([CHECKOUT]), VALUES),
    );
    await user.click(screen.getByRole('button', { name: 'Dashboards' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Checkout service' }));
    expect(window.location.hash).toBe('#/dashboards/checkout');
  });

  test('widgetHeightPx follows rows x 20 plus gaps x 10', () => {
    expect(widgetHeightPx(1)).toBe(20);
    expect(widgetHeightPx(6)).toBe(170);
    expect(widgetHeightPx(13)).toBe(380);
  });
});
