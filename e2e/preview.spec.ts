import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
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

/** How many distinct byte values the decompressed scanlines of a PNG hold: one for a blank image, many for a rendered page. */
function distinctPngBytes(file: string): number {
  const buf = readFileSync(file);
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    if (buf.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return new Set(inflateSync(Buffer.concat(idat))).size;
}

test.describe('preview.mjs', () => {
  let dir: string;
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'otel-html-preview-'));
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('writes a light and a dark 2560x1440 screenshot of the report', () => {
    // `sample` holds no metrics: the default dashboard of `dashboards` has metric widgets, whose error state until
    // plan 3 (D11) is an alert that preview.mjs reports.
    cpSync(fileURLToPath(reportDir('sample')), dir, { recursive: true });
    const result = runPreview(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('::warning::');
    for (const scheme of ['light', 'dark']) {
      expect(pngSize(join(dir, `preview-${scheme}.png`))).toEqual({ width: 2560, height: 1440 });
    }
    for (const scheme of ['light', 'dark']) {
      expect(distinctPngBytes(join(dir, `preview-${scheme}.png`))).toBeGreaterThan(16);
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

  test('warns and keeps the previous images when the report failed to load', () => {
    cpSync(fileURLToPath(reportDir('dashboards')), dir, { recursive: true });
    rmSync(join(dir, 'data', 'manifest.js'));
    for (const scheme of ['light', 'dark'])
      writeFileSync(join(dir, `preview-${scheme}.png`), `previous ${scheme}`);
    const result = runPreview(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::otel-html preview:');
    for (const scheme of ['light', 'dark']) {
      expect(readFileSync(join(dir, `preview-${scheme}.png`), 'utf8')).toBe(`previous ${scheme}`);
      expect(existsSync(join(dir, `preview-${scheme}.png.tmp`))).toBe(false);
    }
  });

  test('warns naming the failure and keeps the previous images when a partition file is missing', () => {
    cpSync(fileURLToPath(reportDir('sample')), dir, { recursive: true });
    rmSync(join(dir, 'data', 'partitions', '000000', 'spans.parquet.js'));
    for (const scheme of ['light', 'dark'])
      writeFileSync(join(dir, `preview-${scheme}.png`), `previous ${scheme}`);
    const result = runPreview(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::otel-html preview:');
    expect(result.stdout).toContain('spans.parquet.js');
    for (const scheme of ['light', 'dark']) {
      expect(readFileSync(join(dir, `preview-${scheme}.png`), 'utf8')).toBe(`previous ${scheme}`);
      expect(existsSync(join(dir, `preview-${scheme}.png.tmp`))).toBe(false);
    }
  });
});
