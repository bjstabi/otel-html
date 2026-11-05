import { describe, expect, test } from 'vitest';
import { findConfigPath, loadConfigFile } from '../../src/config/load.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

describe('loadConfigFile', () => {
  test('parses YAML', async () => {
    const fs = createMemoryFileSystem();
    await fs.mkdirp('/c');
    await fs.writeTextAtomic('/c/otel-html.yaml', 'title: hi\nviewer:\n  theme: dark\n');
    expect(await loadConfigFile(fs, '/c/otel-html.yaml')).toEqual({ title: 'hi', viewer: { theme: 'dark' } });
  });

  test('parses JSON', async () => {
    const fs = createMemoryFileSystem();
    await fs.mkdirp('/c');
    await fs.writeTextAtomic('/c/x.json', '{"title":"j"}');
    expect(await loadConfigFile(fs, '/c/x.json')).toEqual({ title: 'j' });
  });

  test.each([
    ['empty', ''],
    ['comment-only', '# just a comment\n'],
  ])('an %s file is an empty config (#175)', async (_name, text) => {
    const fs = createMemoryFileSystem();
    await fs.mkdirp('/c');
    await fs.writeTextAtomic('/c/otel-html.yaml', text);
    const file = await loadConfigFile(fs, '/c/otel-html.yaml');
    expect(file).toEqual({});
    expect(resolveConfig({ file, env: {} }).config.title).toBe(resolveConfig({ env: {} }).config.title);
  });

  test('invalid YAML is invalid-config with path', async () => {
    const fs = createMemoryFileSystem();
    await fs.mkdirp('/c');
    await fs.writeTextAtomic('/c/bad.yaml', 'a: [1,\n');
    await expect(loadConfigFile(fs, '/c/bad.yaml')).rejects.toSatisfy(
      (e) => e instanceof OtelHtmlError && e.code === 'invalid-config' && e.message.includes('/c/bad.yaml'),
    );
  });

  test('missing file is invalid-config', async () => {
    const fs = createMemoryFileSystem();
    await expect(loadConfigFile(fs, '/nope.yaml')).rejects.toSatisfy(
      (e) => e instanceof OtelHtmlError && e.code === 'invalid-config',
    );
  });
});

describe('findConfigPath', () => {
  test('OTEL_HTML_CONFIG wins', async () => {
    const fs = createMemoryFileSystem();
    expect(await findConfigPath(fs, '/w', { OTEL_HTML_CONFIG: '/x.yaml' })).toBe('/x.yaml');
  });
  test('falls back to ./otel-html.yaml', async () => {
    const fs = createMemoryFileSystem();
    await fs.mkdirp('/w');
    await fs.writeTextAtomic('/w/otel-html.yaml', 'title: t\n');
    expect(await findConfigPath(fs, '/w', {})).toBe('/w/otel-html.yaml');
  });
  test('null when absent', async () => {
    expect(await findConfigPath(createMemoryFileSystem(), '/w', {})).toBeNull();
  });
});
