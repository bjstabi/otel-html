import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runCli } from '../../../src/cli/program.js';
import { createTestWriter } from '../../../test-support/writer-deps.js';

function fakeIo(env: Record<string, string | undefined> = {}): {
  io: Parameters<typeof runCli>[1];
  out: () => string;
  err: () => string;
} {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
      env,
      cwd: '/work',
      signals: { on: () => () => undefined },
      spawn,
    },
    out: () => out,
    err: () => err,
  };
}

const deps = createTestWriter().deps;
const REPORT = ['--repository', 'o/r', '--artifacts', 'a', '--out', 'o'];

describe('otel-html ci report arguments', () => {
  test('without --run-id is a usage error', async () => {
    const f = fakeIo();
    expect(await runCli(['ci', 'report', ...REPORT], f.io, deps)).toBe(2);
    expect(f.err()).toContain('--run-id');
  });
  test.each([
    ['x', 'not a positive integer'],
    ['0', 'not a positive integer'],
    ['7.5', 'not a positive integer'],
  ])('--run-id %s is rejected', async (id, message) => {
    const f = fakeIo();
    expect(await runCli(['ci', 'report', '--run-id', id, ...REPORT], f.io, deps)).toBe(2);
    expect(f.err()).toContain(message);
  });
  test('--repository must be owner/repo', async () => {
    const f = fakeIo();
    const argv = ['ci', 'report', '--run-id', '7', '--repository', 'nope', '--artifacts', 'a', '--out', 'o'];
    expect(await runCli(argv, f.io, deps)).toBe(2);
    expect(f.err()).toContain('not owner/repo');
  });
});

describe('otel-html ci context', () => {
  let dir: string;
  let prevCwd: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-context-'));
    prevCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const githubEnv = (envFile: string): Record<string, string> => ({
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_WORKFLOW: 'ci',
    GITHUB_REF_NAME: 'main',
    GITHUB_SHA: 'abc123',
    GITHUB_JOB: 'build',
    RUNNER_NAME: 'runner-1',
    GITHUB_TOKEN: 'x',
    GITHUB_API_URL: 'http://127.0.0.1:9',
    GITHUB_ENV: envFile,
  });

  test('with no API writes a name-hashed TRACEPARENT to GITHUB_ENV', async () => {
    const envFile = join(dir, 'github-env');
    writeFileSync(envFile, '');
    const f = fakeIo(githubEnv(envFile));
    expect(await runCli(['ci', 'context'], f.io, deps)).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toMatch(/^TRACEPARENT=00-[0-9a-f]{32}-[0-9a-f]{16}-01$/m);
    expect(f.out()).toContain('::warning::');
  });

  test('--job-name sets the display name used for the span id', async () => {
    const envFile = join(dir, 'github-env');
    writeFileSync(envFile, '');
    const f = fakeIo(githubEnv(envFile));
    expect(await runCli(['ci', 'context', '--job-name', 'unit (a)'], f.io, deps)).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toContain('OTEL_SERVICE_NAME=ci/unit (a)');
  });

  test('a missing GITHUB_* variable is a warning, not a failure', async () => {
    const f = fakeIo({});
    expect(await runCli(['ci', 'context'], f.io, deps)).toBe(0);
    expect(f.out()).toContain('::warning::otel-html context: GITHUB_REPOSITORY is not set');
  });
});
