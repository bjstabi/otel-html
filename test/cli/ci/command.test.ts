import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

describe('otel-html ci site and cleanup', () => {
  let dir: string;
  let site: string;
  let report: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-site-'));
    site = join(dir, 'site');
    report = join(dir, 'report');
    cpSync(join(__dirname, '../../../fixtures/reports/format-2'), report, { recursive: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const runBody = (id: number, branch = 'main'): object => ({
    id,
    run_attempt: 1,
    name: 'ci',
    conclusion: 'success',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    head_branch: branch,
    head_sha: `sha${id}`,
    repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
    head_repository: { full_name: 'o/r' },
  });
  const stubApi = (runs: Record<number, object>, pulls: object[] = []): void => {
    vi.stubGlobal('fetch', async (url: string) => {
      const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200 });
      const m = /\/actions\/runs\/(\d+)$/.exec(url);
      if (m?.[1] !== undefined) return json(runs[Number(m[1])]);
      if (url.includes('/pulls')) return json(pulls);
      if (url.endsWith('/repos/o/r')) return json({ default_branch: 'main' });
      return new Response('nope', { status: 404 });
    });
  };
  const siteArgs = (id: number, extra: string[] = []): string[] => [
    'ci',
    'site',
    '--site',
    site,
    '--report',
    report,
    '--run-id',
    String(id),
    '--repository',
    'o/r',
    '--base-url',
    'https://x.test/otel-html',
    ...extra,
  ];

  test('places a default-branch run, stubs the channel and applies retention', async () => {
    stubApi({ 42: runBody(42), 43: runBody(43) });
    const out = join(dir, 'gh-output');
    writeFileSync(out, '');
    const f = fakeIo({ GITHUB_OUTPUT: out });
    expect(await runCli(siteArgs(42), f.io, deps)).toBe(0);
    expect(existsSync(join(site, 'ci/runs/42/data/manifest.js'))).toBe(true);
    expect(readFileSync(join(site, 'ci/index.html'), 'utf8')).toContain('url=runs/42/');
    expect(f.out()).toContain('report-url=https://x.test/otel-html/ci/runs/42/');
    expect(readFileSync(out, 'utf8')).toContain('channel=ci\n');
    expect(readFileSync(out, 'utf8')).toContain('published=true\n');

    expect(await runCli(siteArgs(43, ['--retention', '1']), fakeIo().io, deps)).toBe(0);
    expect(existsSync(join(site, 'ci/runs/42'))).toBe(false);
    expect(existsSync(join(site, 'ci/runs/43/data/manifest.js'))).toBe(true);
    expect(readFileSync(join(site, 'ci/index.html'), 'utf8')).toContain('url=runs/43/');
  });

  test('a run on neither the default branch nor an open pull request is not published', async () => {
    stubApi({ 44: runBody(44, 'feature') });
    const f = fakeIo();
    expect(await runCli(siteArgs(44), f.io, deps)).toBe(0);
    expect(f.out()).toContain('::notice::otel-html site: run 44 (feature) has no open pull request');
    expect(f.out()).toContain('published=false');
    expect(existsSync(site)).toBe(false);
  });

  test('an unreadable run is an ::error:: and exit 1', async () => {
    stubApi({});
    const f = fakeIo();
    expect(await runCli(siteArgs(45), f.io, deps)).toBe(1);
    expect(f.out()).toContain('::error::otel-html site:');
  });

  test('a PR channel is published for an open pull request and cleanup removes it', async () => {
    stubApi({ 50: runBody(50, 'topic') }, [
      { number: 7, title: 'Fix', state: 'open', head: { sha: 'sha50', ref: 'topic' } },
    ]);
    expect(await runCli(siteArgs(50), fakeIo().io, deps)).toBe(0);
    expect(existsSync(join(site, 'pr/7/runs/50/data/manifest.js'))).toBe(true);
    expect(readFileSync(join(site, 'pr/7/index.html'), 'utf8')).toContain('url=runs/50/');

    const f = fakeIo();
    expect(
      await runCli(['ci', 'cleanup', '--site', site, '--pr', '7', '--repository', 'o/r'], f.io, deps),
    ).toBe(0);
    expect(existsSync(join(site, 'pr/7'))).toBe(false);
    expect(readFileSync(join(site, 'index.json'), 'utf8')).not.toContain('pr/7');
    // cleaning a pull request the site never had is a no-op
    expect(
      await runCli(['ci', 'cleanup', '--site', site, '--pr', '8', '--repository', 'o/r'], fakeIo().io, deps),
    ).toBe(0);
  });

  test.each(['--retention', '--pr-retention'])('%s must be a positive integer', async (flag) => {
    const f = fakeIo();
    expect(await runCli(siteArgs(42, [flag, '0']), f.io, deps)).toBe(2);
    expect(f.err()).toContain(`${flag} is not a positive integer`);
  });
});
