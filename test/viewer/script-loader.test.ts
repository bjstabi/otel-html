import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { installRegistry } from '../../src/viewer/data/registry.js';
import { createDomScriptLoader, SCRIPT_TIMEOUT_MS } from '../../src/viewer/data/script-loader.js';

function setup() {
  window.__OH__ = {
    q: [],
    push(k, p) {
      this.q.push([k, p]);
    },
  };
  const loader = createDomScriptLoader(document, installRegistry(window));
  const script = (): HTMLScriptElement => {
    const s = document.querySelector('script');
    if (s === null) throw new Error('no script injected');
    return s;
  };
  return { loader, script };
}

async function rejection(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected rejection');
}

beforeEach(() => {
  document.head.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createDomScriptLoader', () => {
  test('injects a classic script and resolves with the registered payload', async () => {
    const { loader, script } = setup();
    const p = loader.load('data/chunks/spans/000000.js', 'chunks/spans/000000');
    const injected = script();
    expect(injected.getAttribute('src')).toBe('data/chunks/spans/000000.js');
    expect(injected.type).toBe('');
    window.__OH__?.push('chunks/spans/000000', { n: 1 });
    await Promise.resolve(); // the browser fires `load` as a later task
    injected.dispatchEvent(new Event('load'));
    expect(await p).toEqual({ n: 1 });
  });

  test('removes its script element once the load settles, on success and on failure', async () => {
    const { loader, script } = setup();
    const ok = loader.load('data/a.js', 'a');
    const injected = script();
    window.__OH__?.push('a', 1);
    await ok;
    injected.dispatchEvent(new Event('load'));
    expect(document.querySelectorAll('script')).toHaveLength(0);
    const bad = rejection(loader.load('data/b.js', 'b'));
    script().dispatchEvent(new Event('error'));
    await bad;
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });

  test('a payload pushed by an earlier, timed-out load is not taken by the next load of the key', async () => {
    vi.useFakeTimers();
    const { loader } = setup();
    const first = rejection(loader.load('data/manifest.js?r=1', 'manifest'));
    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);
    await first;
    window.__OH__?.push('manifest', { old: true }); // the late script of the first load
    // the late payload had no waiter: it was kept, and the next load must not take it
    const second = loader.load('data/manifest.js?r=2', 'manifest');
    window.__OH__?.push('manifest', { fresh: true });
    expect(await second).toEqual({ fresh: true });
  });

  test('a load error rejects with invalid-report naming the path', async () => {
    const { loader, script } = setup();
    const p = rejection(loader.load('data/x.js', 'x'));
    script().dispatchEvent(new Event('error'));
    const e = await p;
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain('data/x.js');
  });

  test('a script that runs without registering rejects', async () => {
    const { loader, script } = setup();
    const p = rejection(loader.load('data/x.js', 'x'));
    script().dispatchEvent(new Event('load'));
    expect((await p).message).toContain('did not register "x"');
  });

  test('no registration within the timeout rejects', async () => {
    vi.useFakeTimers();
    const { loader } = setup();
    const p = rejection(loader.load('data/slow.js', 'slow'));
    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);
    const e = await p;
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain('data/slow.js');
  });
});
