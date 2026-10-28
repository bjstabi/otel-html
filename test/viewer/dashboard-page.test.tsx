import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FUSION } from '../../src/dashboards/fusion.js';
import type { TraceId } from '../../src/model/ids.js';
import { dashboardToYaml } from '../../src/viewer/dashboards/copy-config.js';
import { widgetHeightPx } from '../../src/viewer/dashboards/grid.js';
import {
  baseManifest,
  CHECKOUT,
  currentD,
  dataSourceOf,
  manifestWith,
  renderShell,
} from './dashboard-shell.js';

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
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Timeline', 'Traces', 'Logs', 'Metrics']);
    expect(main().getByText('timeline widget')).toBeTruthy();
    expect(main().getByText('metric widget')).toBeTruthy();
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
    renderShell('#/dashboards/fusion', dataSourceOf(baseManifest, VALUES));
    await waitFor(() => expect(main().getAllByRole('region')).toHaveLength(4));
    expect(
      main()
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(['Timeline', 'Traces', 'Logs', 'Metrics']);
    expect((screen.getByRole('button', { name: 'Edit layout' }) as HTMLButtonElement).disabled).toBe(true);
    vi.unstubAllGlobals();
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
