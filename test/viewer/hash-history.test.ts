import { describe, expect, test, vi } from 'vitest';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';

describe('createHashHistory', () => {
  test('reads the query of the hash route and writes it back keeping the route', () => {
    window.location.hash = '#/traces?a=1';
    const h = createHashHistory(window);
    expect(h.read()).toBe('a=1');
    h.write('b=2', 'replace');
    expect(window.location.hash).toBe('#/traces?b=2');
    const before = window.history.length;
    h.write('c=3', 'push');
    expect(window.location.hash).toBe('#/traces?c=3');
    expect(window.history.length).toBe(before + 1);
    h.write('', 'replace');
    expect(window.location.hash).toBe('#/traces');
    window.location.hash = '';
    expect(h.read()).toBe('');
  });

  test('subscribe fires on hashchange and unsubscribes cleanly', () => {
    const h = createHashHistory(window);
    const cb = vi.fn();
    const off = h.subscribe(cb);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
