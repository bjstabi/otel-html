import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { RangeSlider } from '../../src/viewer/dashboards/range-slider.js';

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
