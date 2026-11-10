import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { InProgress } from '../../src/viewer/shell/in-progress.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const threeMinAgo = new Date(NOW - 3 * 60_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const props = (over: Partial<Parameters<typeof InProgress>[0]> = {}): Parameters<typeof InProgress>[0] => ({
  updatedAt: threeMinAgo,
  complete: false,
  refresh: vi.fn(),
  busy: false,
  error: null,
  poll: false,
  onPoll: vi.fn(),
  ...over,
});

describe('InProgress', () => {
  test('says the report is in progress and how old the manifest is', () => {
    render(<InProgress {...props()} />);
    expect(screen.getByText('In progress · updated 3 min ago')).toBeTruthy();
  });

  test('renders nothing for a complete report', () => {
    const { container } = render(<InProgress {...props({ complete: true })} />);
    expect(container.textContent).toBe('');
  });

  test('the Refresh button calls refresh', () => {
    const p = props();
    render(<InProgress {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(p.refresh).toHaveBeenCalledTimes(1);
  });

  test('a served report (no refresh) shows the line without a button or a checkbox', () => {
    render(<InProgress {...props({ refresh: null })} />);
    expect(screen.getByText(/In progress/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  test('the Auto-refresh checkbox shows the poll state and reports a change', () => {
    const p = props();
    const { rerender } = render(<InProgress {...p} />);
    const box = screen.getByRole('checkbox', { name: 'Auto-refresh' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(p.onPoll).toHaveBeenCalledWith(true);
    rerender(<InProgress {...p} poll />);
    expect((screen.getByRole('checkbox', { name: 'Auto-refresh' }) as HTMLInputElement).checked).toBe(true);
    act(() => vi.advanceTimersByTime(120_000));
    expect(p.refresh).not.toHaveBeenCalled(); // the line has no timer; App owns it
  });

  test('a failed refresh is an inline alert on the line', () => {
    render(<InProgress {...props({ error: 'manifest did not load' })} />);
    expect(screen.getByRole('alert').textContent).toContain('manifest did not load');
  });

  test('works when sessionStorage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render(<InProgress {...props()} />);
    expect((screen.getByRole('checkbox', { name: 'Auto-refresh' }) as HTMLInputElement).checked).toBe(false);
    spy.mockRestore();
  });
});

describe('InProgress poll vs a slow refresh', () => {
  test('a tick while a refresh runs does not start another', () => {
    const p = props({ busy: true });
    window.sessionStorage.setItem('otel-html.poll', '1');
    render(<InProgress {...p} />);
    act(() => vi.advanceTimersByTime(180_000));
    expect(p.refresh).not.toHaveBeenCalled();
  });
});
