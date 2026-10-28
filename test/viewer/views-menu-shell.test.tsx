import { cleanup, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { LOCAL_VIEWS_KEY } from '../../src/viewer/shell/views-menu.js';
import { baseManifest, dataSourceOf, renderShell } from './dashboard-shell.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  window.localStorage.clear();
  window.location.hash = '';
});
afterEach(cleanup);

test('a hand-edited browser view with invalid params reaches the shell URL notice', async () => {
  window.localStorage.setItem(
    LOCAL_VIEWS_KEY,
    JSON.stringify([{ id: 'x', title: 'Broken', page: 'traces', search: 'q=%28%28&bogus=1&t=9~1' }]),
  );
  const user = userEvent.setup();
  renderShell('#/traces?t=1~5', dataSourceOf(baseManifest));
  await user.click(await screen.findByRole('button', { name: /Views/ }));
  await user.click(await screen.findByRole('menuitem', { name: 'Broken' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Some link parameters were invalid');
  expect(alert.textContent).toContain('q: expected');
  expect(alert.textContent).toContain('bogus: unknown parameter');
});
