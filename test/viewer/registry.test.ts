import { describe, expect, test } from 'vitest';
import { installRegistry } from '../../src/viewer/data/registry.js';

/** The inline bootstrap index.html runs before any data script. */
function withBootstrap(): Window {
  window.__OH__ = {
    q: [],
    push(k, p) {
      this.q.push([k, p]);
    },
  };
  return window;
}

describe('installRegistry', () => {
  test('pushes made before install are drained', async () => {
    const win = withBootstrap();
    win.__OH__?.push('manifest', { title: 't' });
    win.__OH__?.push('a', 1);
    const registry = installRegistry(win);
    expect(await registry.take('manifest')).toEqual({ title: 't' });
    expect(await registry.take('a')).toBe(1);
  });

  test('discard forgets a payload nobody waited for', async () => {
    const win = withBootstrap();
    const registry = installRegistry(win);
    win.__OH__?.push('manifest', { old: true });
    registry.discard('manifest');
    const next = registry.take('manifest');
    win.__OH__?.push('manifest', { fresh: true });
    expect(await next).toEqual({ fresh: true });
  });

  test('an aborted take stops waiting: a push after it is kept, not handed to the abandoned wait', async () => {
    const win = withBootstrap();
    const registry = installRegistry(win);
    const abandoned = new AbortController();
    let abandonedResolved = false;
    void registry.take('manifest', abandoned.signal).then(() => {
      abandonedResolved = true;
    });
    abandoned.abort();
    win.__OH__?.push('manifest', { late: true });
    await Promise.resolve();
    expect(abandonedResolved).toBe(false);
    expect(registry.takeStatic('manifest', 'data/manifest.js')).toEqual({ late: true });
  });

  test('take resolves for pushes made later, and push after install reaches waiters', async () => {
    const win = withBootstrap();
    const registry = installRegistry(win);
    const pending = registry.take('chunks/spans/000000');
    win.__OH__?.push('chunks/spans/000000', [1, 2]);
    expect(await pending).toEqual([1, 2]);
  });

  test('a taken payload is consumed', async () => {
    const win = withBootstrap();
    const registry = installRegistry(win);
    win.__OH__?.push('k', 'v');
    expect(await registry.take('k')).toBe('v');
    const next = registry.take('k');
    win.__OH__?.push('k', 'w');
    expect(await next).toBe('w');
  });

  test('installing without the bootstrap fails with a precise message', () => {
    const win = window as Window;
    delete win.__OH__;
    expect(() => installRegistry(win)).toThrow(/__OH__/);
  });
});

describe('takeStatic', () => {
  test('returns a payload pushed by an earlier static script, once', () => {
    const win = withBootstrap();
    win.__OH__?.push('manifest', { title: 't' });
    const registry = installRegistry(win);
    expect(registry.takeStatic('manifest', 'data/manifest.js')).toEqual({ title: 't' });
    expect(() => registry.takeStatic('manifest', 'data/manifest.js')).toThrow(/data\/manifest\.js/);
  });

  test('a static script that never registered fails fast naming the file, instead of waiting forever', () => {
    const registry = installRegistry(withBootstrap());
    expect(() => registry.takeStatic('manifest', 'data/manifest.js')).toThrow(
      expect.objectContaining({
        code: 'invalid-report',
        message: expect.stringContaining('data/manifest.js'),
      }),
    );
  });
});
