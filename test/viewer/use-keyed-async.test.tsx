import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';
import { type KeyedState, useKeyedAsync } from '../../src/viewer/state/use-keyed-async.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred {
  key: string;
  resolve(v: string): void;
  reject(e: unknown): void;
  signal: AbortSignal;
}

function Probe(props: {
  k: string | null;
  load(key: string, signal: AbortSignal): Promise<string>;
  onState(s: KeyedState<string>): void;
}): null {
  props.onState(useKeyedAsync(props.k, props.load));
  return null;
}

function setup(): {
  render(key: string | null): Promise<void>;
  calls: Deferred[];
  state(): KeyedState<string>;
} {
  const calls: Deferred[] = [];
  let latest: KeyedState<string> = { status: 'loading' };
  const load = (key: string, signal: AbortSignal): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      calls.push({ key, resolve, reject, signal });
    });
  const root: Root = createRoot(document.createElement('div'));
  roots.push(root);
  return {
    render: (key) =>
      act(async () => root.render(<Probe k={key} load={load} onState={(v) => (latest = v)} />)),
    calls,
    state: () => latest,
  };
}

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => {
    for (const r of roots.splice(0)) r.unmount();
  });
});

describe('useKeyedAsync', () => {
  test('is loading, then ready with the value', async () => {
    const h = setup();
    await h.render('a');
    expect(h.state()).toEqual({ status: 'loading' });
    await act(async () => h.calls[0]?.resolve('A'));
    expect(h.state()).toEqual({ status: 'ready', value: 'A' });
  });

  test('surfaces a rejection as an error message', async () => {
    const h = setup();
    await h.render('a');
    await act(async () => h.calls[0]?.reject(new Error('boom')));
    expect(h.state()).toEqual({ status: 'error', message: 'boom' });
  });

  test('a key change resets to loading and drops the stale result', async () => {
    const h = setup();
    await h.render('a');
    await act(async () => h.calls[0]?.resolve('A'));
    await h.render('b');
    expect(h.state()).toEqual({ status: 'loading' });
    expect(h.calls[0]?.signal.aborted).toBe(true);
    // The first load settles late: it must not replace the second key's state.
    await act(async () => h.calls[0]?.resolve('A-late'));
    expect(h.state()).toEqual({ status: 'loading' });
    await act(async () => h.calls[1]?.resolve('B'));
    expect(h.state()).toEqual({ status: 'ready', value: 'B' });
  });

  test('a stale rejection is dropped too', async () => {
    const h = setup();
    await h.render('a');
    await h.render('b');
    await act(async () => h.calls[0]?.reject(new Error('late')));
    expect(h.state()).toEqual({ status: 'loading' });
  });

  test('a null key stays loading and starts no load', async () => {
    const h = setup();
    await h.render(null);
    expect(h.calls).toHaveLength(0);
    expect(h.state()).toEqual({ status: 'loading' });
  });
});
