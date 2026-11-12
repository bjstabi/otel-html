import { describe, expect, test } from 'vitest';
import { SMALL_FILE_BYTES, smallFiles } from '../../src/viewer/data/engine/small-files.js';

function setup(sizes: Record<string, number>, concurrency?: number) {
  const fetched: string[] = [];
  const swapped: string[] = [];
  const fail = new Set<string>();
  const fresh: boolean[] = [];
  /** body lengths to answer with, one per call; the manifest's size once the list is empty */
  const lengths = new Map<string, number[]>();
  const gates = new Map<string, () => void>();
  let hold = false;
  let active = 0;
  let peak = 0;
  const s = smallFiles({
    bytesOf: (p) => sizes[p],
    async fetchWhole(p, isFresh) {
      fetched.push(p);
      fresh.push(isFresh === true);
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (hold) await new Promise<void>((resolve) => gates.set(p, resolve));
        if (fail.has(p)) throw new Error('boom');
        return new Uint8Array(lengths.get(p)?.shift() ?? sizes[p] ?? 1);
      } finally {
        active -= 1;
      }
    },
    async swap(p) {
      swapped.push(p);
    },
    ...(concurrency === undefined ? {} : { concurrency }),
  });
  return {
    s,
    fetched,
    swapped,
    fresh,
    lengths,
    fail,
    gates,
    peak: () => peak,
    holdAll: () => {
      hold = true;
    },
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('smallFiles', () => {
  test('a file of exactly the limit is fetched whole; one byte more is not', async () => {
    const t = setup({ a: SMALL_FILE_BYTES, b: SMALL_FILE_BYTES + 1 });
    await t.s.prepare(['a', 'b', 'unlisted']);
    expect(t.fetched).toEqual(['a']);
    expect(t.swapped).toEqual(['a']);
  });

  test('two prepares that share a file fetch it once', async () => {
    const t = setup({ a: 1, b: 1, c: 1 });
    await Promise.all([t.s.prepare(['a', 'b']), t.s.prepare(['b', 'c'])]);
    expect([...t.fetched].sort()).toEqual(['a', 'b', 'c']);
  });

  test('a prepared file is not fetched again', async () => {
    const t = setup({ a: 1 });
    await t.s.prepare(['a']);
    await t.s.prepare(['a']);
    expect(t.fetched).toEqual(['a']);
  });

  test('a failed fetch resolves, swaps nothing, and is retried by the next prepare', async () => {
    const t = setup({ a: 1 });
    t.fail.add('a');
    await expect(t.s.prepare(['a'])).resolves.toBeUndefined();
    expect(t.swapped).toEqual([]);
    t.fail.clear();
    await t.s.prepare(['a']);
    expect(t.swapped).toEqual(['a']);
  });

  test('one caller aborting does not fail another caller waiting on the same file', async () => {
    const t = setup({ a: 1 });
    t.holdAll();
    const ac = new AbortController();
    const first = t.s.prepare(['a'], ac.signal);
    const second = t.s.prepare(['a']);
    await tick();
    ac.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    t.gates.get('a')?.();
    await expect(second).resolves.toBeUndefined();
    expect(t.swapped).toEqual(['a']);
    expect(t.fetched).toEqual(['a']);
  });

  test('an aborted prepare rejects with AbortError and leaves the file retryable', async () => {
    const t = setup({ a: 1 });
    const done = new AbortController();
    done.abort();
    await expect(t.s.prepare(['a'], done.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(t.fetched).toEqual([]);
    t.holdAll();
    const ac = new AbortController();
    const p = t.s.prepare(['a'], ac.signal);
    await tick();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    t.gates.get('a')?.();
    await tick();
    await t.s.prepare(['a']);
    expect(t.swapped).toEqual(['a']);
  });

  test('no more than `concurrency` fetches run at once', async () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const t = setup(Object.fromEntries(names.map((n) => [n, 1])), 2);
    t.holdAll();
    const p = t.s.prepare(names);
    await tick();
    expect(t.fetched.length).toBe(2);
    for (let i = 0; i < names.length; i++) {
      for (const g of [...t.gates.values()]) g();
      t.gates.clear();
      await tick();
    }
    await p;
    expect(t.fetched.length).toBe(5);
    expect(t.peak()).toBe(2);
  });

  test('forget makes the next prepare fetch and swap again', async () => {
    const t = setup({ a: 1 });
    await t.s.prepare(['a']);
    t.s.forget(['a']);
    await t.s.prepare(['a']);
    expect(t.fetched).toEqual(['a', 'a']);
    expect(t.swapped).toEqual(['a', 'a']);
  });

  test('a body that differs from the manifest size is fetched once more past the cache and then swapped', async () => {
    const t = setup({ a: 10 });
    t.lengths.set('a', [7]);
    await t.s.prepare(['a']);
    expect(t.fetched).toEqual(['a', 'a']);
    expect(t.fresh).toEqual([false, true]);
    expect(t.swapped).toEqual(['a']);
  });

  test('a body that still differs swaps nothing and the file is retried by the next prepare', async () => {
    const t = setup({ a: 10 });
    t.lengths.set('a', [7, 7]);
    await expect(t.s.prepare(['a'])).resolves.toBeUndefined();
    expect(t.fetched).toEqual(['a', 'a']);
    expect(t.swapped).toEqual([]);
    await t.s.prepare(['a']);
    expect(t.swapped).toEqual(['a']);
  });

  test('a swap that finds its path forgotten while it waited is told so', async () => {
    const seen: boolean[] = [];
    let release: () => void = () => undefined;
    const s = smallFiles({
      bytesOf: () => 1,
      fetchWhole: async () => new Uint8Array(1),
      swap: async (_p, _b, isCurrent) => {
        await new Promise<void>((r) => (release = r));
        seen.push(isCurrent());
      },
    });
    const p = s.prepare(['a']);
    await tick();
    s.forget(['a']);
    release();
    await p;
    expect(seen).toEqual([false]);
  });
});
