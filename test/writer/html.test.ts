import { describe, expect, test } from 'vitest';
import { engineAssetNames } from '../../src/format/engine.js';
import { renderIndexHtml } from '../../src/writer/html.js';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';
import { spansRequest } from './helpers.js';

const entry = { script: 'assets/viewer.abc123.js', style: 'assets/viewer.abc123.css' };

describe('renderIndexHtml', () => {
  test("format 'site' starts the four engine downloads before the manifest script", () => {
    const html = renderIndexHtml(entry, 't', { format: 'site' });
    const block = html.match(/<script>__OH__\.pre=[\s\S]*?<\/script>/)?.[0] ?? '';
    for (const name of engineAssetNames('site')) expect(block).toContain(`"assets/${name}"`);
    expect(html.indexOf('__OH__.pre')).toBeGreaterThan(html.indexOf('window.__OH__={q:[]'));
    expect(html.indexOf('__OH__.pre')).toBeLessThan(html.indexOf('src="data/manifest.js"'));
    expect(block).toContain('arrayBuffer()');
    expect(block).toContain('.catch(');
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
