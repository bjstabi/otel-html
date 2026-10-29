import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AnyValue } from '../../src/model/anyvalue.js';
import { parseUnixNanos, type RelNanos } from '../../src/model/ids.js';
import type { ResourceRecord, ScopeRecord } from '../../src/model/records.js';
import { LogList } from '../../src/viewer/components/log-list.js';
import { type LogRow, logRef } from '../../src/viewer/data/log-query.js';
import { LOG_COLUMNS_UI } from '../../src/viewer/logs/columns.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const epoch = parseUnixNanos('1700000000000000000', 'epoch');

function row(
  i: number,
  over: Partial<LogRow> & { traceId?: string | null; attrs?: [string, AnyValue][]; sev?: number } = {},
): LogRow {
  return {
    ref: logRef(0, i),
    log: {
      time: 1_000_000 as RelNanos,
      observedTime: null,
      severityNumber: over.sev ?? 17,
      severityText: 'ERROR',
      body: { kind: 'string', value: `body ${i}` },
      attributes: new Map(over.attrs ?? []),
      droppedAttributesCount: 0,
      flags: 0,
      traceId: over.traceId ?? null,
      spanId: null,
      eventName: '',
    },
    resource: {} as ResourceRecord,
    scope: {} as ScopeRecord,
    time: 1_000_000 as RelNanos,
    timeSource: over.timeSource ?? 'time',
    service: 'web',
    host: 'h1',
  } as unknown as LogRow;
}

function mount(rows: readonly LogRow[], extra: Partial<Parameters<typeof LogList>[0]> = {}) {
  const onSort = vi.fn();
  const onRowClick = vi.fn();
  render(
    <LogList
      rows={rows}
      sort={{ column: 'time', dir: 'desc' }}
      onSort={onSort}
      onRowClick={onRowClick}
      selectedRef={null}
      epoch={epoch}
      {...extra}
    />,
  );
  return { onSort, onRowClick };
}

describe('LogList', () => {
  test('renders the six columns with severity, service and body', () => {
    mount([row(0, { traceId: 'abc' })]);
    for (const h of ['Time', 'Severity', 'Service', 'Host', 'Body', 'Trace'])
      expect(screen.getByRole('columnheader', { name: new RegExp(h) })).toBeTruthy();
    expect(screen.getByText('ERROR · 17')).toBeTruthy();
    expect(screen.getByText('body 0')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'trace' }).getAttribute('href')).toBe('#/traces/trace/abc');
  });

  test('a trace id the report does not hold is plain text, not a link to a missing trace page', async () => {
    const hasTrace = vi.fn((id: string) => Promise.resolve(id === 'abc'));
    mount([row(0, { traceId: 'abc' }), row(1, { traceId: 'f00d' })], { hasTrace });
    expect((await screen.findByRole('link', { name: 'trace' })).getAttribute('href')).toBe(
      '#/traces/trace/abc',
    );
    const orphan = await screen.findByTitle('trace not in this report');
    expect(orphan.textContent).toBe('f00d');
    expect(orphan.closest('a')).toBeNull();
    expect(screen.getAllByRole('link', { name: 'trace' })).toHaveLength(1);
  });

  test('a failed trace lookup leaves the id as text and says so', async () => {
    mount([row(0, { traceId: 'abc' })], { hasTrace: () => Promise.reject(new Error('shard failed')) });
    expect((await screen.findByTitle('could not check the trace')).textContent).toBe('abc');
    expect(screen.queryByRole('link', { name: 'trace' })).toBeNull();
  });

  test('a log without a trace shows a dash, not a link', () => {
    mount([row(0)]);
    expect(screen.queryByRole('link', { name: 'trace' })).toBeNull();
  });

  test('observed and missing timestamps are marked', () => {
    mount([row(0, { timeSource: 'observed' }), row(1, { timeSource: 'none' })]);
    expect(screen.getByText('observed')).toBeTruthy();
    expect(screen.getByText('no timestamp')).toBeTruthy();
  });

  test('lines option changes row height (20 x lines + 16)', async () => {
    mount([row(0)]);
    const rowEl = (): HTMLElement => screen.getAllByRole('row')[1] as HTMLElement;
    expect(rowEl().style.height).toBe('36px');
    const select = screen.getByRole('combobox', { name: 'Lines' });
    await userEvent.setup().selectOptions(select, '3');
    expect(rowEl().style.height).toBe('76px');
    await userEvent.setup().selectOptions(select, '10');
    expect(rowEl().style.height).toBe('216px');
  });

  test('the lines option clamps the body cell to that many lines', async () => {
    mount([row(0)]);
    const clamp = (): string => {
      const el = screen.getByText('body 0');
      return el.style.getPropertyValue('-webkit-line-clamp') || el.style.webkitLineClamp;
    };
    expect(clamp()).toBe('1');
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Lines' }), '3');
    expect(clamp()).toBe('3');
  });

  test('its columns are the ones LOG_COLUMNS_UI names, in order, so the explorer sorts what the list shows', () => {
    mount([row(0)]);
    const shown = screen.getAllByRole('columnheader').map((h) => h.textContent?.replace(/[^A-Za-z]/g, ''));
    expect(shown).toEqual(LOG_COLUMNS_UI.map((c) => c.header));
    const sortable = screen.getAllByRole('columnheader').filter((h) => h.hasAttribute('aria-sort'));
    expect(sortable).toHaveLength(LOG_COLUMNS_UI.filter((c) => c.sort !== undefined).length);
  });

  test('clicking a row reports it; sort headers report the sort column', async () => {
    const { onSort, onRowClick } = mount([row(0)]);
    const user = userEvent.setup();
    await user.click(screen.getByText('body 0'));
    expect(onRowClick).toHaveBeenCalledOnce();
    await user.click(within(screen.getByRole('columnheader', { name: /Severity/ })).getByRole('button'));
    expect(onSort).toHaveBeenCalledWith({ column: 'severity', dir: 'desc' });
  });

  test('extra attribute columns show the attribute value', () => {
    mount([row(0, { attrs: [['user.id', { kind: 'string', value: 'u-7' }]] })], {
      extraColumns: ['user.id'],
    });
    expect(screen.getByRole('columnheader', { name: 'user.id' })).toBeTruthy();
    expect(screen.getByText('u-7')).toBeTruthy();
  });

  test('shows how many of the total are loaded', () => {
    mount([row(0)], { total: 5 });
    expect(screen.getByText(/1 of 5/)).toBeTruthy();
  });

  test('highlighted rows carry data-match; the others are muted; without the set nothing is marked', () => {
    mount([row(0), row(1)], { highlighted: new Set([logRef(0, 1)]) });
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((r) => r.hasAttribute('data-match'))).toEqual([false, true]);
    expect(rows[0]?.hasAttribute('data-muted')).toBe(true);
    expect(rows[1]?.hasAttribute('data-muted')).toBe(false);
    cleanup();
    mount([row(0), row(1)]);
    for (const r of screen.getAllByRole('row').slice(1)) {
      expect(r.hasAttribute('data-match')).toBe(false);
      expect(r.hasAttribute('data-muted')).toBe(false);
    }
  });
});
