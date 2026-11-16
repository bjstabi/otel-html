import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RowCursor } from '../../src/query/sql/cursor.js';
import { useListPages } from '../../src/viewer/state/list-pages.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const cursor = (n: number): RowCursor => ({ time: BigInt(n) }) as unknown as RowCursor;
const page = (rows: string[], next: RowCursor | null) => ({ rows, next });

describe('useListPages', () => {
  test('a query change while the previous first page is shown asks nothing with the previous cursor', async () => {
    const load = vi.fn(async (_c: RowCursor, _s: AbortSignal) => page(['old-2'], null));
    const oldFirst = page(['old-1'], cursor(1));
    const { result, rerender } = renderHook(
      (p: { first: ReturnType<typeof page> | null; key: string }) => useListPages(p.first, p.key, 100, load),
      { initialProps: { first: oldFirst, key: 'a' } },
    );
    await act(async () => result.current.loadMore());
    expect(result.current.rows).toEqual(['old-1', 'old-2']);
    expect(load).toHaveBeenCalledTimes(1);
    // the query changed; the explorer still shows the previous result as `first`
    rerender({ first: oldFirst, key: 'b' });
    expect(result.current.rows).toEqual(['old-1']);
    await act(async () => result.current.loadMore());
    expect(load).toHaveBeenCalledTimes(1);
    // the new first page arrives: continuation works again, from its own cursor
    rerender({ first: page(['new-1'], cursor(9)), key: 'b' });
    await act(async () => result.current.loadMore());
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[0]).toEqual(cursor(9));
    expect(result.current.rows).toEqual(['new-1', 'old-2']);
  });
});
