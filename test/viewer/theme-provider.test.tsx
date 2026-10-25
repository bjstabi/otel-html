import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ThemePreference, ThemeProvider, useTheme } from '../../src/viewer/theme/theme-provider.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let setter: ((p: ThemePreference) => void) | null = null;

function Probe(): React.JSX.Element {
  const { preference, resolved, setPreference } = useTheme();
  setter = setPreference;
  return <span id="pref">{`${preference}/${resolved}`}</span>;
}

interface FakeMq {
  matches: boolean;
  listeners: Set<() => void>;
}

function stubMatchMedia(matches: boolean): FakeMq {
  const mq: FakeMq = { matches, listeners: new Set() };
  vi.stubGlobal('matchMedia', (): unknown => ({
    get matches() {
      return mq.matches;
    },
    addEventListener: (_: string, l: () => void) => mq.listeners.add(l),
    removeEventListener: (_: string, l: () => void) => mq.listeners.delete(l),
  }));
  return mq;
}

async function mount(): Promise<{ host: HTMLElement; unmount: () => Promise<void> }> {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
  });
  return { host, unmount: () => act(async () => root.unmount()) };
}

const text = (host: HTMLElement): string | null | undefined => host.querySelector('#pref')?.textContent;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('ThemeProvider', () => {
  it('falls back to system when localStorage throws', async () => {
    stubMatchMedia(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { host } = await mount();
    expect(text(host)).toBe('system/light');
    await act(async () => setter?.('dark'));
    expect(text(host)).toBe('dark/dark');
  });

  it('resolves system from matchMedia, follows changes and sets data-theme', async () => {
    const mq = stubMatchMedia(true);
    const { host } = await mount();
    expect(text(host)).toBe('system/dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    mq.matches = false;
    await act(async () => {
      for (const l of mq.listeners) l();
    });
    expect(text(host)).toBe('system/light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('explicit preference overrides system and persists', async () => {
    stubMatchMedia(true);
    const { host } = await mount();
    await act(async () => setter?.('light'));
    expect(text(host)).toBe('light/light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem('otel-html:theme')).toBe('light');
  });

  it('removes the matchMedia listener on unmount', async () => {
    const mq = stubMatchMedia(false);
    const { unmount } = await mount();
    expect(mq.listeners.size).toBe(1);
    await unmount();
    expect(mq.listeners.size).toBe(0);
  });
});
