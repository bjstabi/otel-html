import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { baseManifest, dataSourceOf } from './dashboard-shell.js';

vi.mock('../../src/viewer/components/chart.js', () => ({ Chart: (): null => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderShell(phone: boolean): void {
  vi.stubGlobal('matchMedia', () => ({
    matches: phone,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  window.location.hash = '#/traces';
  render(
    <ThemeProvider>
      <Shell dataSource={dataSourceOf(baseManifest)} history={createHashHistory(window)} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the sidebar drawer on phones', () => {
  test('desktop keeps the sidebar and has no menu button', () => {
    renderShell(false);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  });

  test('on a phone the sidebar is hidden until the menu button opens it, and focus goes in', () => {
    renderShell(true);
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    const button = screen.getByRole('button', { name: 'Menu' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('Navigation'));
  });

  test('Escape closes it and returns focus to the button', async () => {
    renderShell(true);
    const button = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByLabelText('Navigation'), { key: 'Escape' });
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  test('it is a modal dialog the button controls; Tab cycles inside it', () => {
    renderShell(true);
    const button = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Navigation' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(dialog.id);
    const focusable = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) throw new Error('focusable controls');
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    dialog.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test('Escape elsewhere on the page does not close it', () => {
    renderShell(true);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });

  test('a click outside closes it', () => {
    renderShell(true);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
  });

  test('following a link closes it', async () => {
    renderShell(true);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const link = screen.getAllByRole('link')[0];
    if (link === undefined) throw new Error('a link');
    fireEvent.click(link);
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull());
  });
});
