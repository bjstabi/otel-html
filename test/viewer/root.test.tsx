import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ManifestV4 } from '../../src/format/manifest.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { type LoadProgress, requireFormat4 } from '../../src/viewer/data/open-report.js';
import { Root } from '../../src/viewer/root.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';

vi.mock('../../src/viewer/shell/shell.js', () => ({ Shell: (): string => 'shell' }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function dataSource(theme: 'system' | 'light' | 'dark'): DataSource {
  return { manifest: { config: { viewer: { theme } } } as ManifestV4 } as DataSource;
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

describe('loading phases', () => {
  test('the status line names the engine, the partition and the views phase', async () => {
    let report: (p: LoadProgress) => void = () => undefined;
    let finish: (d: DataSource) => void = () => undefined;
    const load = (onProgress: (p: LoadProgress) => void): Promise<DataSource> => {
      report = onProgress;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    render(<Root load={load} history={createHashHistory(window)} />);
    expect(screen.getByRole('status').textContent).toBe('Loading report');
    act(() => report({ phase: 'engine' }));
    expect(screen.getByRole('status').textContent).toBe('Starting the query engine');
    act(() => report({ phase: 'partitions', done: 11, total: 89 }));
    expect(screen.getByRole('status').textContent).toBe('Loading partition 12 of 89');
    act(() => report({ phase: 'views' }));
    expect(screen.getByRole('status').textContent).toBe('Preparing views');
    await act(async () => finish(dataSource('system')));
    await screen.findByText('shell');
  });
});

describe('the format gate (D12)', () => {
  const v3 = { formatVersion: 3 } as unknown as Parameters<typeof requireFormat4>[0];

  test('a format-3 manifest fails with the merge hint', () => {
    expect(() => requireFormat4(v3)).toThrow(
      'This report is format 3; this viewer reads format 4. `otel-html merge <report> --out <new>` converts it.',
    );
  });

  test('App shows that text when the load fails with it', async () => {
    const load = (): Promise<DataSource> => {
      try {
        requireFormat4(v3);
      } catch (e) {
        return Promise.reject(e);
      }
      return Promise.reject(new Error('unreachable'));
    };
    render(<Root load={load} history={createHashHistory(window)} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This report is format 3; this viewer reads format 4.');
  });
});
