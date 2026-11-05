import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useThemeTick } from '../../src/viewer/components/theme-tick.js';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('lang');
});

it('ticks when data-theme or class on <html> changes, not on other attributes', async () => {
  const { result, unmount } = renderHook(() => useThemeTick());
  expect(result.current).toBe(0);
  document.documentElement.setAttribute('data-theme', 'dark');
  await waitFor(() => expect(result.current).toBe(1));
  document.documentElement.setAttribute('lang', 'fr');
  await new Promise((r) => setTimeout(r, 0));
  expect(result.current).toBe(1);
  document.documentElement.classList.add('dark');
  await waitFor(() => expect(result.current).toBe(2));
  unmount();
});
