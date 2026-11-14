import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OtelHtmlError } from '../../model/errors.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import {
  type ApiRun,
  envVar,
  type Fetch,
  fetchPullsForSha,
  getJson,
  messageOf,
  say,
  setOutputs,
  warning,
} from './github-api.js';
import { FAILURE_MARK, LOG_FILE, PID_FILE, readLedger, STOP_FILE, writeLedger } from './ledger.js';
import { parseJobContext } from './publish.js';
import { mergeWithConfig } from './publish-io.js';
import { buildPushUpdate, ciSpansFromApi } from './push-update.js';
import { channelFor, reportUrl } from './site.js';
import { runAssetsBase } from './site-main.js';
import { parseUpdateName, readUpdate, UPDATE_FILE, type UpdateJson, updateName } from './update.js';

const API_TIMEOUT_MS = 15_000;
const STOP_WAIT_MS = 90_000;
const STOP_POLL_MS = 1_000;
const NOTICE_LINES = 5;
const NOTICE_CHARS = 600;

const nowIso = (deps: Pick<WriterDeps, 'clock'>): string =>
  new Date(Number(deps.clock.nowUnixNano() / 1_000_000n)).toISOString();
const apiUrlOf = (io: CliIo): string => envVar(io, 'GITHUB_API_URL') ?? 'https://api.github.com';

function needNumber(io: CliIo, name: string): number {
  const v = envVar(io, name);
  const n = Number(v);
  if (v === undefined || !Number.isSafeInteger(n) || n <= 0)
    throw new OtelHtmlError('usage', { message: `${name} is not set to a positive integer` });
  return n;
}

/**
 * The shared timers are unref'd, so while this command only waits for the pusher nothing would keep Node alive: a
 * referenced timer holds the process open until the shared one fires.
 */
const sleep = (deps: WriterDeps, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const hold = setTimeout(() => undefined, ms + 1_000);
    deps.timers.after(ms, () => {
      clearTimeout(hold);
      resolve();
    });
  });

export interface StopOptions {
  /** Default 90 s. */
  waitMs?: number;
  /** Default 1 s. */
  pollMs?: number;
  /** Default `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * D60: asks the pusher to stop, waits up to 90 s for its pid file to vanish, then kills it if it is still alive.
 * SIGKILL: the pusher handles SIGTERM as a soft stop, which a stalled upload outlives (on Windows any signal is a hard kill).
 */
async function stopPusher(deps: WriterDeps, publishDir: string, opts: StopOptions = {}): Promise<void> {
  const { fs } = deps;
  const waitMs = opts.waitMs ?? STOP_WAIT_MS;
  const pollMs = opts.pollMs ?? STOP_POLL_MS;
  await fs.mkdirp(publishDir);
  await fs.writeTextAtomic(`${publishDir}/${STOP_FILE}`, '');
  const pidFile = `${publishDir}/${PID_FILE}`;
  if (!(await fs.exists(pidFile))) return;
  const pid = Number((await fs.readText(pidFile)).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || !deps.process.isAlive(pid)) {
    await fs.remove(pidFile);
    return;
  }
  for (let waited = 0; waited < waitMs; waited += pollMs) {
    await sleep(deps, pollMs);
    if (!(await fs.exists(pidFile))) return;
    if (!deps.process.isAlive(pid)) break;
  }
  try {
    (opts.kill ?? process.kill)(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  await fs.remove(pidFile).catch(() => undefined);
}

/**
 * `ci update stop`: stops a running pusher whatever else the job does (the collect step runs it first, so nothing
 * writes into `.otel-html/` while it is uploaded), then prints the pusher's failure lines as one `::notice::`. Does
 * nothing for a job that never had a pusher. Never throws: a failure is a `::warning::`.
 */
export async function runUpdateStop(
  o: { publishDir: string; log?: string },
  io: CliIo,
  deps: WriterDeps,
  opts: StopOptions = {},
): Promise<void> {
  try {
    const { fs } = deps;
    if (await fs.exists(`${o.publishDir}/${PID_FILE}`)) await stopPusher(deps, o.publishDir, opts);
    if (o.log !== undefined && (await fs.exists(o.log))) {
      const lines = (await fs.readText(o.log))
        .split(/\r?\n/)
        .filter((l) => l.startsWith(FAILURE_MARK))
        .map((l) => l.slice(FAILURE_MARK.length));
      if (lines.length > 0) {
        const shown = lines.slice(-NOTICE_LINES).join(' | ').slice(0, NOTICE_CHARS);
        say(io, `::notice::otel-html pusher: ${lines.length} failure(s) in ${LOG_FILE}: ${shown}`);
      }
    }
  } catch (e) {
    warning(io, 'update stop', messageOf(e));
  }
}

const sidecar = (publishDir: string, name: string): string => `${publishDir}/${name}.sources.json`;

export interface PushOptions {
  report: string;
  out: string;
  final: boolean;
  config?: string;
  /** Default `<report>/../publish`. */
  publishDir?: string;
}

/**
 * `ci update push`: the job's live set from `--report`'s manifest and the ledger (D60), the job id from
 * `<report>/../context.json`, the run from the `GITHUB_*` variables, the CI-spans partition (D61) from the API when
 * GITHUB_TOKEN is set, written to `--out/<name>/`; `--final` stops the pusher first and uses `ledger.sequence + 1`.
 * Reserves the sequence in the ledger. Outputs `name`, `sequence`, `partitions`; `name=` is empty when the report has no
 * partitions yet. Never throws: a failure is a `::warning::` and `name=` empty.
 */
export async function runUpdatePush(
  o: PushOptions,
  io: CliIo,
  deps: WriterDeps,
  fetchFn: Fetch = fetch,
): Promise<void> {
  const warn = (m: string): void => warning(io, 'update push', m);
  const empty = { name: '', sequence: '', partitions: '0' };
  let scratch: string | undefined;
  try {
    const { fs } = deps;
    const publishDir = o.publishDir ?? join(dirname(o.report), 'publish');
    // First, before any check that can throw: a pusher must not outlive collect.
    if (o.final) await stopPusher(deps, publishDir);
    const runId = needNumber(io, 'GITHUB_RUN_ID');
    const runAttempt = needNumber(io, 'GITHUB_RUN_ATTEMPT');
    const repository = envVar(io, 'GITHUB_REPOSITORY');
    if (repository === undefined)
      throw new OtelHtmlError('usage', { message: 'GITHUB_REPOSITORY is not set' });
    const contextPath = join(dirname(o.report), 'context.json');
    const ctx = parseJobContext((await fs.exists(contextPath)) ? await fs.readText(contextPath) : undefined);
    if (ctx === undefined) throw new Error(`${contextPath} is missing or malformed`);

    const ledger = await readLedger(fs, publishDir);
    const sequence = ledger.sequence + 1;

    const hint = envVar(io, 'OTEL_HTML_JOB_NAME') ?? ctx.jobName ?? envVar(io, 'GITHUB_JOB') ?? 'job';
    let jobName = hint;
    let ciReport: string | undefined;
    scratch = await mkdtemp(join(tmpdir(), 'otel-html-ci-spans-'));
    try {
      const ci = await ciSpansFromApi({
        deps,
        fetchFn,
        apiUrl: apiUrlOf(io),
        token: envVar(io, 'GITHUB_TOKEN'),
        repository,
        runId,
        runAttempt,
        ctx,
        config: o.config,
        scratch: join(scratch, 'ci'),
        nowMs: Number(deps.clock.nowUnixNano() / 1_000_000n),
      });
      if (ci.jobName !== undefined) jobName = ci.jobName;
      ciReport = ci.report;
      if (ci.why !== undefined) warn(`no CI spans in this update: ${ci.why}`);
    } catch (e) {
      warn(`no CI spans in this update: ${messageOf(e)}`);
    }

    const name = updateName({
      version: 1,
      kind: 'push',
      runId,
      runAttempt,
      createdAt: '',
      jobId: ctx.jobId,
      sequence,
    });
    const built = await buildPushUpdate({
      deps,
      report: o.report,
      ledger,
      out: join(o.out, name),
      runId,
      runAttempt,
      jobId: ctx.jobId,
      jobName,
      sequence,
      createdAt: nowIso(deps),
      ...(ciReport === undefined ? {} : { ciReport }),
    });
    if (built === undefined) {
      say(io, 'otel-html update push: the report has no partitions yet; nothing to push');
      setOutputs(io, empty);
      return;
    }
    // D60: the sequence is reserved before the upload and never reused
    await writeLedger(fs, publishDir, { ...ledger, sequence });
    await fs.writeTextAtomic(sidecar(publishDir, name), JSON.stringify({ sources: built.sources }));
    setOutputs(io, {
      name,
      sequence: String(sequence),
      partitions: String(built.update.partitions?.length ?? 0),
    });
  } catch (e) {
    warn(`no update written: ${messageOf(e)}`);
    setOutputs(io, empty);
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  }
}

export interface RunOptions {
  report: string;
  out: string;
  runId: number;
  repository: string;
  baseUrl: string;
  config?: string;
}

/** D64: the files a `run` update carries from the report; anything else the merge wrote is removed. */
const RUN_KEEP = /^(index\.html|\.nojekyll|data\/manifest\.js|data\/partitions\/[0-9]{6}\/[a-z_]+\.parquet)$/;

async function pruneReport(deps: WriterDeps, root: string, rel = ''): Promise<void> {
  const { fs } = deps;
  for (const name of await fs.list(rel === '' ? root : `${root}/${rel}`)) {
    const r = rel === '' ? name : `${rel}/${name}`;
    if ((await fs.entryKind(`${root}/${r}`)) === 'dir') {
      await pruneReport(deps, root, r);
      if ((await fs.list(`${root}/${r}`)).length === 0) await fs.removeDir(`${root}/${r}`);
    } else if (!RUN_KEEP.test(r)) await fs.remove(`${root}/${r}`);
  }
}

/**
 * `ci update run` (D64): merges the `ci report` output, compacted, into `--out/<name>/report/` in `site` format on the
 * channel's shared base (`runAssetsBase`), keeps only the files a run update carries, writes `update.json`. Outputs
 * `name`, `channel`, `report-url` and `published`; a run with no channel writes nothing (`published=false`). Throws when
 * the run cannot be read or the report cannot be merged.
 */
export async function runUpdateRun(
  o: RunOptions,
  io: CliIo,
  deps: WriterDeps,
  fetchFn: Fetch = fetch,
): Promise<void> {
  const api = apiUrlOf(io);
  const token = envVar(io, 'GITHUB_TOKEN');
  const get = async <T>(path: string): Promise<T> =>
    (await getJson<T>(`${api}/repos/${o.repository}${path}`, token, API_TIMEOUT_MS, fetchFn)).body;
  const run = await get<ApiRun>(`/actions/runs/${o.runId}`);
  const { default_branch: defaultBranch } = await get<{ default_branch: string }>('');
  const pulls = await fetchPullsForSha(
    { apiUrl: api, repository: o.repository, sha: run.head_sha },
    token,
    API_TIMEOUT_MS,
    fetchFn,
  );
  const placed = channelFor(run, pulls, defaultBranch);
  if (placed === undefined) {
    say(
      io,
      `::notice::otel-html update run: run ${run.id} (${run.head_branch ?? 'unknown branch'}) has no open pull request and is not on the default branch; not published`,
    );
    setOutputs(io, { published: 'false', name: '', channel: '', 'report-url': '' });
    return;
  }
  const reportPath = `${placed.key}/runs/${run.id}`;
  const update: UpdateJson = {
    version: 1,
    kind: 'run',
    runId: run.id,
    runAttempt: run.run_attempt,
    createdAt: nowIso(deps),
  };
  const name = updateName(update);
  const folder = join(o.out, name);
  await deps.fs.removeDir(folder);
  await deps.fs.mkdirp(folder);
  const reportOut = join(folder, 'report');
  await mergeWithConfig(deps, o.config, {
    format: 'site',
    assetsBase: runAssetsBase(reportPath, deps.version),
    compact: true,
  })([o.report], reportOut, false);
  await deps.fs.removeDir(join(reportOut, 'data', 'state'));
  await pruneReport(deps, reportOut);
  await deps.fs.writeTextAtomic(join(folder, UPDATE_FILE), JSON.stringify(update));
  await readUpdate(deps.fs, folder);
  setOutputs(io, {
    name,
    channel: placed.key,
    'report-url': reportUrl(o.baseUrl.replace(/\/+$/, ''), reportPath),
    published: 'true',
  });
}

/** `ci update remove-pr` / `reopen-pr`: `update.json` alone; outputs `name`. The run is `GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT`. */
export async function runUpdatePr(
  o: { kind: 'remove-pr' | 'reopen-pr'; pr: number; out: string },
  io: CliIo,
  deps: Pick<WriterDeps, 'fs' | 'clock'>,
): Promise<void> {
  const update: UpdateJson = {
    version: 1,
    kind: o.kind,
    runId: needNumber(io, 'GITHUB_RUN_ID'),
    runAttempt: needNumber(io, 'GITHUB_RUN_ATTEMPT'),
    createdAt: nowIso(deps),
    pr: o.pr,
  };
  const name = updateName(update);
  await deps.fs.removeDir(join(o.out, name));
  await deps.fs.mkdirp(join(o.out, name));
  await deps.fs.writeTextAtomic(join(o.out, name, UPDATE_FILE), JSON.stringify(update));
  setOutputs(io, { name });
}

/**
 * `ci update done`: records a finished upload in the ledger (`shipped` gains the update's sources, `uploads` the
 * record).
 */
export async function runUpdateDone(
  o: { name: string; publishDir: string },
  deps: Pick<WriterDeps, 'fs' | 'clock'>,
): Promise<void> {
  const { fs } = deps;
  const parsed = parseUpdateName(o.name);
  if (parsed?.kind !== 'push')
    throw new OtelHtmlError('usage', { message: `--name is not a push update's name: ${o.name}` });
  const path = sidecar(o.publishDir, o.name);
  const sources = (await fs.exists(path))
    ? (JSON.parse(await fs.readText(path)) as { sources: string[] }).sources
    : [];
  const ledger = await readLedger(fs, o.publishDir);
  if (!ledger.uploads.some((u) => u.name === o.name)) {
    await writeLedger(fs, o.publishDir, {
      sequence: Math.max(ledger.sequence, parsed.sequence),
      shipped: [...new Set([...ledger.shipped, ...sources])],
      uploads: [
        ...ledger.uploads,
        { name: o.name, sequence: parsed.sequence, sources, finishedAt: nowIso(deps) },
      ],
    });
  }
}
