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

  test('Auto-refresh is off by default; checked, it refreshes every 60 s and is remembered', () => {
    const p = props();
    render(<InProgress {...p} />);
    const box = screen.getByRole('checkbox', { name: 'Auto-refresh' });
    expect((box as HTMLInputElement).checked).toBe(false);
    act(() => vi.advanceTimersByTime(120_000));
    expect(p.refresh).not.toHaveBeenCalled();
    fireEvent.click(box);
    act(() => vi.advanceTimersByTime(59_000));
    expect(p.refresh).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(p.refresh).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('otel-html.poll')).toBe('1');
    fireEvent.click(box);
    act(() => vi.advanceTimersByTime(120_000));
    expect(p.refresh).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('otel-html.poll')).toBe('0');
  });

  test('a remembered choice starts the poll checked', () => {
    window.sessionStorage.setItem('otel-html.poll', '1');
    render(<InProgress {...props()} />);
    expect((screen.getByRole('checkbox', { name: 'Auto-refresh' }) as HTMLInputElement).checked).toBe(true);
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
