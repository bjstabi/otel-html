import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { LoadingNote, QueryNote } from '../../src/viewer/components/explorer-states.js';
import { LoadingLine } from '../../src/viewer/shell/loading-line.js';

afterEach(cleanup);

test('the loading note says Loading with a hidden indicator and nothing else', () => {
  render(<LoadingNote />);
  const note = screen.getByRole('status');
  expect(note.textContent).toBe('Loading');
  expect(screen.getByText('Loading')).toBe(note);
  const indicator = note.querySelector('[aria-hidden="true"]');
  expect(indicator?.className).toMatch(/animate-/);
  expect(indicator?.className).toMatch(/motion-reduce:animate-none/);
});

test('the query note while loading carries the indicator too', () => {
  render(<QueryNote loading residual={null} />);
  expect(screen.getByRole('status').querySelector('[aria-hidden="true"]')).not.toBeNull();
});

test('the loading line carries the indicator in both placements', () => {
  for (const placement of ['page', 'pill'] as const) {
    const { unmount } = render(<LoadingLine progress={{ phase: 'engine' }} placement={placement} />);
    const line = screen.getByRole('status');
    expect(line.textContent).toBe('Starting the query engine');
    expect(line.querySelector('[aria-hidden="true"]')).not.toBeNull();
    unmount();
  }
});
