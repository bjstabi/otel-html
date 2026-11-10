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
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createReportWith, resolveDeps } from '../../../src/api/report.js';
import type { ApiJob, ApiRun } from '../../../src/cli/ci/github-api.js';
import { readLedger } from '../../../src/cli/ci/ledger.js';
import { readRunManifest } from '../../../src/cli/ci/run-report.js';
import { readUpdate, type UpdateJson } from '../../../src/cli/ci/update.js';
import { runUpdateDone, runUpdatePr, runUpdatePush, runUpdateRun } from '../../../src/cli/ci/update-main.js';
import type { CliIo } from '../../../src/cli/io.js';
import type { WriterDeps } from '../../../src/writer/session.js';
import { openTestDb } from '../../../test-support/duckdb-node.js';
import { fakeViewerAssets } from '../../../test-support/writer-deps.js';

const VERSION = '9.9.9';
let dir: string;
let deps: WriterDeps;
let out: string[];
const ioOf = (env: Record<string, string> = {}): CliIo =>
  ({
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => out.push(s),
    env: {
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_JOB: 'build',
      ...env,
    },
    cwd: dir,
  }) as unknown as CliIo;
type Outputs = Partial<
  Record<'name' | 'sequence' | 'partitions' | 'channel' | 'report-url' | 'published', string>
>;
const outputs = (): Outputs =>
  Object.fromEntries(
    out
      .join('')
      .split('\n')
      .filter((l) => /^[a-z-]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'update-main-'));
  out = [];
  deps = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: VERSION });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const logRequest = (n: number): object => ({
  resourceLogs: [
    {
      resource: { attributes: [] },
      scopeLogs: [
        {
          scope: {},
          logRecords: [
            { timeUnixNano: `170000000000000000${n}`, body: { stringValue: `m${n}` }, severityNumber: 9 },
          ],
        },
      ],
    },
  ],
});

/** `<dir>/.otel-html/report` with `flushes` partitions, `context.json` beside it. */
async function jobReport(
  flushes: number,
  o: { close?: boolean; context?: object } = {},
): Promise<{ report: string; publish: string; close: () => Promise<void> }> {
  const root = join(dir, '.otel-html');
  const report = join(root, 'report');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'context.json'), JSON.stringify(o.context ?? { jobId: 777, approximate: false }));
  const r = await createReportWith({ out: report, format: 'local', assetsBase: 'assets/' }, deps);
  for (let i = 1; i <= flushes; i++) {
    await r.addLogs(logRequest(i));
    await r.flush();
  }
  if (o.close === true) await r.close();
  return { report, publish: join(root, 'publish'), close: async () => void (await r.close()) };
}

const readJson = (p: string): UpdateJson => JSON.parse(readFileSync(p, 'utf8')) as UpdateJson;

const ago = (s: number): string => new Date(Date.now() - s * 1000).toISOString();
const apiRun: ApiRun = {
  id: 42,
  run_attempt: 1,
  name: 'ci',
  event: 'push',
  status: 'in_progress',
  conclusion: null,
  created_at: ago(60),
  run_started_at: ago(55),
  updated_at: ago(1),
  html_url: 'https://github.com/o/r/actions/runs/42',
  path: '.github/workflows/ci.yml',
  actor: { type: 'User' },
  head_branch: 'feat',
  head_sha: 'sha42',
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
  head_repository: { full_name: 'o/r' },
};
const apiJob: ApiJob = {
  id: 777,
  name: 'build (ubuntu)',
  status: 'in_progress',
  runner_name: 'r1',
  conclusion: null,
  created_at: ago(59),
  started_at: ago(50),
  completed_at: null,
  html_url: 'https://github.com/o/r/actions/runs/42/job/777',
  steps: [
    {
      number: 1,
      name: 'checkout',
      status: 'completed',
      conclusion: 'success',
      started_at: ago(49),
      completed_at: ago(40),
    },
    {
      number: 2,
      name: 'test',
      status: 'in_progress',
      conclusion: null,
      started_at: ago(39),
      completed_at: null,
    },
  ],
};
const api = async (url: string): Promise<Response> => {
  if (/\/actions\/runs\/42\/attempts\/1\/jobs/.test(url)) return Response.json({ jobs: [apiJob] });
  if (/\/actions\/runs\/42$/.test(url)) return Response.json(apiRun);
  if (url.includes('/commits/sha42/pulls'))
    return Response.json([
      {
        number: 5,
        title: 'Feat',
        state: 'open',
        head: { sha: 'sha42', ref: 'feat', repo: { full_name: 'o/r' } },
      },
    ]);
  if (/\/repos\/o\/r$/.test(url)) return Response.json({ default_branch: 'main' });
  return new Response('no', { status: 404 });
};

describe('runUpdatePush', () => {
  test('lists each flush partition as carried, under partitions/<i>/', async () => {
    const { report } = await jobReport(2);
    const updates = join(dir, 'updates');
    await runUpdatePush({ report, out: updates, final: false }, ioOf(), deps);
    const o = outputs();
    expect(o.name).toBe('otel-html-update-push-777-1');
    expect(o.sequence).toBe('1');
    expect(o.partitions).toBe('2');
    const folder = join(updates, 'otel-html-update-push-777-1');
    const u = await readUpdate(deps.fs, folder);
    expect(u.kind).toBe('push');
    expect(u.jobName).toBe('build');
    expect(u.partitions?.map((p) => [p.source, p.carried])).toEqual([
      ['job:777#flush:0', true],
      ['job:777#flush:1', true],
    ]);
    expect(existsSync(join(folder, 'partitions/0/logs.parquet'))).toBe(true);
    expect(existsSync(join(folder, 'partitions/1/logs.parquet'))).toBe(true);
    expect(u.ci).toBeUndefined();
    expect(out.join('')).toContain('::warning::');
    const ledger = await readLedger(deps.fs, join(dir, '.otel-html/publish'));
    expect(ledger.sequence).toBe(1);
  });

  test('a shipped source is listed carried: false and its files are absent', async () => {
    const { report, publish } = await jobReport(2);
    mkdirSync(publish, { recursive: true });
    writeFileSync(
      join(publish, 'uploads.json'),
      JSON.stringify({ sequence: 4, shipped: ['flush:0'], uploads: [] }),
    );
    const updates = join(dir, 'updates');
    await runUpdatePush({ report, out: updates, final: false }, ioOf(), deps);
    expect(outputs().name).toBe('otel-html-update-push-777-5');
    const folder = join(updates, 'otel-html-update-push-777-5');
    const u = await readUpdate(deps.fs, folder);
    expect(u.partitions?.map((p) => p.carried)).toEqual([false, true]);
    expect(existsSync(join(folder, 'partitions/0'))).toBe(false);
    expect(existsSync(join(folder, 'partitions/1/logs.parquet'))).toBe(true);
  });

  test('after close the listing is one compact source', async () => {
    const { report } = await jobReport(2, { close: true });
    const updates = join(dir, 'updates');
    await runUpdatePush({ report, out: updates, final: true }, ioOf(), deps);
    const u = await readUpdate(deps.fs, join(updates, 'otel-html-update-push-777-1'));
    expect(u.partitions?.map((p) => p.source)).toEqual(['job:777#compact:0..1']);
  });

  test('--final with a pid file of a dead pid proceeds, with sequence ledger.sequence + 1', async () => {
    const { report, publish } = await jobReport(1, { close: true });
    mkdirSync(publish, { recursive: true });
    writeFileSync(join(publish, 'pusher.pid'), '2147483646');
    writeFileSync(join(publish, 'uploads.json'), JSON.stringify({ sequence: 6, shipped: [], uploads: [] }));
    const updates = join(dir, 'updates');
    await runUpdatePush({ report, out: updates, final: true }, ioOf(), deps);
    expect(outputs().sequence).toBe('7');
    expect(existsSync(join(publish, 'pusher.stop'))).toBe(true);
    expect(existsSync(join(publish, 'pusher.pid'))).toBe(false);
  });

  test('no partitions yet: name is empty, nothing is written', async () => {
    const root = join(dir, '.otel-html');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'context.json'), JSON.stringify({ jobId: 777, approximate: false }));
    await runUpdatePush(
      { report: join(root, 'report'), out: join(dir, 'updates'), final: false },
      ioOf(),
      deps,
    );
    expect(outputs().name).toBe('');
  });

  test('a failure is a warning and an empty name', async () => {
    await runUpdatePush(
      { report: join(dir, 'nowhere/report'), out: join(dir, 'u'), final: false },
      ioOf(),
      deps,
    );
    expect(outputs().name).toBe('');
    expect(out.join('')).toContain('::warning::');
  });

  test('with a token: the API job name and a ci partition holding the provisional spans', async () => {
    const { report } = await jobReport(1);
    const updates = join(dir, 'updates');
    await runUpdatePush({ report, out: updates, final: false }, ioOf({ GITHUB_TOKEN: 't' }), deps, api);
    const folder = join(updates, 'otel-html-update-push-777-1');
    const u = await readUpdate(deps.fs, folder);
    expect(out.join('')).not.toContain('::warning::');
    expect(u.jobName).toBe('build (ubuntu)');
    expect(u.ci?.source).toBe('ci:777');
    expect(u.ci?.carried).toBe(true);
    expect(existsSync(join(folder, 'ci/spans.parquet'))).toBe(true);
    const db = await openTestDb();
    try {
      db.registerFile('ci.parquet', new Uint8Array(readFileSync(join(folder, 'ci/spans.parquet'))));
      const rows = db.rows("SELECT name FROM read_parquet('ci.parquet') ORDER BY name");
      // the provisional root, the job, its queued span and the one completed step
      expect(rows.map(({ name }) => name).sort()).toEqual(['build (ubuntu)', 'checkout', 'ci', 'queued']);
    } finally {
      db.close();
    }
  });

  test('without a token the job name is the hint', async () => {
    const { report } = await jobReport(1);
    await runUpdatePush(
      { report, out: join(dir, 'u'), final: false },
      ioOf({ OTEL_HTML_JOB_NAME: 'hinted' }),
      deps,
    );
    const u = readJson(join(dir, 'u/otel-html-update-push-777-1/update.json'));
    expect(u.jobName).toBe('hinted');
  });

  test('an approximate job id keys the update by its hash', async () => {
    const { report } = await jobReport(1, {
      context: { jobId: 'name:build@r1', approximate: true, jobName: 'build', runner: 'r1' },
    });
    await runUpdatePush({ report, out: join(dir, 'u'), final: false }, ioOf(), deps);
    expect(outputs().name).toMatch(/^otel-html-update-push-h[0-9a-f]{12}-1$/);
    await readUpdate(deps.fs, join(dir, 'u', outputs().name ?? ''));
  });
});

describe('runUpdateDone', () => {
  test('records the upload and its sources in the ledger', async () => {
    const { report, publish } = await jobReport(2);
    await runUpdatePush({ report, out: join(dir, 'u'), final: false }, ioOf(), deps);
    const name = outputs().name ?? '';
    out = [];
    await runUpdateDone({ name, publishDir: publish }, ioOf(), deps);
    const ledger = await readLedger(deps.fs, publish);
    expect(ledger.shipped).toEqual(['flush:0', 'flush:1']);
    expect(ledger.uploads.map((u) => [u.name, u.sequence, u.sources])).toEqual([
      [name, 1, ['flush:0', 'flush:1']],
    ]);
  });

  test('prints the pusher log as one notice', async () => {
    const publish = join(dir, 'publish');
    mkdirSync(publish, { recursive: true });
    const log = join(publish, 'pusher.log');
    writeFileSync(log, 'tick 1: upload failed: 503\ntick 2: upload failed: 503\n');
    await runUpdateDone({ name: 'otel-html-update-push-777-1', publishDir: publish, log }, ioOf(), deps);
    const notices = out
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('::notice::'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('503');
  });

  test('an empty or absent log prints no notice', async () => {
    const publish = join(dir, 'publish');
    await runUpdateDone(
      { name: 'otel-html-update-push-777-1', publishDir: publish, log: join(publish, 'x.log') },
      ioOf(),
      deps,
    );
    expect(out.join('')).not.toContain('::notice::');
  });
});

describe('runUpdatePr', () => {
  test.each(['remove-pr', 'reopen-pr'] as const)('%s writes update.json alone', async (kind) => {
    await runUpdatePr({ kind, pr: 5, out: join(dir, 'u') }, ioOf(), deps);
    const name = `otel-html-update-${kind}-5-42`;
    expect(outputs().name).toBe(name);
    const u = await readUpdate(deps.fs, join(dir, 'u', name));
    expect(u.pr).toBe(5);
    expect(readdirSync(join(dir, 'u', name))).toEqual(['update.json']);
  });
});

describe('runUpdateRun', () => {
  const runOpts = (report: string) => ({
    report,
    out: join(dir, 'u'),
    runId: 42,
    repository: 'o/r',
    baseUrl: 'https://x',
  });

  async function runReportDir(): Promise<string> {
    const report = join(dir, 'ci-report');
    const r = await createReportWith({ out: report, format: 'local', assetsBase: 'assets/' }, deps);
    await r.addLogs(logRequest(1));
    await r.flush();
    await r.addLogs(logRequest(2));
    await r.flush();
    await r.close();
    return report;
  }

  test('writes a compacted site-format report and a run update', async () => {
    const report = await runReportDir();
    await runUpdateRun(runOpts(report), ioOf({ GITHUB_TOKEN: 't' }), deps, api);
    const o = outputs();
    expect(o.name).toBe('otel-html-update-run-42-1');
    expect(o.channel).toBe('pr/5');
    expect(o['report-url']).toBe('https://x/pr/5/runs/42/');
    const folder = join(dir, 'u', o.name ?? '');
    const u = await readUpdate(deps.fs, folder);
    expect(u.kind).toBe('run');
    const manifest = await readRunManifest(deps.fs, join(folder, 'report'));
    expect(manifest?.engine.format).toBe('site');
    expect(manifest?.engine.assetsBase).toBe(`../../../../assets/${VERSION}/`);
    expect(manifest?.partitions).toHaveLength(1);
    expect(existsSync(join(folder, 'report/assets'))).toBe(false);
    expect(existsSync(join(folder, 'report/data/state'))).toBe(false);
    const all = readdirSync(folder, { recursive: true }).map(String);
    expect(all.some((f) => f.endsWith('.parquet.js'))).toBe(false);
  });

  test('a run with no channel publishes nothing', async () => {
    const report = await runReportDir();
    const noPulls = async (url: string): Promise<Response> =>
      url.includes('/pulls') ? Response.json([]) : api(url);
    await runUpdateRun(runOpts(report), ioOf(), deps, noPulls);
    const o = outputs();
    expect(o.published).toBe('false');
    expect(o.name).toBe('');
    expect(existsSync(join(dir, 'u'))).toBe(false);
  });
});
