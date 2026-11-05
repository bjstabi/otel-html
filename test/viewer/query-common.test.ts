import { describe, expect, test, vi } from 'vitest';
import { EAGER_BLOCK, visitInBlocks, yieldToEvents } from '../../src/viewer/data/query-common.js';

describe('yieldToEvents', () => {
  test('resolves on a later task, not in the microtask queue', async () => {
    let done = false;
    const p = yieldToEvents().then(() => {
      done = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(done).toBe(false);
    await p;
    expect(done).toBe(true);
  });

  test('without MessageChannel it falls back to a timer that runs after one queued before it', async () => {
    vi.stubGlobal('MessageChannel', undefined);
    try {
      const order: string[] = [];
      setTimeout(() => order.push('timer'), 0);
      await yieldToEvents();
      order.push('yield');
      expect(order).toEqual(['timer', 'yield']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('visitInBlocks', () => {
  test('visits every entry in order when not aborted', async () => {
    const seen: number[] = [];
    await visitInBlocks(
      Array.from({ length: EAGER_BLOCK + 3 }, (_, i) => i),
      { visit: (e) => seen.push(e) },
      undefined,
    );
    expect(seen).toHaveLength(EAGER_BLOCK + 3);
    expect(seen.at(-1)).toBe(EAGER_BLOCK + 2);
  });
});
