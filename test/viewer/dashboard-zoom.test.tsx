import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DashboardSchema } from '../../src/dashboards/schema.js';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { currentD, dataSourceOf, manifestWith, renderShell } from './dashboard-shell.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CI = DashboardSchema.parse({
  id: 'ci',
  title: 'CI',
  widgets: [{ type: 'timeline', x: 0, y: 0, w: 12, h: 6 }],
});
const HOUR = 3_600_000_000_000n;

function manifest(formatVersion: number): ManifestV4 {
  const base = manifestWith([CI]);
  const start = BigInt(base.range?.start ?? '0');
  return {
    ...base,
    formatVersion,
    range: { start: start.toString(), end: (start + 31n * HOUR).toString() },
  } as ManifestV4;
}

beforeEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Drags the start handle to x on a 873.5 px track (a width that makes every position fractional). */
async function dragStart(x: number): Promise<void> {
  const svg = await screen.findByTestId('range-slider');
  svg.getBoundingClientRect = () => ({ left: 0, width: 873.5 }) as DOMRect;
  fireEvent.pointerDown(screen.getByLabelText('Zoom start'), { clientX: 0 });
  fireEvent.pointerMove(svg, { clientX: x });
  fireEvent.pointerUp(svg);
}

test('a drag on a fractional track writes whole nanoseconds, unanchored', async () => {
  renderShell('#/dashboards/ci', dataSourceOf(manifest(5)));
  await dragStart(437);
  const t = currentD()?.sel?.t;
  expect(t).toMatch(/^[0-9]+~[0-9]+$/);
  const [a, b] = (t ?? '').split('~').map(Number);
  expect(a).toBeGreaterThan(0);
  expect(b).toBe(31 * 3_600_000_000_000);
});

test('a drag on a fractional track writes whole nanoseconds, anchored', async () => {
  renderShell('#/dashboards/ci', dataSourceOf(manifest(6)));
  await dragStart(437);
  const t = currentD()?.sel?.t;
  expect(t).toMatch(/^[0-9]{19}~[0-9]{19}$/);
});

test('two arrow presses within one frame build on each other', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => frames.splice(0));
  renderShell('#/dashboards/ci', dataSourceOf(manifest(5)));
  const start = await screen.findByLabelText('Zoom start');
  fireEvent.keyDown(start, { key: 'ArrowRight' });
  fireEvent.keyDown(start, { key: 'ArrowRight' });
  for (const f of frames.splice(0)) f(0);
  const [a] = (currentD()?.sel?.t ?? '').split('~').map(Number);
  expect(a).toBe(Math.round(31 * 3_600_000_000_000 * 0.02));
  vi.unstubAllGlobals();
});
