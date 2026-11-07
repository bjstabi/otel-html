import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FacetCounts } from '../../src/rollups/facets.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { SpanQuery, SpanQueryResult } from '../../src/viewer/data/results.js';
import { useSpanQuery } from '../../src/viewer/traces/use-span-query.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const query = (text: string): SpanQuery => ({
  condition: null,
  text,
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 10,
  groupBy: null,
  measureBy: null,
  needs: ['rows'],
  facetKeys: null,
});

const resultOf = (total: number): SpanQueryResult => ({
  rows: [],
  total,
  facets: new FacetCounts(10, 10),
  buckets: new TimeBuckets(['ok', 'error', 'unset'], 8),
  red: null,
  durations: { summary: null, bins: [] },
  groups: null,
  residual: false,
  tables: { resources: [], scopes: [] },
});

interface Call {
  q: SpanQuery;
  signal: AbortSignal | undefined;
  resolve(r: SpanQueryResult): void;
  reject(e: unknown): void;
}

/** A data source whose queries stay pending until the test settles them, in any order. */
function scripted(): { ds: DataSource; calls: Call[] } {
  const calls: Call[] = [];
  const ds = {
    querySpans: (q: SpanQuery, signal?: AbortSignal) =>
      new Promise<SpanQueryResult>((resolve, reject) => {
        calls.push({ q, signal, resolve, reject });
      }),
  } as unknown as DataSource;
  return { ds, calls };
}

function Probe(props: { ds: DataSource; q: SpanQuery }): React.JSX.Element {
  const { state } = useSpanQuery(props.ds, props.q);
  return (
    <div>
      <output data-testid="s">
        {state.status === 'ready'
          ? `ready:${state.result.total}`
          : state.status === 'error'
            ? `error:${state.message}`
            : `loading:${state.previous?.total ?? '-'}`}
      </output>
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

  test('failures carry their message', async () => {
    const { ds, calls } = scripted();
    render(<Probe ds={ds} q={query('a')} />);
    await act(async () => calls[0]?.reject(new Error('the engine stopped')));
    expect(text()).toBe('error:the engine stopped');
  });

  test('the previous result stays available while the next query runs', async () => {
    const { ds, calls } = scripted();
    const { rerender } = render(<Probe ds={ds} q={query('a')} />);
    await act(async () => calls[0]?.resolve(resultOf(4)));
    rerender(<Probe ds={ds} q={query('b')} />);
    expect(text()).toBe('loading:4');
  });

  test('the data source gets the query and a signal, and nothing else', async () => {
    const { ds, calls } = scripted();
    const querySpans = vi.spyOn(ds, 'querySpans');
    render(<Probe ds={ds} q={query('a')} />);
    expect(querySpans).toHaveBeenCalledTimes(1);
    expect(querySpans.mock.calls[0]).toHaveLength(2);
    expect(querySpans.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(calls).toHaveLength(1);
  });
});
