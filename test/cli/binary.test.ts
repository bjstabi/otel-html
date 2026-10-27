import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };

// Runs only against a compiled binary: `OTEL_HTML_BINARY=dist/bin/otel-html-<target> vitest run test/cli/binary.test.ts`.
// A path that does not exist fails loudly instead of skipping.
const BINARY_ENV = 'OTEL_HTML_BINARY';
const binaryEnv = process.env[BINARY_ENV];
const exec = promisify(execFile);

interface Run {
  stdout: string;
  stderr: string;
}

async function run(binary: string, args: readonly string[]): Promise<Run> {
  const { stdout, stderr } = await exec(binary, [...args], { encoding: 'utf8', timeout: 60_000 });
  return { stdout, stderr };
}

// int64 fields near and beyond 2^53 (and nanosecond timestamps) must survive JSON.parse source access under Bun.
// Written as text: a JS number literal above 2^53 would already be rounded before it reached the binary.
const INT64_REQUEST =
  '{"resourceSpans":[{"resource":{},"scopeSpans":[{"scope":{},"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b174","name":"big","kind":2,"startTimeUnixNano":1700000000000000001,"endTimeUnixNano":"1700000000000000999","attributes":[{"key":"big","value":{"intValue":9007199254740993}}]}]}]}]}';

describe.skipIf(binaryEnv === undefined)('compiled binary', () => {
  const binary = resolve(binaryEnv ?? '');
  let dir = '';

  beforeAll(async () => {
    expect(existsSync(binary), `OTEL_HTML_BINARY does not exist: ${binary}`).toBe(true);
    dir = await mkdtemp(join(tmpdir(), 'otel-html-binary-'));
  });
  afterAll(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  test('--version prints the package version', async () => {
    const { stdout } = await run(binary, ['--version']);
    expect(stdout.trim()).toBe(pkg.version);
  });

  test('converts the small fixture and ships the viewer byte-identical to dist/viewer', async () => {
    const out = join(dir, 'small');
    const { stdout } = await run(binary, ['convert', 'fixtures/small.otlp.json', '--out', out]);
    expect(stdout).toContain('wrote');
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    const names = await readdir(join(out, 'assets'));
    const scripts = names.filter((n) => /^viewer\.[A-Za-z0-9_-]+\.js$/.test(n));
    expect(scripts).toHaveLength(1);
    const script = scripts[0] ?? '';
    const [got, want] = await Promise.all([
      readFile(join(out, 'assets', script)),
      readFile(join('dist', 'viewer', 'assets', script)),
    ]);
    expect(got.equals(want)).toBe(true);
    for (const n of names.filter((x) => x.endsWith('.css'))) {
      const [a, b] = await Promise.all([
        readFile(join(out, 'assets', n)),
        readFile(join('dist', 'viewer', 'assets', n)),
      ]);
      expect(a.equals(b)).toBe(true);
    }
  });

  test('int64 values keep full precision (JSON.parse source access works under Bun)', async () => {
    const input = join(dir, 'big.otlp.json');
    const out = join(dir, 'big');
    await writeFile(input, INT64_REQUEST);
    await run(binary, ['convert', input, '--out', out]);
    const chunk = await readFile(join(out, 'data', 'chunks', 'spans', '000000.js'), 'utf8');
    expect(chunk).toContain('"9007199254740993"');
    expect(chunk).toContain('[998]');
  });
});
