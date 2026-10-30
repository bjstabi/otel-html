import { describe, expect, test } from 'vitest';
import { Lru } from '../../src/viewer/data/chunk-window.js';

describe('Lru', () => {
  test('drops the least recently used value past its size; a hit refreshes', async () => {
    const lru = new Lru<number, { n: number }>(2);
    let loads = 0;
    const load = (n: number) => () => {
      loads++;
      return Promise.resolve({ n });
    };
    await lru.get(1, load(1));
    await lru.get(2, load(2));
    await lru.get(1, load(1)); // 1 is now the most recent
    await lru.get(3, load(3)); // evicts 2
    expect(loads).toBe(3);
    await lru.get(1, load(1));
    expect(loads).toBe(3);
    await lru.get(2, load(2));
    expect(loads).toBe(4);
  });

  test('concurrent requests share one load, and a failed load caches nothing', async () => {
    const lru = new Lru<string, { v: string }>(4);
    let loads = 0;
    const slow = () => {
      loads++;
      return new Promise<{ v: string }>((r) => setTimeout(() => r({ v: 'x' }), 1));
    };
    const [a, b] = await Promise.all([lru.get('k', slow), lru.get('k', slow)]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
    await expect(lru.get('bad', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    let retried = 0;
    await lru.get('bad', () => {
      retried++;
      return Promise.resolve({ v: 'ok' });
    });
    expect(retried).toBe(1);
  });
});
