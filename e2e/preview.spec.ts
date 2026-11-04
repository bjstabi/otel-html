import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportDir } from './fixture.js';
import { expect, test } from './test.js';

const SCRIPT = fileURLToPath(new URL('../.github/actions/otel-html-publish/preview.mjs', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

function runPreview(dir: string) {
  return spawnSync('node', [SCRIPT, dir], {
    env: { ...process.env, PLAYWRIGHT_FROM: PACKAGE_JSON },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

/** The width and height in a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test.describe('preview.mjs', () => {
  let dir: string;
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'otel-html-preview-'));
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('writes a light and a dark 2560x1440 screenshot of the report', () => {
    cpSync(fileURLToPath(reportDir('dashboards')), dir, { recursive: true });
    const result = runPreview(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('::warning::');
    for (const scheme of ['light', 'dark']) {
      expect(pngSize(join(dir, `preview-${scheme}.png`))).toEqual({ width: 2560, height: 1440 });
    }
    expect(
      readFileSync(join(dir, 'preview-light.png')).equals(readFileSync(join(dir, 'preview-dark.png'))),
    ).toBe(false);
  });

  test('warns and writes nothing when the report has no index.html', () => {
    const result = runPreview(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::otel-html preview:');
    expect(existsSync(join(dir, 'preview-light.png'))).toBe(false);
    expect(existsSync(join(dir, 'preview-dark.png'))).toBe(false);
  });
});
