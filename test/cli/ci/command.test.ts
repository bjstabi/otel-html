import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Report } from '../../../src/api/report.js';
import { runCli } from '../../../src/cli/program.js';
import { reviveDataJson, unwrapDataFile } from '../../../src/format/data-file.js';
import { parseManifest } from '../../../src/format/manifest.js';
import { MANIFEST_KEY } from '../../../src/format/paths.js';
import { createNodeFileSystem } from '../../../src/writer/node-fs.js';
import { span, traceRequest } from '../../../test-support/otlp-builders.js';
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
// merges read and write real report folders
const realFsDeps = { ...deps, fs: createNodeFileSystem() };
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

describe('otel-html ci report with no job reports', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-report-empty-'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  test('announces it, writes nothing and sets published=false', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const body = url.includes('/jobs')
        ? { jobs: [] }
        : {
            id: 7,
            run_attempt: 1,
            name: 'load',
            conclusion: 'skipped',
            updated_at: '2026-01-01T00:00:00Z',
            html_url: 'https://github.com/o/r/actions/runs/7',
            head_branch: 'main',
            head_sha: 'sha7',
            repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
            head_repository: { full_name: 'o/r' },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const outputs = join(dir, 'github-output');
    const out = join(dir, 'out');
    const artifacts = join(dir, 'artifacts');
    mkdirSync(artifacts);
    const f = fakeIo({ GITHUB_OUTPUT: outputs });
    const argv = [
      'ci',
      'report',
      '--run-id',
      '7',
      '--repository',
      'o/r',
      '--artifacts',
      artifacts,
      '--out',
      out,
    ];
    expect(await runCli(argv, f.io, realFsDeps)).toBe(0);
    expect(f.out()).toContain('::notice::otel-html report: run 7 has no job reports; nothing to publish');
    expect(readFileSync(outputs, 'utf8')).toBe('published=false\n');
    expect(existsSync(out)).toBe(false);
  });
});

describe('otel-html ci report step summary', { timeout: 60_000 }, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-report-summary-'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const report = async (extra: string[]): Promise<string> => {
    vi.stubGlobal('fetch', async (url: string) => {
      const body = url.includes('/jobs')
        ? { jobs: [] }
        : {
            id: 8,
            run_attempt: 1,
            name: 'ci',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            // around the job report's spans (test-support T0)
            created_at: '2023-11-14T22:13:00Z',
            run_started_at: '2023-11-14T22:13:01Z',
            updated_at: '2023-11-14T22:14:00Z',
            html_url: 'https://github.com/o/r/actions/runs/8',
            head_branch: 'main',
            head_sha: 'sha8',
            repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
            head_repository: { full_name: 'o/r' },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const artifacts = join(dir, 'artifacts');
    await smallReport(join(artifacts, 'otel-html-build', 'report'));
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const argv = ['ci', 'report', '--run-id', '8', '--repository', 'o/r', '--artifacts', artifacts];
    const f = fakeIo({ GITHUB_STEP_SUMMARY: summary });
    expect(await runCli([...argv, '--out', join(dir, 'out'), ...extra], f.io, realFsDeps)).toBe(0);
    expect(f.out()).toContain('Report: see the `ci-run-report` artifact');
    return readFileSync(summary, 'utf8');
  };

  test('writes the summary table to the job summary', async () => {
    expect(await report([])).toContain('Report: see the `ci-run-report` artifact');
  });

  test('--no-summary leaves the job summary to `ci link`', async () => {
    expect(await report(['--no-summary'])).toBe('');
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

/** A two-span report at `out`: enough to place and merge, and light enough that the rolling merges stay quick. */
async function smallReport(out: string, prefix = 'b'): Promise<void> {
  const w = await Report.create({ out }, realFsDeps);
  await w.addSpans(
    traceRequest(
      [1, 2].map((n) => span({ spanId: `00000000000000${prefix}${n}`, name: `run-${prefix}${n}` })),
      [],
    ),
  );
  await w.close();
}

// Real-fs rolling merges: well under a second locally, but a loaded CI runner has taken more than the 5 s default.
describe('otel-html ci site and cleanup', { timeout: 60_000 }, () => {
  let dir: string;
  let site: string;
  let report: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ci-site-'));
    site = join(dir, 'site');
    report = join(dir, 'report');
    await smallReport(report);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const runBody = (id: number, branch = 'main', name = 'ci'): object => ({
    id,
    run_attempt: 1,
    name,
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

  test('places a default-branch run, rebuilds the rolling branch report and applies retention', async () => {
    stubApi({ 42: runBody(42), 43: runBody(43) });
    const out = join(dir, 'gh-output');
    writeFileSync(out, '');
    const f = fakeIo({ GITHUB_OUTPUT: out });
    expect(await runCli(siteArgs(42), f.io, realFsDeps)).toBe(0);
    expect(existsSync(join(site, 'branch/main/runs/42/data/manifest.js'))).toBe(true);
    expect(existsSync(join(site, 'branch/main/data/manifest.js'))).toBe(true);
    expect(f.out()).toContain('report-url=https://x.test/otel-html/branch/main/runs/42/');
    expect(readFileSync(out, 'utf8')).toContain('channel=branch/main\n');
    expect(readFileSync(out, 'utf8')).toContain('published=true\n');

    expect(await runCli(siteArgs(43, ['--retention', '1']), fakeIo().io, realFsDeps)).toBe(0);
    expect(existsSync(join(site, 'branch/main/runs/42'))).toBe(false);
    expect(existsSync(join(site, 'branch/main/runs/43/data/manifest.js'))).toBe(true);
    expect(existsSync(join(site, 'branch/main/data/manifest.js'))).toBe(true);
    expect(readFileSync(join(site, 'index.html'), 'utf8')).toContain('href="branch/main/"');
  });

  const totalsOf = (dirPath: string): { spans: number; logs: number; metrics: number } => {
    const text = readFileSync(join(dirPath, 'data/manifest.js'), 'utf8');
    const manifest = parseManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
    const sum = { spans: 0, logs: 0, metrics: 0 };
    for (const c of manifest.chunks) sum[c.signal] += c.count;
    return sum;
  };
  const withReport = (args: string[], to: string): string[] => args.map((a) => (a === report ? to : a));

  test('the branch channel is one rolling report over its retained runs, and runs/ survives rebuilds', async () => {
    stubApi({ 60: runBody(60), 61: runBody(61), 62: runBody(62) });
    expect(await runCli(siteArgs(60), fakeIo().io, realFsDeps)).toBe(0);
    const second = join(dir, 'report-2');
    await smallReport(second, 'a');
    expect(await runCli(withReport(siteArgs(61), second), fakeIo().io, realFsDeps)).toBe(0);
    const ch = join(site, 'branch/main');
    const first = totalsOf(report);
    const rolling = totalsOf(ch);
    expect(totalsOf(second).spans).toBe(2);
    expect(rolling.spans).toBe(first.spans + 2);
    expect(rolling.metrics).toBe(first.metrics);
    expect(existsSync(join(ch, 'runs/60/data/manifest.js'))).toBe(true);
    expect(existsSync(join(ch, 'runs/61/data/manifest.js'))).toBe(true);
    expect(existsSync(join(ch, 'index.html'))).toBe(true);

    // a retained run that is no longer a report is skipped with a warning; the rest still merge
    rmSync(join(ch, 'runs/60'), { recursive: true });
    mkdirSync(join(ch, 'runs/60'));
    writeFileSync(join(ch, 'runs/60/data'), 'garbage');
    const g = fakeIo();
    expect(await runCli(siteArgs(62), g.io, realFsDeps)).toBe(0);
    expect(g.out()).toContain('::warning::otel-html report: skipping');
    expect(totalsOf(ch).spans).toBe(2 + first.spans);
    expect(existsSync(join(ch, 'runs/62/data/manifest.js'))).toBe(true);
  });

  test('a rolling merge that fails with nothing to blame warns and leaves the redirect stub', async () => {
    stubApi({ 70: runBody(70) });
    const f = fakeIo();
    expect(await runCli(siteArgs(70, ['--config', join(dir, 'missing.yaml')]), f.io, realFsDeps)).toBe(0);
    expect(f.out()).toContain('::warning::otel-html site: rolling report of branch/main not rebuilt');
    expect(readFileSync(join(site, 'branch/main/index.html'), 'utf8')).toContain('url=runs/70/');
    expect(existsSync(join(site, 'branch/main/runs/70/data/manifest.js'))).toBe(true);
  });

  test('a run on neither the default branch nor an open pull request is not published', async () => {
    stubApi({ 44: runBody(44, 'feature') });
    const f = fakeIo();
    expect(await runCli(siteArgs(44), f.io, deps)).toBe(0);
    expect(f.out()).toContain('::notice::otel-html site: run 44 (feature) has no open pull request');
    expect(f.out()).toContain('published=false');
    expect(existsSync(site)).toBe(false);
  });

  test('a default-branch run is not taken by a fork pull from a branch of the same name', async () => {
    stubApi({ 60: runBody(60) }, [
      {
        number: 9,
        title: 'Fork',
        state: 'open',
        head: { sha: 'zzz', ref: 'main', repo: { full_name: 'fork/r' } },
      },
    ]);
    expect(await runCli(siteArgs(60), fakeIo().io, deps)).toBe(0);
    expect(existsSync(join(site, 'branch/main/runs/60/data/manifest.js'))).toBe(true);
    expect(existsSync(join(site, 'pr'))).toBe(false);
  });

  test('an unreadable run is an ::error:: and exit 1', async () => {
    stubApi({});
    const f = fakeIo();
    expect(await runCli(siteArgs(45), f.io, deps)).toBe(1);
    expect(f.out()).toContain('::error::otel-html site:');
  });

  const topicPull = {
    number: 7,
    title: 'Fix',
    state: 'open',
    head: { sha: 'sha50', ref: 'feat/topic', repo: { full_name: 'o/r' } },
  };

  test("a pull request's runs of every workflow share one rolling report at pr/<n>", async () => {
    stubApi({ 50: runBody(50, 'feat/topic'), 51: runBody(51, 'feat/topic', 'load') }, [topicPull]);
    const out = join(dir, 'gh-output');
    writeFileSync(out, '');
    const f = fakeIo({ GITHUB_OUTPUT: out });
    expect(await runCli(siteArgs(50), f.io, realFsDeps)).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('channel=pr/7\n');
    expect(f.out()).toContain('report-url=https://x.test/otel-html/pr/7/runs/50/');
    const second = join(dir, 'report-2');
    await smallReport(second, 'a');
    expect(await runCli(withReport(siteArgs(51), second), fakeIo().io, realFsDeps)).toBe(0);

    const ch = join(site, 'pr/7');
    expect(totalsOf(ch).spans).toBe(totalsOf(report).spans + 2);
    expect(existsSync(join(ch, 'runs/50/data/manifest.js'))).toBe(true);
    expect(existsSync(join(ch, 'runs/51/data/manifest.js'))).toBe(true);
    const index = JSON.parse(readFileSync(join(site, 'index.json'), 'utf8'));
    expect(index.channels['pr/7']).toMatchObject({
      kind: 'pr',
      title: '#7 Fix',
      headBranch: 'feat/topic',
      headRepo: 'o/r',
    });
    expect(index.channels['pr/7'].runs.map((r: { workflow: string }) => r.workflow)).toEqual(['load', 'ci']);
    const landing = readFileSync(join(site, 'index.html'), 'utf8');
    expect(landing).toContain('href="pr/7/"');
    expect(landing).toContain('feat/topic');
  });

  test('a pull request channel keeps 10 runs per workflow by default', async () => {
    const entry = (id: number, workflow: string): object => ({
      runId: id,
      attempt: 1,
      conclusion: 'success',
      headSha: 'x',
      headBranch: 'feat/topic',
      completedAt: `2025-01-01T00:00:${String(id).padStart(2, '0')}Z`,
      runUrl: 'u',
      reportPath: `pr/7/runs/${id}`,
      workflow,
    });
    // ten ci runs (1-10) and one load run (11), newest first
    const runs = [entry(11, 'load'), ...Array.from({ length: 10 }, (_, i) => entry(10 - i, 'ci'))];
    mkdirSync(join(site, 'pr/7/runs/1'), { recursive: true });
    writeFileSync(
      join(site, 'index.json'),
      JSON.stringify({
        version: 1,
        channels: { 'pr/7': { kind: 'pr', title: '#7 Fix', headBranch: 'feat/topic', runs } },
      }),
    );
    stubApi({ 50: runBody(50, 'feat/topic') }, [topicPull]);
    expect(await runCli(siteArgs(50), fakeIo().io, deps)).toBe(0);
    const index = JSON.parse(readFileSync(join(site, 'index.json'), 'utf8'));
    const ids = index.channels['pr/7'].runs.map((r: { runId: number }) => r.runId);
    expect(ids).toHaveLength(11);
    expect(ids[0]).toBe(50);
    expect(ids).toContain(11);
    expect(ids).not.toContain(1);
    expect(existsSync(join(site, 'pr/7/runs/1'))).toBe(false);
  });

  test('the next publish drops the older per-workflow channels and their folders', async () => {
    const old = (key: string, id: number): object => ({
      kind: 'workflow',
      title: key,
      headBranch: 'main',
      runs: [
        {
          runId: id,
          attempt: 1,
          conclusion: 'success',
          headSha: 'x',
          headBranch: 'main',
          completedAt: '2025-01-01T00:00:00Z',
          runUrl: 'u',
          reportPath: `${key}/runs/${id}`,
        },
      ],
    });
    for (const key of ['ci', 'load']) mkdirSync(join(site, key, 'runs/1'), { recursive: true });
    writeFileSync(join(site, 'ci/index.html'), 'old rolling report');
    mkdirSync(join(site, 'pr/3/runs/9'), { recursive: true });
    const legacyPr = {
      kind: 'pr',
      title: '#3 Old',
      headBranch: 'old',
      runs: [
        {
          runId: 9,
          attempt: 1,
          conclusion: 'success',
          headSha: 'x',
          headBranch: 'old',
          completedAt: '2025-01-01T00:00:00Z',
          runUrl: 'u',
          reportPath: 'pr/3/runs/9',
        },
      ],
    };
    writeFileSync(
      join(site, 'index.json'),
      JSON.stringify({ version: 1, channels: { ci: old('ci', 1), load: old('load', 1), 'pr/3': legacyPr } }),
    );
    stubApi({ 42: runBody(42) });
    const f = fakeIo();
    expect(await runCli(siteArgs(42), f.io, deps)).toBe(0);
    expect(f.out()).toContain('removed the per-workflow channels ci, load');
    expect(existsSync(join(site, 'ci'))).toBe(false);
    expect(existsSync(join(site, 'load'))).toBe(false);
    expect(existsSync(join(site, 'pr/3/runs/9'))).toBe(true);
    const index = JSON.parse(readFileSync(join(site, 'index.json'), 'utf8'));
    expect(Object.keys(index.channels).sort()).toEqual(['branch/main', 'pr/3']);
    const landing = readFileSync(join(site, 'index.html'), 'utf8');
    expect(landing).not.toContain('href="ci/"');
    expect(landing).toContain('href="pr/3/"');
  });

  test('a channel of a kind this version does not know is skipped with a warning, not a failure', async () => {
    mkdirSync(site, { recursive: true });
    writeFileSync(
      join(site, 'index.json'),
      JSON.stringify({
        version: 1,
        channels: { 'tag/v1': { kind: 'tag', title: 'v1', headBranch: 'v1', runs: [] } },
      }),
    );
    stubApi({ 42: runBody(42) });
    const f = fakeIo();
    expect(await runCli(siteArgs(42), f.io, deps)).toBe(0);
    expect(f.out()).toContain('::warning::otel-html site: skipping channel tag/v1 of kind tag');
    const g = fakeIo();
    expect(
      await runCli(['ci', 'cleanup', '--site', site, '--pr', '1', '--repository', 'o/r'], g.io, deps),
    ).toBe(0);
  });

  test('a stub-era pr channel is rebuilt as a rolling report by its next run', async () => {
    stubApi({ 50: runBody(50, 'feat/topic') }, [topicPull]);
    // the stub-era layout: pr/7/index.html forwards to the newest run
    mkdirSync(join(site, 'pr/7'), { recursive: true });
    writeFileSync(join(site, 'pr/7/index.html'), '<meta http-equiv="refresh" content="0; url=runs/49/">');
    writeFileSync(
      join(site, 'index.json'),
      JSON.stringify({
        version: 1,
        channels: { 'pr/7': { kind: 'pr', title: '#7 Fix', headBranch: 'feat/topic', runs: [] } },
      }),
    );
    expect(await runCli(siteArgs(50), fakeIo().io, realFsDeps)).toBe(0);
    expect(existsSync(join(site, 'pr/7/data/manifest.js'))).toBe(true);
    expect(readFileSync(join(site, 'pr/7/index.html'), 'utf8')).not.toContain('url=runs/49/');
  });

  test('cleanup removes the pull request channel and folder; an unknown one is cleaned=false', async () => {
    stubApi({ 50: runBody(50, 'feat/topic') }, [topicPull]);
    expect(await runCli(siteArgs(50), fakeIo().io, deps)).toBe(0);
    expect(existsSync(join(site, 'pr/7/runs/50/data/manifest.js'))).toBe(true);

    const outputs = join(dir, 'gh-output');
    const cleanup = (pr: string): Promise<number> =>
      runCli(
        ['ci', 'cleanup', '--site', site, '--pr', pr, '--repository', 'o/r'],
        fakeIo({ GITHUB_OUTPUT: outputs }).io,
        deps,
      );
    expect(await cleanup('7')).toBe(0);
    expect(existsSync(join(site, 'pr/7'))).toBe(false);
    expect(readFileSync(join(site, 'index.json'), 'utf8')).not.toContain('pr/7');
    expect(readFileSync(outputs, 'utf8')).toBe('cleaned=true\n');

    // cleaning a pull request the site never had changes nothing and says so
    rmSync(outputs);
    const before = readFileSync(join(site, 'index.json'), 'utf8');
    const landing = statSync(join(site, 'index.html')).mtimeMs;
    expect(await cleanup('8')).toBe(0);
    expect(readFileSync(outputs, 'utf8')).toBe('cleaned=false\n');
    expect(readFileSync(join(site, 'index.json'), 'utf8')).toBe(before);
    expect(statSync(join(site, 'index.html')).mtimeMs).toBe(landing);

    // a folder left without an index entry is still removed
    mkdirSync(join(site, 'pr/9/runs/1'), { recursive: true });
    rmSync(outputs);
    expect(await cleanup('9')).toBe(0);
    expect(readFileSync(outputs, 'utf8')).toBe('cleaned=true\n');
    expect(existsSync(join(site, 'pr/9'))).toBe(false);
  });

  test('cleanup needs --repository or $GITHUB_REPOSITORY, and validates it', async () => {
    const f = fakeIo();
    expect(await runCli(['ci', 'cleanup', '--site', site, '--pr', '7'], f.io, deps)).toBe(2);
    expect(f.err()).toContain('--repository is required');
    const g = fakeIo({ GITHUB_REPOSITORY: 'nonsense' });
    expect(await runCli(['ci', 'cleanup', '--site', site, '--pr', '7'], g.io, deps)).toBe(2);
    expect(g.err()).toContain('--repository is not owner/repo');
    expect(
      await runCli(
        ['ci', 'cleanup', '--site', site, '--pr', '7'],
        fakeIo({ GITHUB_REPOSITORY: 'o/r' }).io,
        deps,
      ),
    ).toBe(0);
  });

  test.each(['--retention', '--pr-retention'])('%s must be a positive integer', async (flag) => {
    const f = fakeIo();
    expect(await runCli(siteArgs(42, [flag, '0']), f.io, deps)).toBe(2);
    expect(f.err()).toContain(`${flag} is not a positive integer`);
  });
});

describe('otel-html ci link', () => {
  let dir: string;
  let calls: { method: string; url: string; body?: unknown }[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-link-'));
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        version: 1,
        channels: {
          'pr/7': {
            kind: 'pr',
            title: '#7 Fix',
            headBranch: 'topic',
            runs: ['6', '5'].map((id) => ({
              runId: Number(id),
              attempt: 1,
              conclusion: 'success',
              headSha: 'sha6',
              headBranch: 'topic',
              completedAt: '2026-01-01T00:00:00Z',
              runUrl: 'u',
              reportPath: `pr/7/runs/${id}`,
            })),
          },
        },
      }),
    );
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const stub = (fail: (method: string, url: string) => boolean = () => false): void => {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
      });
      const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200 });
      if (fail(method, url)) return new Response('no', { status: 403 });
      if (method !== 'GET') return json({});
      if (/\/actions\/runs\/6$/.test(url))
        return json({
          id: 6,
          run_attempt: 1,
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          html_url: 'h',
          head_sha: 'sha6',
        });
      if (url.includes('/jobs')) return json({ jobs: [] });
      if (url.includes('/pulls'))
        return json([
          { number: 7, title: 'Fix', state: 'open', head: { sha: 'sha6', ref: 'topic' } },
          { number: 8, title: 'Old', state: 'closed', head: { sha: 'sha6', ref: 'topic' } },
          { number: 9, title: 'Moved', state: 'open', head: { sha: 'other', ref: 'topic' } },
        ]);
      if (url.includes('/issues/7/comments'))
        return json([
          { id: 1, body: 'unrelated', user: { login: 'someone', type: 'User' } },
          // a person quoting the marker comes before the bot's comment and is passed over
          { id: 3, body: '<!-- otel-html-report:ci -->\nquoted', user: { login: 'someone', type: 'User' } },
          {
            id: 2,
            body: '<!-- otel-html-report -->\nold',
            user: { login: 'github-actions[bot]', type: 'Bot' },
          },
        ]);
      if (url.endsWith('/repos/o/r')) return json({ default_branch: 'main' });
      return new Response('nope', { status: 404 });
    });
  };
  const linkArgs = (extra: string[] = []): string[] => [
    'ci',
    'link',
    '--run-id',
    '6',
    '--repository',
    'o/r',
    '--url',
    'https://x.test/b/pr/7/runs/6/',
    '--site',
    dir,
    ...extra,
  ];
  const writes = (): string[] => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`);

  test('patches the sticky comment of each open pull request of the sha and creates the check run', async () => {
    stub();
    const summary = join(dir, 'summary.md');
    const f = fakeIo({ GITHUB_STEP_SUMMARY: summary });
    expect(await runCli(linkArgs(), f.io, deps)).toBe(0);
    expect(writes()).toEqual([
      'PATCH https://api.github.com/repos/o/r/issues/comments/2',
      'POST https://api.github.com/repos/o/r/check-runs',
    ]);
    const patch = calls.find((c) => c.method === 'PATCH')?.body as { body: string };
    expect(patch.body).toContain('Previous run: [run 5](https://x.test/b/pr/7/runs/5/)');
    expect(calls.find((c) => c.url.endsWith('/check-runs'))?.body).toMatchObject({ conclusion: 'neutral' });
    expect(readFileSync(summary, 'utf8')).toContain('<!-- otel-html-report:ci -->');
  });

  test("links the pull request's rolling page and the previous run of the same workflow", async () => {
    const entry = (id: number, workflow: string): object => ({
      runId: id,
      attempt: 1,
      conclusion: 'success',
      headSha: 'sha6',
      headBranch: 'topic',
      completedAt: '2026-01-01T00:00:00Z',
      runUrl: 'u',
      reportPath: `pr/7/runs/${id}`,
      workflow,
    });
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        version: 1,
        channels: {
          'pr/7': {
            kind: 'pr',
            title: '#7 Fix',
            headBranch: 'topic',
            headRepo: 'o/r',
            runs: [entry(6, 'ci'), entry(5, 'load'), entry(4, 'ci')],
          },
        },
      }),
    );
    stub();
    expect(await runCli(linkArgs(['--no-check']), fakeIo().io, deps)).toBe(0);
    const patch = calls.find((c) => c.method === 'PATCH')?.body as { body: string };
    expect(patch.body).toContain('Report: https://x.test/b/pr/7/runs/6/');
    expect(patch.body).toContain('All runs on this pull request: https://x.test/b/pr/7/');
    expect(patch.body).toContain('Previous run: [ci run 4](https://x.test/b/pr/7/runs/4/)');
  });

  test('--no-comment leaves only the check run, and the step summary still gets the body', async () => {
    stub();
    const summary = join(dir, 'summary.md');
    expect(await runCli(linkArgs(['--no-comment']), fakeIo({ GITHUB_STEP_SUMMARY: summary }).io, deps)).toBe(
      0,
    );
    expect(writes()).toEqual(['POST https://api.github.com/repos/o/r/check-runs']);
    expect(readFileSync(summary, 'utf8')).toContain('Report: https://x.test/b/pr/7/runs/6/');
  });

  test('comments on a pull request whose head moved on since the run', async () => {
    stub();
    calls = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('/pulls'))
        return new Response(
          JSON.stringify([
            {
              number: 7,
              title: 'Fix',
              state: 'open',
              head: { sha: 'newer', ref: 'topic', repo: { full_name: 'o/r' } },
            },
          ]),
          { status: 200 },
        );
      if (/\/actions\/runs\/6$/.test(url))
        return new Response(
          JSON.stringify({
            id: 6,
            run_attempt: 1,
            name: 'ci',
            status: 'completed',
            head_branch: 'topic',
            head_sha: 'sha6',
            head_repository: { full_name: 'o/r' },
          }),
          { status: 200 },
        );
      if (url.includes('/jobs')) return new Response('{"jobs":[]}', { status: 200 });
      calls.push({ method: init?.method ?? 'GET', url });
      return new Response(url.includes('/comments') && !init?.method ? '[]' : '{}', { status: 200 });
    });
    expect(await runCli(linkArgs(['--no-check']), fakeIo().io, deps)).toBe(0);
    expect(writes()).toEqual(['POST https://api.github.com/repos/o/r/issues/7/comments']);
  });

  test('a default-branch run comments on no pull request, even one whose head is its commit', async () => {
    stub();
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      /\/actions\/runs\/6$/.test(url)
        ? new Response(
            JSON.stringify({
              id: 6,
              run_attempt: 1,
              name: 'ci',
              status: 'completed',
              head_branch: 'main',
              head_sha: 'sha6',
              repository: { full_name: 'o/r' },
              head_repository: { full_name: 'o/r' },
            }),
            { status: 200 },
          )
        : inner(url, init),
    );
    expect(await runCli(linkArgs(), fakeIo().io, deps)).toBe(0);
    expect(writes()).toEqual(['POST https://api.github.com/repos/o/r/check-runs']);
  });

  test('an unreadable default branch posts no comment and still creates the check run', async () => {
    stub((_m, url) => url.endsWith('/repos/o/r'));
    const f = fakeIo();
    expect(await runCli(linkArgs(), f.io, deps)).toBe(0);
    expect(f.out()).toContain('::warning::otel-html link: cannot read the default branch of o/r');
    expect(writes()).toEqual(['POST https://api.github.com/repos/o/r/check-runs']);
  });

  test('--no-check leaves only the comment', async () => {
    stub();
    expect(await runCli(linkArgs(['--no-check']), fakeIo().io, deps)).toBe(0);
    expect(writes()).toEqual(['PATCH https://api.github.com/repos/o/r/issues/comments/2']);
  });

  test('a failed write is a warning and exit 0, and the other write still happens', async () => {
    stub((method, url) => method === 'PATCH' && url.includes('/issues/comments/'));
    const f = fakeIo();
    expect(await runCli(linkArgs(), f.io, deps)).toBe(0);
    expect(f.out()).toContain('::warning::otel-html link: cannot comment on pull request #7');
    expect(writes()).toContain('POST https://api.github.com/repos/o/r/check-runs');
  });

  test('failed jobs and pulls fetches still create the check run', async () => {
    stub((_m, url) => url.includes('/jobs') || url.includes('/pulls'));
    const f = fakeIo();
    expect(await runCli(linkArgs(), f.io, deps)).toBe(0);
    expect(f.out()).toContain('::warning::otel-html link: cannot read the jobs of run 6');
    expect(f.out()).toContain('::warning::otel-html link: cannot list the pull requests');
    expect(writes()).toEqual(['POST https://api.github.com/repos/o/r/check-runs']);
  });

  test('an unreadable run is a warning and exit 0', async () => {
    stub((_m, url) => /\/actions\/runs\/6$/.test(url));
    const f = fakeIo();
    expect(await runCli(linkArgs(), f.io, deps)).toBe(0);
    expect(f.out()).toContain('::warning::otel-html link: cannot read run 6');
    expect(writes()).toEqual([]);
  });
});
