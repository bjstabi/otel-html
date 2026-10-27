import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Manifest } from '../../src/format/manifest.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { Root } from '../../src/viewer/root.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';

vi.mock('../../src/viewer/shell/shell.js', () => ({ Shell: (): string => 'shell' }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function dataSource(theme: 'system' | 'light' | 'dark'): DataSource {
  return { manifest: { config: { viewer: { theme } } } as Manifest, strategy: 'eager' } as DataSource;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }));
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('viewer.theme', () => {
  test('the report default applies once the manifest has loaded', async () => {
    render(<Root load={() => Promise.resolve(dataSource('dark'))} history={createHashHistory(window)} />);
    await screen.findByText('shell');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  test('a theme the viewer saved themselves wins over the report default', async () => {
    window.localStorage.setItem('otel-html:theme', 'light');
    render(<Root load={() => Promise.resolve(dataSource('dark'))} history={createHashHistory(window)} />);
    await screen.findByText('shell');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
