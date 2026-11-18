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
    await user.click(b.getByRole('button', { name: 'all' }));
    expect(currentD()?.vars ?? {}).toEqual({});
    expect(b.getByRole('button', { name: 'all' }).getAttribute('aria-pressed')).toBe('true');
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
    await user.click(b.getByRole('button', { name: 'Unpin filters' }));
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
    await user.click(b.getByRole('button', { name: 'Unpin filters' }));
    expect(screen.getByTestId('filter-bar').className).not.toContain('sticky');
  });

  test('it keeps an empty run count slot', async () => {
    show();
    await bar();
    expect(screen.getByTestId('run-count-slot').textContent).toBe('');
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

  test('the shell header has no second range control on a dashboard page', async () => {
    renderShell('#/dashboards/ci', dataSourceOf(manifest, VALUES));
    await bar();
    expect(screen.getAllByRole('button', { name: 'Time range' })).toHaveLength(1);
    expect(screen.queryByRole('group', { name: 'Time range' })).toBeNull();
  });
});
