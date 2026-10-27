import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { FacetCounts } from '../../src/rollups/facets.js';
import { RedSeries } from '../../src/rollups/red.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import type { DataSource, SpanQuery, SpanQueryResult } from '../../src/viewer/data/data-source.js';
import { useSpanQuery } from '../../src/viewer/traces/use-span-query.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const query = (text: string, scanAll = false): SpanQuery => ({
  condition: null,
  text,
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 10,
  groupBy: null,
  scanAll,
});

const resultOf = (total: number): SpanQueryResult => ({
  rows: [],
  total,
  facets: new FacetCounts(10, 10),
  buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
  red: new RedSeries(8),
  partial: null,
});

interface Call {
  q: SpanQuery;
  signal: AbortSignal | undefined;
  onProgress: ((s: number, t: number) => void) | undefined;
  resolve(r: SpanQueryResult): void;
  reject(e: unknown): void;
}

/** A data source whose queries stay pending until the test settles them, in any order. */
function scripted(): { ds: DataSource; calls: Call[] } {
  const calls: Call[] = [];
  const ds = {
    querySpans: (q, onProgress, signal) =>
      new Promise<SpanQueryResult>((resolve, reject) => {
        calls.push({ q, signal, onProgress, resolve, reject });
      }),
  } as DataSource;
  return { ds, calls };
}

function Probe(props: { ds: DataSource; q: SpanQuery }): React.JSX.Element {
  const { state, scanAll } = useSpanQuery(props.ds, props.q);
  return (
    <div>
      <output data-testid="s">
        {state.status === 'ready'
          ? `ready:${state.result.total}`
          : state.status === 'error'
            ? `error:${state.message}`
            : `loading:${state.progress?.scanned ?? '-'}`}
      </output>
      <button type="button" onClick={scanAll}>
        scan
      </button>
    </div>
  );
}

const text = (): string => screen.getByTestId('s').textContent ?? '';

describe('useSpanQuery', () => {
  test('a slow earlier query never overwrites a newer result, and is aborted', async () => {
    const { ds, calls } = scripted();
    const { rerender } = render(<Probe ds={ds} q={query('a')} />);
    rerender(<Probe ds={ds} q={query('b')} />);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal?.aborted).toBe(true);
    await act(async () => calls[1]?.resolve(resultOf(2)));
    expect(text()).toBe('ready:2');
    await act(async () => calls[0]?.resolve(resultOf(1)));
    expect(text()).toBe('ready:2');
  });

  test('an aborted query that rejects shows nothing', async () => {
    const { ds, calls } = scripted();
    const { rerender } = render(<Probe ds={ds} q={query('a')} />);
    rerender(<Probe ds={ds} q={query('b')} />);
    await act(async () => calls[0]?.reject(new DOMException('aborted', 'AbortError')));
    expect(text()).toBe('loading:-');
  });

  test('progress is shown while loading and failures carry their message', async () => {
    const { ds, calls } = scripted();
    render(<Probe ds={ds} q={query('a')} />);
    await act(async () => calls[0]?.onProgress?.(3, 9));
    expect(text()).toBe('loading:3');
    await act(async () => calls[0]?.reject(new Error('data/chunks/spans/000003.js: failed')));
    expect(text()).toBe('error:data/chunks/spans/000003.js: failed');
  });

  test('scanAll re-runs the same query with scanAll set', async () => {
    const { ds, calls } = scripted();
    render(<Probe ds={ds} q={query('a')} />);
    await act(async () => calls[0]?.resolve(resultOf(1)));
    await act(async () => screen.getByRole('button', { name: 'scan' }).click());
    expect(calls).toHaveLength(2);
    expect(calls[1]?.q).toEqual(query('a', true));
  });
});
