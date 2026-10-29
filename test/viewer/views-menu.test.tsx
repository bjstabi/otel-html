import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { View } from '../../src/dashboards/schema.js';
import type { Manifest } from '../../src/format/manifest.js';
import {
  LOCAL_VIEWS_KEY,
  readLocalViews,
  ViewsMenu,
  viewToUrl,
  writeLocalViews,
} from '../../src/viewer/shell/views-menu.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = (over: Partial<View>): View => ({
  id: 'v',
  title: 'V',
  page: 'logs',
  query: null,
  text: '',
  mode: null,
  groupBy: null,
  view: null,
  sort: null,
  metrics: null,
  ...over,
});

const manifestWith = (views: View[]): Manifest => ({
  formatVersion: 1,
  otelHtmlVersion: '0.0.0',
  title: 'run',
  epochUnixNano: '1700000000000000000',
  createdAt: '2023-11-14T22:13:20.000Z',
  updatedAt: '2023-11-14T22:13:20.000Z',
  complete: true,
  range: { start: 0, end: 1_000_000_000 },
  totals: { spans: 1, logs: 1, metrics: 1 },
  decodedBytes: 1,
  chunks: [],
  rollups: [],
  traceShards: [],
  metricFiles: [],
  config: {
    viewer: {
      eagerBudgetBytes: 1,
      listCap: 100,
      theme: 'system',
      defaultDashboard: 'fusion',
      home: 'traces',
    },
    dashboards: [],
    views,
  },
});

const CONFIG_VIEWS = [
  view({ id: 'p', title: 'Error patterns', page: 'logs', mode: 'patterns', query: 'severity_number >= 17' }),
  view({ id: 't', title: 'Slow traces', page: 'traces', query: 'duration > 1' }),
];

function mount(page: 'traces' | 'logs' | 'metrics'): void {
  render(
    <ThemeProvider>
      <ViewsMenu page={page} manifest={manifestWith(CONFIG_VIEWS)} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = `#/logs?t=5~9&q=body%3D%3D%22x%22&trace=${'a'.repeat(32)}&tab=logs&ltab=attributes`;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('viewToUrl', () => {
  test('maps query, groupBy and metrics to q, group and m and takes t from keepT', () => {
    expect(
      viewToUrl(view({ query: 'a == 1', groupBy: 'k', mode: 'patterns', view: 'toplist' }), '1~2'),
    ).toEqual({
      q: 'a == 1',
      group: 'k',
      mode: 'patterns',
      view: 'toplist',
      t: '1~2',
    });
    expect(viewToUrl(view({}), undefined)).toEqual({});
  });
});

describe('readLocalViews', () => {
  test('bad JSON, a bad shape and throwing storage give no views', () => {
    expect(readLocalViews({ getItem: () => '{bad' })).toEqual([]);
    expect(readLocalViews({ getItem: () => '[{"id":1}]' })).toEqual([]);
    expect(
      readLocalViews({
        getItem: () => {
          throw new Error('no');
        },
      }),
    ).toEqual([]);
    expect(readLocalViews(null)).toEqual([]);
  });
});

describe('writeLocalViews', () => {
  test('is false for no storage or a throwing setItem, true otherwise', () => {
    expect(writeLocalViews(null, [])).toBe(false);
    expect(
      writeLocalViews(
        {
          setItem: () => {
            throw new Error('quota');
          },
        },
        [],
      ),
    ).toBe(false);
    expect(writeLocalViews({ setItem: () => undefined }, [])).toBe(true);
  });
});

describe('ViewsMenu', () => {
  test('a refused write shows Could not save and keeps the dialog open', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const user = userEvent.setup();
    mount('logs');
    await user.click(screen.getByRole('button', { name: /Views/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Save current view/ }));
    await user.type(screen.getByRole('textbox', { name: 'View title' }), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save');
    expect(screen.getByRole('textbox', { name: 'View title' })).toBeTruthy();
  });

  test('lists a config view only on its own page and applying it keeps t', async () => {
    const user = userEvent.setup();
    mount('logs');
    await user.click(screen.getByRole('button', { name: /Views/ }));
    expect(screen.queryByText('Slow traces')).toBeNull();
    await user.click(await screen.findByRole('menuitem', { name: 'Error patterns' }));
    const params = new URLSearchParams(window.location.hash.split('?')[1]);
    expect(params.get('mode')).toBe('patterns');
    expect(params.get('q')).toBe('severity_number >= 17');
    expect(params.get('t')).toBe('5~9');
    expect(params.has('trace')).toBe(false);
  });

  test('saves the current view, lists it after a remount, applies it and deletes it', async () => {
    const user = userEvent.setup();
    mount('logs');
    await user.click(screen.getByRole('button', { name: /Views/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Save current view/ }));
    await user.type(screen.getByRole('textbox', { name: 'View title' }), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const stored = readLocalViews(window.localStorage);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.search).toBe('q=body%3D%3D%22x%22');

    cleanup();
    window.location.hash = '#/logs?t=1~2&mode=patterns';
    mount('logs');
    await user.click(screen.getByRole('button', { name: /Views/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mine' }));
    const params = new URLSearchParams(window.location.hash.split('?')[1]);
    expect(params.get('q')).toBe('body=="x"');
    expect(params.get('t')).toBe('1~2');
    expect(params.has('mode')).toBe(false);

    await user.click(screen.getByRole('button', { name: /Views/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete view Mine' }));
    expect(readLocalViews(window.localStorage)).toEqual([]);
  });

  test('saving and deleting keep a view another tab saved after this one loaded', async () => {
    const user = userEvent.setup();
    mount('logs');
    const other = { id: 'other', title: 'Other tab', page: 'logs', search: 'q=a' } as const;
    window.localStorage.setItem(LOCAL_VIEWS_KEY, JSON.stringify([other]));
    await user.click(screen.getByRole('button', { name: /Views/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Save current view/ }));
    await user.type(screen.getByRole('textbox', { name: 'View title' }), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(readLocalViews(window.localStorage).map((v) => v.title)).toEqual(['Other tab', 'Mine']);

    const third = { id: 'third', title: 'Third tab', page: 'logs', search: 'q=b' } as const;
    window.localStorage.setItem(
      LOCAL_VIEWS_KEY,
      JSON.stringify([...readLocalViews(window.localStorage), third]),
    );
    await user.click(screen.getByRole('button', { name: /Views/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete view Mine' }));
    expect(readLocalViews(window.localStorage).map((v) => v.title)).toEqual(['Other tab', 'Third tab']);
  });

  test('a stored "{bad" lists no local views and does not throw', async () => {
    window.localStorage.setItem(LOCAL_VIEWS_KEY, '{bad');
    const user = userEvent.setup();
    mount('logs');
    await user.click(screen.getByRole('button', { name: /Views/ }));
    expect(screen.queryByText('Browser storage is unavailable')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Delete view/ })).toBeNull();
    await user.click(await screen.findByRole('menuitem', { name: /Save current view/ }));
    await user.type(screen.getByRole('textbox', { name: 'View title' }), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(readLocalViews(window.localStorage).map((v) => v.title)).toEqual(['Mine']);
  });

  test('a view saved on one page is listed only on that page', async () => {
    const user = userEvent.setup();
    mount('logs');
    await user.click(screen.getByRole('button', { name: /Views/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Save current view/ }));
    await user.type(screen.getByRole('textbox', { name: 'View title' }), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    cleanup();
    mount('traces');
    await user.click(screen.getByRole('button', { name: /Views/ }));
    expect(await screen.findByRole('menuitem', { name: 'Slow traces' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Mine' })).toBeNull();
  });

  test('storage whose getItem throws says it is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = userEvent.setup();
    mount('logs');
    await user.click(screen.getByRole('button', { name: /Views/ }));
    expect(await screen.findByText('Browser storage is unavailable')).toBeTruthy();
  });
});
