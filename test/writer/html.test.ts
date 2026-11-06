import { describe, expect, test } from 'vitest';
import { renderIndexHtml } from '../../src/writer/html.js';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';
import { spansRequest } from './helpers.js';

const entry = { script: 'assets/viewer.abc123.js', style: 'assets/viewer.abc123.css' };

describe('renderIndexHtml', () => {
  test('the default base is the report own assets/', () => {
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
    expect(() => renderIndexHtml(entry, 't', { assetsBase: 'https://x/assets/' })).toThrow();
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

  test('the chunk session output is unchanged', async () => {
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
