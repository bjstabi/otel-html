import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RangeSlider, ZoomRow } from '../../src/viewer/dashboards/range-slider.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

function mount(onZoom: (z: [number, number] | null) => void, zoom: [number, number] | null = null) {
  render(<RangeSlider extent={[0, 1000]} zoom={zoom} ticks={[]} onZoom={onZoom} />);
  const svg = screen.getByTestId('range-slider');
  svg.getBoundingClientRect = () => ({ left: 0, width: 400 }) as DOMRect;
  return svg;
}

test('dragging the left handle by a quarter zooms to [1/4, 1]', () => {
  const onZoom = vi.fn();
  const svg = mount(onZoom);
  fireEvent.pointerDown(screen.getByLabelText('Zoom start'), { clientX: 0 });
  fireEvent.pointerMove(svg, { clientX: 100 });
  expect(onZoom).toHaveBeenLastCalledWith([250, 1000]);
});

test('a drag within 0.5 % of an edge snaps to it', () => {
  const onZoom = vi.fn();
  const svg = mount(onZoom, [250, 1000]);
  fireEvent.pointerDown(screen.getByLabelText('Zoom start'), { clientX: 100 });
  fireEvent.pointerMove(svg, { clientX: 1 });
  expect(onZoom).toHaveBeenLastCalledWith(null);
});

test('double-click resets the zoom', () => {
  const onZoom = vi.fn();
  const svg = mount(onZoom, [250, 500]);
  fireEvent.doubleClick(svg);
  expect(onZoom).toHaveBeenCalledWith(null);
});

test('the end handle drags and clamps at the extent', () => {
  const onZoom = vi.fn();
  const svg = mount(onZoom, [250, 750]);
  fireEvent.pointerDown(screen.getByLabelText('Zoom end'), { clientX: 300 });
  fireEvent.pointerMove(svg, { clientX: 200 });
  expect(onZoom).toHaveBeenLastCalledWith([250, 500]);
  fireEvent.pointerMove(svg, { clientX: 900 });
  expect(onZoom).toHaveBeenLastCalledWith([250, 1000]);
  fireEvent.pointerMove(svg, { clientX: -100 });
  expect(onZoom).toHaveBeenLastCalledWith([250, 251]);
});

test('the body pans and stops at the extent', () => {
  const onZoom = vi.fn();
  const svg = mount(onZoom, [250, 500]);
  const body = svg.querySelector('[data-part="body"]') as Element;
  fireEvent.pointerDown(body, { clientX: 100 });
  fireEvent.pointerMove(svg, { clientX: 140 });
  expect(onZoom).toHaveBeenLastCalledWith([350, 600]);
  fireEvent.pointerMove(svg, { clientX: 1000 });
  expect(onZoom).toHaveBeenLastCalledWith([750, 1000]);
});

test('arrow keys move a handle by 1 %, shift by 10 %', () => {
  const onZoom = vi.fn();
  mount(onZoom, [250, 750]);
  const start = screen.getByLabelText('Zoom start');
  expect(start.getAttribute('tabindex')).toBe('0');
  fireEvent.keyDown(start, { key: 'ArrowRight' });
  expect(onZoom).toHaveBeenLastCalledWith([260, 750]);
  fireEvent.keyDown(screen.getByLabelText('Zoom end'), { key: 'ArrowLeft', shiftKey: true });
  expect(onZoom).toHaveBeenLastCalledWith([260, 650]);
});

test('the writer writes once per frame and flushes the last value on release', () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => frames.splice(0));
  const write = vi.fn();
  render(<ZoomRow extent={[0, 1000]} zoom={null} preset="7d" epoch={0n} onZoom={write} />);
  const svg = screen.getByTestId('range-slider');
  svg.getBoundingClientRect = () => ({ left: 0, width: 400 }) as DOMRect;
  fireEvent.pointerDown(screen.getByLabelText('Zoom start'), { clientX: 0 });
  fireEvent.pointerMove(svg, { clientX: 40 });
  fireEvent.pointerMove(svg, { clientX: 80 });
  fireEvent.pointerMove(svg, { clientX: 100 });
  expect(frames).toHaveLength(1);
  expect(write).not.toHaveBeenCalled();
  fireEvent.pointerUp(svg);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith([250, 1000]);
  vi.unstubAllGlobals();
});

test('an unzoomed 7d page reads last 7 days', () => {
  render(<ZoomRow extent={[0, 1000]} zoom={null} preset="7d" epoch={0n} onZoom={() => {}} />);
  expect(screen.getByTestId('zoom-row').textContent).toContain('last 7 days');
});

test('handles state their time and are 24 px wide whatever the track', () => {
  render(
    <RangeSlider
      extent={[0, 3_600_000_000_000]}
      zoom={[0, 1_800_000_000_000]}
      ticks={[]}
      epoch={1_700_000_000_000_000_000n}
      onZoom={() => {}}
    />,
  );
  expect(screen.getByLabelText('Zoom start').getAttribute('aria-valuetext')).toBe('2023-11-14 22:13');
  expect(screen.getByLabelText('Zoom end').getAttribute('aria-valuetext')).toBe('2023-11-14 22:43');
  expect(screen.getByLabelText('Zoom end').className).toContain('w-6');
  expect(screen.getByLabelText('Zoom end').className).toContain('focus-visible:ring');
});

test('a zoom outside the extent is drawn inside the track', () => {
  mount(() => {}, [-500, 5000]);
  expect(screen.getByLabelText('Zoom start').getAttribute('aria-valuenow')).toBe('0');
  expect(screen.getByLabelText('Zoom end').getAttribute('aria-valuenow')).toBe('1000');
  expect((screen.getByLabelText('Zoom start') as HTMLElement).style.left).toBe('0%');
});

test('dragging across the bare track draws a new range, either way, snapping at the edges', () => {
  const onZoom = vi.fn();
  const svg = mount(onZoom);
  fireEvent.pointerDown(svg, { clientX: 200 });
  fireEvent.pointerMove(svg, { clientX: 300 });
  expect(onZoom).toHaveBeenLastCalledWith([500, 750]);
  fireEvent.pointerMove(svg, { clientX: 100 });
  expect(onZoom).toHaveBeenLastCalledWith([250, 500]);
  fireEvent.pointerMove(svg, { clientX: 399 });
  expect(onZoom).toHaveBeenLastCalledWith([500, 1000]);
  fireEvent.pointerUp(svg);
});

test('a click on the bare track without a move changes nothing', () => {
  const onZoom = vi.fn();
  const svg = mount(onZoom);
  fireEvent.pointerDown(svg, { clientX: 200 });
  fireEvent.pointerUp(svg);
  expect(onZoom).not.toHaveBeenCalled();
});

test('the header says the extent and what is selected, with the count where given', () => {
  const epoch = 1_700_000_000_000_000_000n;
  const { rerender } = render(
    <ZoomRow extent={[0, 3_600_000_000_000]} zoom={null} preset="1h" epoch={epoch} onZoom={() => {}} />,
  );
  expect(screen.getByTestId('zoom-extent').textContent).toBe('2023-11-14 22:13 – 2023-11-14 23:13');
  expect(screen.getByTestId('zoom-selection').textContent).toBe('all selected · drag to zoom');
  rerender(
    <ZoomRow
      extent={[0, 3_600_000_000_000]}
      zoom={null}
      preset="1h"
      epoch={epoch}
      count="12 runs"
      onZoom={() => {}}
    />,
  );
  expect(screen.getByTestId('zoom-selection').textContent).toBe('all 12 runs selected · drag to zoom');
  rerender(
    <ZoomRow
      extent={[0, 3_600_000_000_000]}
      zoom={[0, 1_800_000_000_000]}
      preset="1h"
      epoch={epoch}
      count="5 runs"
      onZoom={() => {}}
    />,
  );
  expect(screen.getByTestId('zoom-selection').textContent).toBe(
    '2023-11-14 22:13 – 2023-11-14 22:43 · 30 minutes · 5 runs',
  );
  expect(screen.getByTestId('zoom-extent').className).toContain('hidden');
  expect(screen.getByTestId('zoom-extent').className).toContain('sm:inline');
});
