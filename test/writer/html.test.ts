import { runInNewContext } from 'node:vm';
import { describe, expect, test, vi } from 'vitest';
import { engineAssetNames } from '../../src/format/engine.js';
import { enginePrefetchScript, renderIndexHtml } from '../../src/writer/html.js';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';
import { spansRequest } from './helpers.js';

const entry = { script: 'assets/viewer.abc123.js', style: 'assets/viewer.abc123.css' };

describe('renderIndexHtml', () => {
  test("format 'site' embeds the prefetch script before the manifest script", () => {
    const html = renderIndexHtml(entry, 't', { format: 'site' });
    const hrefs = engineAssetNames('site').map((n) => `assets/${n}`);
    expect(html).toContain(`<script>${enginePrefetchScript(hrefs, 'oh-engine-1.32.0')}</script>\n`);
    for (const h of hrefs) expect(html).toContain(JSON.stringify(h));
    expect(html).toContain('"oh-engine-1.32.0"');
    expect(html.indexOf('__OH__.pre')).toBeGreaterThan(html.indexOf('window.__OH__={q:[]'));
    expect(html.indexOf('__OH__.pre')).toBeLessThan(html.indexOf('src="data/manifest.js"'));
  });
  test('a shared base prefixes the engine hrefs', () => {
    expect(renderIndexHtml(entry, 't', { assetsBase: '../../assets/', format: 'site' })).toContain(
      '"../../assets/duckdb.1.32.0.wasm"',
    );
  });
  test("format 'local' and no format write no prefetch", () => {
    expect(renderIndexHtml(entry, 't', { format: 'local' })).toBe(renderIndexHtml(entry, 't'));
    expect(renderIndexHtml(entry, 't')).not.toContain('__OH__.pre');
  });
  test('host names the query endpoint in a meta tag before the title; without it there is none', () => {
    const html = renderIndexHtml(entry, 't', { host: 'query' });
    expect(html.match(/<meta name="otel-html-host" content="query">/g)).toHaveLength(1);
    expect(html.indexOf('otel-html-host')).toBeLessThan(html.indexOf('<title>'));
    expect(html.indexOf('name="viewport"')).toBeLessThan(html.indexOf('otel-html-host'));
    expect(renderIndexHtml(entry, 't')).not.toContain('otel-html-host');
    expect(renderIndexHtml(entry, 't', { host: 'a"b' })).toContain('content="a&quot;b"');
  });

  test("the default base is the report's own assets/", () => {
    const html = renderIndexHtml(entry, 't');
    expect(html).toContain('<script src="assets/viewer.abc123.js"></script>');
    expect(html).toContain('href="assets/viewer.abc123.css"');
    expect(renderIndexHtml(entry, 't', {})).toBe(html);
    expect(renderIndexHtml(entry, 't', { assetsBase: 'assets/' })).toBe(html);
  });

  test('a shared base moves the script and style; the manifest stays relative to the report', () => {
    const html = renderIndexHtml(entry, 't', { assetsBase: '../../assets/0.3.0/' });
    expect(html).toContain('<script src="../../assets/0.3.0/viewer.abc123.js"></script>');
    expect(html).toContain('href="../../assets/0.3.0/viewer.abc123.css"');
    expect(html).toContain('<script src="data/manifest.js"></script>');
  });

  test('a base that is not a layout path is refused', () => {
    expect(() => renderIndexHtml(entry, 't', { assetsBase: 'https://x/assets/' })).toThrowError(
      expect.objectContaining({ code: 'invalid-report' }),
    );
  });
});

describe('the shell a session writes', () => {
  const run = async (config: ReturnType<typeof testConfig>) => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config, mode: 'replace' });
    await s.add(otlp(spansRequest(1)), 'a.json');
    await s.close();
    return w.fs.snapshot();
  };

  test('the default (local) session output is the shared index.html', async () => {
    const files = await run(testConfig());
    expect(files.get('r/index.html')).toBe(renderIndexHtml(entry, 'otel-html report'));
  });

  test('a format-4 session with the default base writes assets/ and references them', async () => {
    const files = await run(testConfig({ writer: { format: 'site' } }));
    expect(files.get('r/index.html')).toContain('src="assets/viewer.abc123.js"');
    expect(files.has('r/assets/viewer.abc123.js')).toBe(true);
  });

  test('a shared base is referenced and the report writes no assets/ of its own', async () => {
    const files = await run(testConfig({ writer: { format: 'site', assetsBase: '../../assets/0.3.0/' } }));
    expect(files.get('r/index.html')).toContain('src="../../assets/0.3.0/viewer.abc123.js"');
    expect([...files.keys()].some((k) => k.startsWith('r/assets/'))).toBe(false);
  });
});

type Oh = {
  pre: Record<string, Promise<ArrayBuffer>>;
  store: () => Promise<void>;
  drop: () => Promise<void>;
};
function run(script: string, env: { caches?: unknown; fetch: unknown }): Oh {
  const ctx = { __OH__: { q: [], push() {} } as Partial<Oh>, Promise, Error, ...env };
  runInNewContext(script, ctx);
  return ctx.__OH__ as Oh;
}
const WASM = 'assets/duckdb.1.32.0.wasm';
const WORKER = 'assets/duckdb.1.32.0.worker.js';
const HREFS = [WASM, WORKER];
const body = (n: number) => new Response(new Uint8Array([n]));
const script = () => enginePrefetchScript(HREFS, 'oh-engine-1.32.0');
function fakes() {
  const cache = { match: vi.fn(), put: vi.fn(async () => undefined) };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ['oh-engine-0.0.0', 'oh-engine-1.32.0', 'other']),
    delete: vi.fn(async () => true),
  };
  return { cache, caches };
}

describe('enginePrefetchScript', () => {
  test('a hit resolves from the cache without a fetch', async () => {
    const { cache, caches } = fakes();
    cache.match.mockImplementation(async (h: string) => (h === WASM ? body(7) : undefined));
    const fetch = vi.fn(async () => body(9));
    const oh = run(script(), { caches, fetch });
    expect([...new Uint8Array((await oh.pre[WASM]) as ArrayBuffer)]).toEqual([7]);
    await oh.pre[WORKER];
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(WORKER);
    expect(cache.match).toHaveBeenCalledWith(WASM, { ignoreVary: true });
  });
  test('a miss is fetched and stored by store()', async () => {
    const { cache, caches } = fakes();
    cache.match.mockResolvedValue(undefined);
    const oh = run(script(), { caches, fetch: vi.fn(async () => body(9)) });
    await Promise.all(HREFS.map((h) => oh.pre[h]));
    expect(cache.put).not.toHaveBeenCalled();
    await oh.store();
    expect(cache.put).toHaveBeenCalledTimes(2);
    for (const call of cache.put.mock.calls) {
      const [href, res] = call as unknown as [string, unknown];
      expect(HREFS).toContain(href);
      expect(res).toBeInstanceOf(Response);
    }
    expect(caches.delete).toHaveBeenCalledTimes(1);
    expect(caches.delete).toHaveBeenCalledWith('oh-engine-0.0.0');
    await oh.store();
    expect(cache.put).toHaveBeenCalledTimes(2);
  });
  test('a non-OK miss rejects naming the status', async () => {
    const { cache, caches } = fakes();
    cache.match.mockResolvedValue(undefined);
    const oh = run(script(), { caches, fetch: vi.fn(async () => new Response(null, { status: 404 })) });
    await expect(oh.pre[WASM]).rejects.toThrow('HTTP 404');
    await oh.store();
    expect(cache.put).not.toHaveBeenCalled();
  });
  test('no caches: fetch only, store and drop resolve', async () => {
    const oh = run(script(), { fetch: vi.fn(async () => body(5)) });
    expect([...new Uint8Array((await oh.pre[WASM]) as ArrayBuffer)]).toEqual([5]);
    await expect(oh.store()).resolves.toBeUndefined();
    await expect(oh.drop()).resolves.toBeUndefined();
  });
  test('a cache that cannot open, match or put is a miss and never fails', async () => {
    const a = fakes();
    a.caches.open.mockRejectedValue(new Error('no'));
    const oa = run(script(), { caches: a.caches, fetch: vi.fn(async () => body(1)) });
    await oa.pre[WASM];
    await expect(oa.store()).resolves.toBeUndefined();

    const b = fakes();
    b.cache.match.mockRejectedValue(new Error('no'));
    const ob = run(script(), { caches: b.caches, fetch: vi.fn(async () => body(2)) });
    expect([...new Uint8Array((await ob.pre[WASM]) as ArrayBuffer)]).toEqual([2]);

    const c = fakes();
    c.cache.match.mockResolvedValue(undefined);
    c.cache.put.mockRejectedValue(new Error('no'));
    const oc = run(script(), { caches: c.caches, fetch: vi.fn(async () => body(3)) });
    await oc.pre[WASM];
    await expect(oc.store()).resolves.toBeUndefined();
  });
  test("drop() deletes this version's cache", async () => {
    const { cache, caches } = fakes();
    cache.match.mockResolvedValue(undefined);
    const oh = run(script(), { caches, fetch: vi.fn(async () => body(1)) });
    await oh.drop();
    expect(caches.delete).toHaveBeenCalledWith('oh-engine-1.32.0');
    caches.delete.mockRejectedValue(new Error('no'));
    await expect(oh.drop()).resolves.toBeUndefined();
  });
});
