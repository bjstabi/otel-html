import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../../src/viewer/theme/theme-provider.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe(): React.JSX.Element {
  const { preference } = useTheme();
  return <span id="pref">{preference}</span>;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeProvider', () => {
  it('falls back to system when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const host = document.createElement('div');
    await act(async () => {
      createRoot(host).render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
    });
    expect(host.querySelector('#pref')?.textContent).toBe('system');
  });
});
