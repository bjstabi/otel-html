import { act, cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseUnixNanos } from '../../src/model/ids.js';
import { ResultsTable, type ResultsTableProps, tabStop } from '../../src/viewer/components/results-table.js';
import type { SpanRow, TraceRow } from '../../src/viewer/data/results.js';
import { MOVE_EVENT } from '../../src/viewer/shell/move-event.js';
import {
  type ServiceShareLoader,
  SPAN_COLUMNS_UI,
  TRACE_COLUMNS_UI,
} from '../../src/viewer/traces/columns.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const HOSTILE = '</script><img src=x onerror=alert(1)> ';

function row(id: string, name: string, dur: number, over: { code?: number; http?: string } = {}): SpanRow {
  return {
    span: {
      traceId: 'aa',
      spanId: id,
      parentSpanId: null,
      name,
      kind: 2,
      start: 1_000_000,
      end: 1_000_000 + dur,
      status: { code: over.code ?? 1, message: '' },
      attributes: new Map(),
    },
    service: 'web',
    resource: `/r/${id}`,
    durationNs: dur,
  } as unknown as SpanRow;
}

const rows = [row('s1', 'fast', 1_000), row('s2', 'slow', 9_000_000), row('s3', 'mid', 50_000)];
const rowId = (r: SpanRow | TraceRow): string => ('span' in r ? r.span.spanId : r.traceId);

/** Span rows by default; a test that mounts trace rows overrides `rows`, `columns` and `serviceShare` together. */
function mount(
  over: Partial<Omit<ResultsTableProps<unknown>, 'serviceShare'>> & {
    serviceShare?: ServiceShareLoader;
  } = {},
) {
  const onSort = vi.fn();
  const onRowClick = vi.fn();
  render(
    <ResultsTable
      rows={rows}
      columns={SPAN_COLUMNS_UI}
      rowId={rowId}
      sort={null}
      onSort={onSort}
      onRowClick={onRowClick}
      selectedId={null}
      epoch={parseUnixNanos('0', 'epoch')}
      {...(over as object)}
    />,
  );
  return { onSort, onRowClick };
}

describe('ResultsTable', () => {
  test('clicking the Duration header requests a descending sort, then ascending', async () => {
    const user = userEvent.setup();
    const { onSort } = mount();
    await user.click(screen.getByRole('button', { name: /Duration/ }));
    expect(onSort).toHaveBeenLastCalledWith({ column: 'duration', dir: 'desc' });
  });

  test('clicking an already descending column flips it, and aria-sort reports the state', async () => {
    const user = userEvent.setup();
    const { onSort } = mount({ sort: { column: 'duration', dir: 'desc' } });
    expect(screen.getByRole('columnheader', { name: /Duration/ }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    await user.click(screen.getByRole('button', { name: /Duration/ }));
    expect(onSort).toHaveBeenLastCalledWith({ column: 'duration', dir: 'asc' });
  });

  test('when the selected row is not rendered, the first rendered row is the Tab stop', () => {
    const many = Array.from({ length: 3000 }, (_, i) => row(`s${i}`, `n${i}`, 5));
    mount({ rows: many, selectedId: 's2999' });
    const body = screen.getAllByRole('row').slice(1);
    expect(body.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(body[0]?.tabIndex).toBe(0);
  });

  test('tabStop keeps a rendered selection and falls back to the first rendered row', () => {
    expect(tabStop(5, [{ index: 4 }, { index: 5 }])).toBe(5);
    expect(tabStop(2999, [{ index: 10 }, { index: 11 }])).toBe(10);
    expect(tabStop(-1, [{ index: 3 }])).toBe(3);
    expect(tabStop(-1, [])).toBe(0);
  });

  test('renders rows in the given order and marks the selected one', () => {
    mount({ selectedId: 's2' });
    const body = screen.getAllByRole('row').slice(1);
    expect(body.map((r) => within(r).getByText(/fast|slow|mid/).textContent)).toEqual([
      'fast',
      'slow',
      'mid',
    ]);
    expect(body[1]?.getAttribute('aria-selected')).toBe('true');
    expect(body[0]?.getAttribute('aria-selected')).toBe('false');
  });

  test('Enter and click select a row, arrows move focus between rows', async () => {
    const user = userEvent.setup();
    const { onRowClick } = mount();
    const first = screen.getAllByRole('row')[1];
    first?.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getAllByRole('row')[2]);
    await user.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
    await user.click(screen.getByText('mid'));
    expect(onRowClick).toHaveBeenLastCalledWith(rows[2]);
  });

  test('the oh:move event moves the selected row and cleans up on unmount', () => {
    const { onRowClick } = mount({ selectedId: 's1' });
    window.dispatchEvent(new CustomEvent('oh:move', { detail: 1 }));
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
    cleanup();
    onRowClick.mockClear();
    window.dispatchEvent(new CustomEvent('oh:move', { detail: 1 }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  test('two moves before a re-render chain from the row the first one selected', () => {
    const { onRowClick } = mount({ selectedId: 's1' });
    act(() => {
      window.dispatchEvent(new CustomEvent('oh:move', { detail: 1 }));
      window.dispatchEvent(new CustomEvent('oh:move', { detail: 1 }));
    });
    expect(onRowClick.mock.calls.map((c) => c[0])).toEqual([rows[1], rows[2]]);
  });

  test('hostile span names render as text only', () => {
    mount({ rows: [row('s1', HOSTILE, 5)] });
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain(HOSTILE);
  });

  test('status is a labelled dot, never colour alone', () => {
    mount({ rows: [row('s1', 'boom', 5, { code: 2 })] });
    expect(screen.getByText('error')).toBeTruthy();
  });

  describe('the trace table service share cell', () => {
    const t: TraceRow = {
      traceId: 'aa' as TraceRow['traceId'],
      rootSummary: { service: 'web', name: 'GET /', resource: 'GET /' },
      start: 0,
      durationNs: 100,
      spans: 4,
      errors: 0,
    };

    test("loads the share of that row's trace and draws a bar, never a partial label", async () => {
      const serviceShare = vi.fn(() =>
        Promise.resolve([
          { service: 'web', ns: 70 },
          { service: 'db', ns: 30 },
        ]),
      );
      mount({ rows: [t], columns: TRACE_COLUMNS_UI, serviceShare });
      expect(await screen.findByRole('img', { name: 'web 70 ns, db 30 ns' })).toBeTruthy();
      expect(serviceShare).toHaveBeenCalledWith('aa', expect.any(AbortSignal));
      expect(screen.queryByText('partial')).toBeNull();
      expect(screen.getByText('GET /')).toBeTruthy();
    });

    test('a failed load says unavailable for that row only', async () => {
      mount({
        rows: [t],
        columns: TRACE_COLUMNS_UI,
        serviceShare: () => Promise.reject(new Error('engine stopped')),
      });
      expect(await screen.findByText('unavailable')).toBeTruthy();
      expect(screen.getByText('GET /')).toBeTruthy();
    });
  });

  test('a rowHeight change re-measures: rows move to the new pitch and the total follows', () => {
    const props = {
      rows,
      columns: SPAN_COLUMNS_UI,
      rowId,
      sort: null,
      onSort: vi.fn(),
      onRowClick: vi.fn(),
      selectedId: null,
      epoch: parseUnixNanos('0', 'epoch'),
    };
    const { rerender } = render(<ResultsTable {...props} rowHeight={36} />);
    rerender(<ResultsTable {...props} rowHeight={76} />);
    const total = document.querySelector<HTMLElement>('[role="rowgroup"] > div.relative');
    expect(total?.style.height).toBe(`${rows.length * 76}px`);
    const body = screen.getAllByRole('row').slice(1);
    expect(body.map((r) => r.style.transform)).toEqual([
      'translateY(0px)',
      'translateY(76px)',
      'translateY(152px)',
    ]);
  });

  test('rowHeight sizes every row and the virtualizer total', () => {
    mount({ rowHeight: 76 });
    const total = document.querySelector<HTMLElement>('[role="rowgroup"] > div.relative');
    expect(total?.style.height).toBe(`${rows.length * 76}px`);
    expect(screen.getAllByRole('row')[1]?.style.height).toBe('76px');
  });

  test('rows default to 36px', () => {
    mount();
    const total = document.querySelector<HTMLElement>('[role="rowgroup"] > div.relative');
    expect(total?.style.height).toBe(`${rows.length * 36}px`);
  });
});

describe('ResultsTable j/k', () => {
  // A render from a resolved query commits outside `act`: React paints the rows, then runs passive
  // effects in a later task. A j/k press in between (a MutationObserver callback runs there) must move.
  test('j/k moves as soon as the rows are on screen', async () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onRowClick = vi.fn();
    try {
      const pressed = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (container.querySelectorAll('[role="row"]').length === 0) return;
          observer.disconnect();
          window.dispatchEvent(new CustomEvent(MOVE_EVENT, { detail: 1 }));
          resolve();
        });
        observer.observe(container, { childList: true, subtree: true });
      });
      root.render(
        <ResultsTable
          rows={rows}
          columns={SPAN_COLUMNS_UI}
          rowId={rowId}
          sort={null}
          onSort={vi.fn()}
          onRowClick={onRowClick}
          selectedId={null}
          epoch={parseUnixNanos('0', 'epoch')}
        />,
      );
      await pressed;
      expect(onRowClick).toHaveBeenCalledWith(rows[0]);
    } finally {
      root.unmount();
      container.remove();
      env.IS_REACT_ACT_ENVIRONMENT = true;
    }
  });
});
