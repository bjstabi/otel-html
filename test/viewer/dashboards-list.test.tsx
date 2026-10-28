import { cleanup, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { baseManifest, CHECKOUT, dataSourceOf, manifestWith, renderShell } from './dashboard-shell.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

function main() {
  return within(screen.getByRole('main'));
}

describe('dashboards list', () => {
  test('an M3 report lists Fusion: built-in, 4 widgets, starred', () => {
    renderShell('#/dashboards', dataSourceOf(baseManifest));
    expect(screen.getByRole('heading', { name: 'Dashboards', level: 1 })).toBeTruthy();
    const rows = main().getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    const row = within(rows[0] as HTMLElement);
    expect(row.getByRole('link', { name: 'Fusion' }).getAttribute('href')).toBe('#/dashboards/fusion');
    expect(row.getByText('BUILT-IN')).toBeTruthy();
    expect(row.getByText('4')).toBeTruthy();
    expect(row.getByRole('img', { name: 'Default dashboard' })).toBeTruthy();
    expect(main().getByText('1 dashboard')).toBeTruthy();
  });

  test('config dashboards follow Fusion with their source; the filter narrows by name and description', async () => {
    const user = userEvent.setup();
    renderShell('#/dashboards', dataSourceOf(manifestWith([CHECKOUT])));
    expect(main().getAllByRole('row').slice(1)).toHaveLength(2);
    expect(main().getByText('otel-html.yaml')).toBeTruthy();
    expect(main().getByText('2 dashboards')).toBeTruthy();

    await user.type(main().getByRole('searchbox', { name: 'Filter dashboards' }), 'red metrics');
    const rows = main().getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Checkout service' })).toBeTruthy();
    expect(main().getByText('1 dashboard')).toBeTruthy();
  });
});

describe('sidebar', () => {
  test('Dashboards has All dashboards and the starred default', () => {
    renderShell('#/dashboards', dataSourceOf(manifestWith([CHECKOUT], { defaultDashboard: 'checkout' })));
    const section = within(screen.getByRole('region', { name: 'Dashboards' }));
    const all = section.getByRole('link', { name: 'All dashboards' });
    expect(all.getAttribute('aria-current')).toBe('page');
    const starred = section.getByRole('link', { name: '★ Checkout service' });
    expect(starred.getAttribute('href')).toBe('#/dashboards/checkout');
    expect(starred.getAttribute('aria-current')).toBeNull();
  });

  test('the starred item is current on its dashboard, and opening it clears d', async () => {
    const user = userEvent.setup();
    renderShell(
      `#/dashboards/checkout?d=${encodeURIComponent(JSON.stringify({ follow: { logs: false } }))}`,
      dataSourceOf(manifestWith([CHECKOUT], { defaultDashboard: 'checkout' })),
    );
    const section = within(screen.getByRole('region', { name: 'Dashboards' }));
    expect(section.getByRole('link', { name: '★ Checkout service' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(section.getByRole('link', { name: '★ Checkout service' }).getAttribute('href')).toBe(
      '#/dashboards/checkout',
    );
    await user.click(section.getByRole('link', { name: 'All dashboards' }));
    expect(window.location.hash).toBe('#/dashboards');
  });
});
