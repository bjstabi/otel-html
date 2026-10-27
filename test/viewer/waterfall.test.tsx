import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { flattenVisible, traceExtent, Waterfall } from '../../src/viewer/components/waterfall.js';
import { detailOf, spanIdOf, traceRow } from './trace-rows.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const HOSTILE = '</script><img src=x onerror=alert(1)> ';

const trace = () =>
  detailOf([
    traceRow(1, null, 0, 1000, { service: 'web', name: 'GET /' }),
    traceRow(2, 1, 100, 400, { service: 'db', name: 'db.query', error: true }),
    traceRow(3, 2, 150, 300, { service: 'db', name: 'db.parse' }),
    traceRow(4, 1, 500, 800, { service: 'web', name: 'render' }),
    traceRow(9, 77, 1200, 1300, { service: 'cache', name: 'orphan.get' }), // parent never arrived
  ]).tree;

describe('flattenVisible / traceExtent', () => {
  test('lists every span in depth-first order, orphans as later roots', () => {
    const rows = flattenVisible(trace(), new Set());
    expect(rows.map((r) => [r.node.row.span.name, r.node.depth])).toEqual([
      ['GET /', 0],
      ['db.query', 1],
      ['db.parse', 2],
      ['render', 1],
      ['orphan.get', 0],
    ]);
  });

  test('a collapsed node hides its subtree', () => {
    const tree = trace();
    const query = tree.byId.get(spanIdOf(2));
    if (query === undefined) throw new Error('fixture');
    expect(flattenVisible(tree, new Set([query])).map((r) => r.node.row.span.name)).toEqual([
      'GET /',
      'db.query',
      'render',
      'orphan.get',
    ]);
  });

  test('the shared axis covers children that start before or end after their parent', () => {
    const { tree } = detailOf([
      traceRow(1, null, 100, 200),
      traceRow(2, 1, 50, 60),
      traceRow(3, 1, 190, 260),
    ]);
    expect(traceExtent(tree)).toEqual({ start: 50, end: 260 });
  });

  test('zero-duration traces still have a non-empty axis', () => {
    const { tree } = detailOf([traceRow(1, null, 5, 5)]);
    expect(traceExtent(tree)).toEqual({ start: 5, end: 6 });
  });
});

describe('Waterfall', () => {
  test('renders a tree item per visible span with level, error icon plus label and duration text', () => {
    render(<Waterfall tree={trace()} selectedSpanId={null} onSelect={() => undefined} />);
    const items = screen.getAllByRole('treeitem');
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '3', '2', '1']);
    const failing = items[1];
    if (failing === undefined) throw new Error('row');
    expect(within(failing).getByText('error')).toBeTruthy();
    expect(within(failing).getByText('300 ns')).toBeTruthy();
    expect(within(items[0] ?? failing).queryByText('error')).toBeNull();
  });

  test('clicking a row selects it; Enter selects the focused row; the selected row is the ink pill', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Waterfall tree={trace()} selectedSpanId={spanIdOf(4)} onSelect={onSelect} />);
    await user.click(screen.getByText('db.parse'));
    expect(onSelect).toHaveBeenLastCalledWith(spanIdOf(3));
    const selected = screen.getAllByRole('treeitem').find((i) => i.getAttribute('aria-selected') === 'true');
    expect(selected?.getAttribute('data-span-id')).toBe(spanIdOf(4));
    expect(selected?.className).toContain('bg-ink');
    selected?.focus();
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith(spanIdOf(3));
  });

  test('collapse and expand through the chevron and the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Waterfall tree={trace()} selectedSpanId={null} onSelect={() => undefined} />);
    await user.click(screen.getAllByRole('button', { name: 'Collapse children' })[0] ?? document.body);
    expect(screen.getAllByRole('treeitem')).toHaveLength(1 + 1);
    const root = screen.getAllByRole('treeitem')[0];
    expect(root?.getAttribute('aria-expanded')).toBe('false');
    root?.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getAllByRole('treeitem')).toHaveLength(5);
  });

  test('hostile names render as text, never markup', () => {
    const { tree } = detailOf([
      traceRow(1, null, 0, 100, { service: HOSTILE, name: HOSTILE }),
      traceRow(2, 1, 10, 20, { service: 'svc', name: `${HOSTILE} child` }),
    ]);
    const { container } = render(<Waterfall tree={tree} selectedSpanId={null} onSelect={() => undefined} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    const names = screen.getAllByRole('treeitem').map((i) => i.textContent ?? '');
    expect(names[0]).toContain(HOSTILE);
    expect(container.textContent).toContain(`${HOSTILE} child`);
  });

  test('50k spans mount a window of rows, not all of them', () => {
    const rows = [traceRow(1, null, 0, 50_000_000)];
    for (let i = 2; i <= 50_000; i++) rows.push(traceRow(i, 1, i * 100, i * 100 + 50));
    const { tree } = detailOf(rows);
    render(<Waterfall tree={tree} selectedSpanId={null} onSelect={() => undefined} />);
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(60);
  });
});
