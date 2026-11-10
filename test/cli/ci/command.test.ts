import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createReportWith } from '../../../src/api/report.js';
import { runCli } from '../../../src/cli/program.js';
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

  const report = async (extra: string[], env: Record<string, string | undefined> = {}): Promise<string> => {
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
    const f = fakeIo({ GITHUB_STEP_SUMMARY: summary, ...env });
    expect(await runCli([...argv, '--out', join(dir, 'out'), ...extra], f.io, realFsDeps)).toBe(0);
    expect(f.out()).toContain('Report: see the `ci-run-report` artifact');
    return readFileSync(summary, 'utf8');
  };

  test('writes the summary table to the job summary', async () => {
    expect(await report([])).toContain('Report: see the `ci-run-report` artifact');
  });

  test('OTEL_HTML_REPORT_URL is ignored', async () => {
    const text = await report([], { OTEL_HTML_REPORT_URL: 'https://x.test/r' });
    expect(text).toContain('Report: see the `ci-run-report` artifact');
    expect(text).not.toContain('https://x.test/r');
  });

  test('--no-summary leaves the job summary to `ci link`', async () => {
    expect(await report(['--no-summary'])).toBe('');
  });

  test('writes a local report, so the downloaded artifact opens from file://', async () => {
    await report([]);
    const manifest = readFileSync(join(dir, 'out', 'data', 'manifest.js'), 'utf8');
    expect(manifest).toContain('"format":"local"');
    const names = readdirSync(join(dir, 'out', 'assets'));
    expect(names.some((n) => n.endsWith('.b64.js'))).toBe(true);
    expect(names).not.toContain('duckdb.1.32.0.wasm');
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

  test('an ambiguous job asks for OTEL_HTML_JOB_NAME only when it is unset', async () => {
    const envFile = join(dir, 'github-env');
    writeFileSync(envFile, '');
    const unset = fakeIo(githubEnv(envFile));
    expect(await runCli(['ci', 'context'], unset.io, deps)).toBe(0);
    expect(unset.out()).toContain(
      'could not tell which job this is; using name:build@runner-1 for its span id.',
    );
    expect(unset.out()).toContain('set OTEL_HTML_JOB_NAME (or --job-name)');
    const set = fakeIo(githubEnv(envFile));
    expect(await runCli(['ci', 'context', '--job-name', 'unit'], set.io, deps)).toBe(0);
    expect(set.out()).toContain('using name:unit@runner-1 for its span id.');
    expect(set.out()).not.toContain('OTEL_HTML_JOB_NAME');
  });

  test('without a token the warning names the name-based span id', async () => {
    const envFile = join(dir, 'github-env');
    writeFileSync(envFile, '');
    const f = fakeIo({ ...githubEnv(envFile), GITHUB_TOKEN: '' });
    expect(await runCli(['ci', 'context'], f.io, deps)).toBe(0);
    expect(f.out()).toContain('GITHUB_TOKEN is not set; deriving the span id from the job name and runner');
  });

  test('a missing GITHUB_* variable is a warning, not a failure', async () => {
    const f = fakeIo({});
    expect(await runCli(['ci', 'context'], f.io, deps)).toBe(0);
    expect(f.out()).toContain('::warning::otel-html context: GITHUB_REPOSITORY is not set');
  });
});

/** A two-span report at `out`. */
async function smallReport(out: string, prefix = 'b'): Promise<void> {
  const w = await createReportWith({ out }, realFsDeps);
  await w.addSpans(
    traceRequest(
      [1, 2].map((n) => span({ spanId: `00000000000000${prefix}${n}`, name: `run-${prefix}${n}` })),
      [],
    ),
  );
  await w.close();
}

const INDEX_URL = 'https://x.test/b/index.json';

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
      if (url === INDEX_URL)
        return new Response(readFileSync(join(dir, 'index.json'), 'utf8'), { status: 200 });
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
    '--index-url',
    INDEX_URL,
    ...extra,
  ];
  const writes = (): string[] => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`);

  test('without --index-url is a usage error', async () => {
    const f = fakeIo();
    const args = linkArgs().filter((a, i, all) => a !== '--index-url' && all[i - 1] !== '--index-url');
    expect(await runCli(args, f.io, deps)).toBe(2);
    expect(f.err()).toContain('--index-url');
  });

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
    expect(patch.body).toContain('All runs on pull request #7: https://x.test/b/pr/7/');
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

  describe('--index-url', () => {
    const indexArgs = (): string[] => linkArgs(['--no-check']);
    const withIndex = (respond: () => Response): void => {
      stub();
      const inner = globalThis.fetch;
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
        url === INDEX_URL ? respond() : inner(url, init),
      );
    };
    const indexJson = JSON.stringify({
      version: 1,
      channels: {
        'pr/7': {
          kind: 'pr',
          title: '#7 Fix',
          headBranch: 'topic',
          runs: [
            {
              runId: 5,
              attempt: 1,
              conclusion: 'success',
              headSha: 'x',
              headBranch: 'topic',
              completedAt: '2026-01-01T00:00:00Z',
              runUrl: 'u',
              reportPath: 'pr/7/runs/5',
              workflow: 'ci',
            },
          ],
        },
      },
    });

    test('links the channel page and the previous run although the index does not list this run', async () => {
      withIndex(() => new Response(indexJson, { status: 200 }));
      expect(await runCli(indexArgs(), fakeIo().io, deps)).toBe(0);
      const patch = calls.find((c) => c.method === 'PATCH')?.body as { body: string };
      expect(patch.body).toContain('All runs on pull request #7: https://x.test/b/pr/7/');
      expect(patch.body).toContain('Previous run: [ci run 5](https://x.test/b/pr/7/runs/5/)');
    });

    test('prefers the previous run of the same workflow by its raw name', async () => {
      const run = (id: number, workflow: string): object => ({
        ...JSON.parse(indexJson).channels['pr/7'].runs[0],
        runId: id,
        reportPath: `pr/7/runs/${id}`,
        workflow,
      });
      const named = JSON.stringify({
        version: 1,
        channels: {
          'pr/7': {
            kind: 'pr',
            title: '#7 Fix',
            headBranch: 'topic',
            runs: [run(5, 'CI'), run(4, 'Load test')],
          },
        },
      });
      stub();
      const inner = globalThis.fetch;
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (url === INDEX_URL) return new Response(named, { status: 200 });
        const res = await inner(url, init);
        if (!/\/actions\/runs\/6$/.test(url)) return res;
        return new Response(JSON.stringify({ ...((await res.json()) as object), name: 'Load test' }), {
          status: 200,
        });
      });
      expect(await runCli(indexArgs(), fakeIo().io, deps)).toBe(0);
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/7/comments'))?.body as {
        body: string;
      };
      expect(post.body).toContain('Previous run: [Load test run 4]');
    });

    test('a failed fetch is a warning and no previous-run line; the channel page stays', async () => {
      withIndex(() => new Response('gone', { status: 503 }));
      const f = fakeIo();
      expect(await runCli(indexArgs(), f.io, deps)).toBe(0);
      const patch = calls.find((c) => c.method === 'PATCH')?.body as { body: string };
      expect(patch.body).not.toContain('Previous run');
      expect(patch.body).toContain('All runs on pull request #7: https://x.test/b/pr/7/');
      expect(f.out()).toContain('::warning::');
    });
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

describe('otel-html ci deploy apply --channel', () => {
  test.each(['../x', 'branch/../x', 'branch/Main', 'pr/0', 'pr/5/x', 'x'])(
    '%s is a usage error',
    async (channel) => {
      const f = fakeIo({ GITHUB_RUN_ID: '1' });
      const code = await runCli(
        ['ci', 'deploy', 'apply', '--site', 's', '--updates', 'u', '--trust-updates', '--channel', channel],
        f.io,
        deps,
      );
      expect(code).not.toBe(0);
      expect(f.err() + f.out()).toContain('--channel must be');
    },
  );
});
