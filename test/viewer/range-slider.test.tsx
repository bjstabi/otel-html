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
