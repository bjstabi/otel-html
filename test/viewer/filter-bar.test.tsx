import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DashboardSchema } from '../../src/dashboards/schema.js';
import { currentD, dataSourceOf, manifestWith, renderShell } from './dashboard-shell.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REF = 'vcs.ref.head.name';
const TRIGGER = 'cicd.pipeline.trigger';
const CI = DashboardSchema.parse({
  id: 'ci',
  title: 'CI',
  variables: [REF, TRIGGER],
  quick: [
    { label: 'main', set: { [REF]: 'main', [TRIGGER]: null } },
    { label: 'pull requests', set: { [TRIGGER]: 'pull_request' } },
    { label: 'all', set: { [REF]: null, [TRIGGER]: null } },
  ],
  widgets: [{ type: 'timeline', x: 0, y: 0, w: 12, h: 6 }],
});
const VALUES = {
  [REF]: { values: ['main', 'dev'], kind: 'string' as const, capped: false },
  [TRIGGER]: { values: ['push', 'pull_request'], kind: 'string' as const, capped: false },
};
const manifest = manifestWith([CI]);
const show = (): ReturnType<typeof renderShell> =>
  renderShell('#/dashboards/ci', dataSourceOf(manifest, VALUES));
const bar = async () => within(await screen.findByRole('group', { name: 'Page filters' }));

beforeEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the page filter bar', () => {
  test('pressing main sets the ref and clears the trigger; all clears both; the pressed pill follows', async () => {
    const user = userEvent.setup();
    renderShell(
      `#/dashboards/ci?d=${encodeURIComponent(JSON.stringify({ vars: { [TRIGGER]: 'push' } }))}`,
      dataSourceOf(manifest, VALUES),
    );
    const b = await bar();
    await user.click(b.getByRole('button', { name: 'main' }));
    expect(currentD()?.vars).toEqual({ [REF]: 'main' }); // a null equal to the default is no override
    expect(b.getByRole('button', { name: 'main' }).getAttribute('aria-pressed')).toBe('true');
    expect(b.getByRole('button', { name: 'all' }).getAttribute('aria-pressed')).toBe('false');
    expect(b.getByRole('button', { name: 'pull requests' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(b.getByRole('button', { name: 'pull requests' }));
    expect(b.getByRole('button', { name: 'pull requests' }).getAttribute('aria-pressed')).toBe('true');
    expect(b.getByRole('button', { name: 'main' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(b.getByRole('button', { name: 'all' }));
    expect(currentD()?.vars ?? {}).toEqual({});
    expect(b.getByRole('button', { name: 'all' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('pressing a pressed pill clears its variables', async () => {
    const user = userEvent.setup();
    renderShell(
      `#/dashboards/ci?d=${encodeURIComponent(JSON.stringify({ vars: { [REF]: 'dev' } }))}`,
      dataSourceOf(manifest, VALUES),
    );
    const b = await bar();
    await user.click(b.getByRole('button', { name: 'pull requests' }));
    expect(currentD()?.vars).toEqual({ [REF]: 'dev', [TRIGGER]: 'pull_request' });
    await user.click(b.getByRole('button', { name: 'pull requests' }));
    expect(currentD()?.vars).toEqual({ [REF]: 'dev' });
    expect(b.getByRole('button', { name: 'pull requests' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('a set variable is a chip whose x clears it; an unset one is a + button', async () => {
    const user = userEvent.setup();
    show();
    const b = await bar();
    expect(b.getByRole('combobox', { name: TRIGGER }).textContent).toContain(`+ ${TRIGGER}`);
    await user.click(b.getByRole('combobox', { name: REF }));
    await user.click(await screen.findByRole('option', { name: 'dev' }));
    expect(currentD()?.vars).toEqual({ [REF]: 'dev' });
    expect(b.getByRole('combobox', { name: REF }).textContent).toContain(`${REF} = dev`);
    await user.click(b.getByRole('button', { name: `Clear ${REF}` }));
    expect(currentD()?.vars ?? {}).toEqual({});
    expect(b.queryByRole('button', { name: `Clear ${REF}` })).toBeNull();
  });

  test('the bar is pinned by default; unpinning stores false', async () => {
    const user = userEvent.setup();
    show();
    const b = await bar();
    expect(screen.getByTestId('filter-bar').className).toContain('sticky');
    expect(b.getByRole('button', { name: 'Pin filters' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(b.getByRole('button', { name: 'Pin filters' }));
    expect(b.getByRole('button', { name: 'Pin filters' }).getAttribute('aria-pressed')).toBe('false');
    expect(window.localStorage.getItem('otel-html.filters.pinned')).toBe('false');
    expect(screen.getByTestId('filter-bar').className).not.toContain('sticky');
  });

  test('a throwing localStorage still renders, pinned', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = userEvent.setup();
    show();
    const b = await bar();
    expect(screen.getByTestId('filter-bar').className).toContain('sticky');
    await user.click(b.getByRole('button', { name: 'Pin filters' }));
    expect(screen.getByTestId('filter-bar').className).not.toContain('sticky');
  });

  test('the range menu stays while the variables load or could not be read', async () => {
    const ds = dataSourceOf(manifest, VALUES);
    renderShell('#/dashboards/ci', {
      ...ds,
      resourceValues: () => new Promise(() => undefined),
    });
    const b = await bar();
    expect(b.getByRole('button', { name: 'Time range' })).toBeTruthy();
    expect(b.queryByRole('combobox', { name: REF })).toBeNull();
    expect(b.queryByRole('button', { name: 'main' })).toBeNull();
    cleanup();
    renderShell('#/dashboards/ci', {
      ...ds,
      resourceValues: () => Promise.reject(new Error('no values')),
    });
    const failed = await bar();
    await screen.findByText(/Could not read the variables' values/);
    expect(failed.getByRole('button', { name: 'Time range' })).toBeTruthy();
    expect(failed.queryByRole('combobox', { name: REF })).toBeNull();
  });

  test('a preset, a custom range and a step clear the zoom', async () => {
    const user = userEvent.setup();
    const zoom = JSON.stringify({ sel: { t: '5400000000000~7200000000000' } });
    const zoomed = `#/dashboards/ci?t=3600000000000~10800000000000&d=${encodeURIComponent(zoom)}`;
    for (const choose of [
      async () => {
        await user.click(screen.getByRole('button', { name: 'Time range' }));
        await user.click(await screen.findByRole('menuitem', { name: '1h' }));
      },
      async () => {
        await user.click(screen.getByRole('button', { name: 'Next window' }));
      },
    ]) {
      renderShell(zoomed, dataSourceOf(manifest, VALUES));
      await bar();
      expect(currentD()?.sel?.t).toBe('5400000000000~7200000000000');
      await choose();
      expect(currentD()?.sel?.t ?? null).toBeNull();
      cleanup();
    }
  });

  test('Cancel and Escape close the custom range inputs, which open with focus', async () => {
    const user = userEvent.setup();
    show();
    const b = await bar();
    await user.click(b.getByRole('button', { name: 'Time range' }));
    await user.click(await screen.findByRole('menuitem', { name: 'custom…' }));
    const from = b.getByLabelText('Custom range from (UTC)');
    await waitFor(() => expect(document.activeElement).toBe(from));
    await user.click(b.getByRole('button', { name: 'Cancel' }));
    expect(b.queryByLabelText('Custom range from (UTC)')).toBeNull();
    await user.click(b.getByRole('button', { name: 'Time range' }));
    await user.click(await screen.findByRole('menuitem', { name: 'custom…' }));
    await user.keyboard('{Escape}');
    expect(b.queryByLabelText('Custom range from (UTC)')).toBeNull();
  });

  describe('stuck', () => {
    let notify: (intersecting: boolean) => void = () => undefined;
    beforeEach(() => {
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
            notify = (isIntersecting) => cb([{ isIntersecting }]);
          }
          observe(): void {}
          disconnect(): void {}
        },
      );
    });

    test('the bar gets the stuck class when its sentinel leaves the viewport', async () => {
      show();
      await bar();
      expect(screen.getByTestId('filter-bar').className).not.toContain('stuck');
      act(() => notify(false));
      expect(screen.getByTestId('filter-bar').className).toContain('stuck');
      act(() => notify(true));
      expect(screen.getByTestId('filter-bar').className).not.toContain('stuck');
    });

    test('under 768 px the slider row hides while stuck', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
      show();
      await bar();
      expect(screen.getByTestId('zoom-row')).toBeTruthy();
      act(() => notify(false));
      await waitFor(() => expect(screen.queryByTestId('zoom-row')).toBeNull());
    });
  });

  test('the bar keeps previous, next and zoom out beside the range dropdown', async () => {
    const user = userEvent.setup();
    show();
    const b = await bar();
    await user.click(b.getByRole('button', { name: 'Time range' }));
    await user.click(await screen.findByRole('menuitem', { name: '1h' }));
    expect(b.getByRole('button', { name: 'Next window' }).hasAttribute('disabled')).toBe(true);
    const prev = b.getByRole('button', { name: 'Previous window' });
    expect(prev.hasAttribute('disabled')).toBe(false);
    await user.click(prev);
    await waitFor(() => expect(window.location.hash).toContain('t='));
    expect(b.getByRole('button', { name: 'Next window' }).hasAttribute('disabled')).toBe(false);
    expect(b.getByRole('button', { name: 'Zoom out' }).hasAttribute('disabled')).toBe(false);
  });

  test('the bar says percentiles are approximate over a long window', async () => {
    const day = 86_400_000_000_000;
    const long = {
      ...manifest,
      range: {
        start: manifest.range?.start ?? '0',
        end: String(BigInt(manifest.range?.start ?? '0') + BigInt(30 * day)),
      },
    };
    renderShell('#/dashboards/ci?t=all', dataSourceOf(long, VALUES));
    const b = await bar();
    expect(b.getByText('percentiles approximate')).toBeTruthy();
  });

  test('the shell header has no second range control on a dashboard page', async () => {
    renderShell('#/dashboards/ci', dataSourceOf(manifest, VALUES));
    await bar();
    expect(screen.getAllByRole('button', { name: 'Time range' })).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'Time range' })).toBeNull();
  });
});
