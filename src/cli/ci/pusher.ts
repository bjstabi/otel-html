import { join } from 'node:path';
import type { Clock, FileSystem } from '../../writer/ports.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import { type uploadArtifact, zipDirectory } from './artifact-client.js';
import { runDispatch } from './dispatch.js';
import { type Fetch, messageOf } from './github-api.js';
import { PID_FILE, readLedger, STOP_FILE, writeLedger } from './ledger.js';
import { parseJobContext } from './publish.js';
import { buildPushUpdate, ciSpansFromApi } from './push-update.js';
import { readRunManifest } from './run-report.js';
import { updateName } from './update.js';

const STOP_POLL_MS = 1_000;

export interface PusherDeps {
  fs: FileSystem;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  upload: typeof uploadArtifact;
  fetchFn: Fetch;
  log: (line: string) => void;
  /** For the CI partition's scratch report. */
  deps: WriterDeps;
}

export interface PusherOptions {
  report: string;
  publishDir: string;
  everyMs: number;
  config?: string;
  env: Readonly<Record<string, string | undefined>>;
  deployerWorkflow: string;
}

type Outcome = { outcome: 'uploaded' | 'unchanged' | 'retry'; listing: string[] };

const ev = (o: PusherOptions, name: string): string | undefined => o.env[name];
const nowMs = (c: Clock): number => Number(c.nowUnixNano() / 1_000_000n);

function needNumber(env: PusherOptions['env'], name: string): number {
  const n = Number(env[name]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} is not set to a positive integer`);
  return n;
}

/**
 * One tick (D60): read the manifest (absent: nothing), diff its sources against the ledger's `shipped`, reserve the
 * next sequence in the ledger, build the update folder under `<publishDir>/tick-<n>/`, zip, upload, record the
 * finished upload in the ledger (`shipped`, `uploads`), dispatch, remove the folder. Every failure is one log line and
 * `'retry'`; a retry takes a fresh sequence, so a name is never offered twice.
 */
export async function tick(o: PusherOptions, d: PusherDeps, last: string[] | null): Promise<Outcome> {
  const { fs } = d;
  let listing = last ?? [];
  const folders: string[] = [];
  let step = 'tick';
  try {
    const manifest = await readRunManifest(fs, o.report);
    if (manifest === null || manifest.partitions.length === 0) return { outcome: 'unchanged', listing };
    listing = manifest.partitions.map((p) => p.source).sort();
    let ledger = await readLedger(fs, o.publishDir);
    const shipped = new Set(ledger.shipped);
    if (listing.every((s) => shipped.has(s))) return { outcome: 'unchanged', listing };

    const token = ev(o, 'ACTIONS_RUNTIME_TOKEN');
    if (token === undefined || token === '')
      throw new Error('ACTIONS_RUNTIME_TOKEN is not set; the job cannot upload artifacts');
    const runId = needNumber(o.env, 'GITHUB_RUN_ID');
    const runAttempt = needNumber(o.env, 'GITHUB_RUN_ATTEMPT');
    const repository = ev(o, 'GITHUB_REPOSITORY');
    if (repository === undefined || repository === '') throw new Error('GITHUB_REPOSITORY is not set');
    const contextPath = join(o.report, '..', 'context.json');
    const ctx = parseJobContext((await fs.exists(contextPath)) ? await fs.readText(contextPath) : undefined);
    if (ctx === undefined) throw new Error(`${contextPath} is missing or malformed`);

    // D60: the sequence is reserved before the upload starts and never reused.
    const sequence = ledger.sequence + 1;
    await writeLedger(fs, o.publishDir, { ...ledger, sequence });
    ledger = { ...ledger, sequence };

    const out = join(o.publishDir, `tick-${sequence}`);
    folders.push(out);
    let jobName = ev(o, 'OTEL_HTML_JOB_NAME') ?? ctx.jobName ?? ev(o, 'GITHUB_JOB') ?? 'job';
    let ciReport: string | undefined;
    const scratch = join(o.publishDir, `tick-${sequence}-ci`);
    folders.push(scratch);
    try {
      const ci = await ciSpansFromApi({
        deps: d.deps,
        fetchFn: d.fetchFn,
        apiUrl: ev(o, 'GITHUB_API_URL') ?? 'https://api.github.com',
        token: ev(o, 'GITHUB_TOKEN'),
        repository,
        runId,
        runAttempt,
        ctx,
        config: o.config,
        scratch,
        nowMs: nowMs(d.clock),
      });
      if (ci.jobName !== undefined) jobName = ci.jobName;
      ciReport = ci.report;
    } catch (e) {
      d.log(`no CI spans in update ${sequence}: ${messageOf(e)}`);
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
      deps: d.deps,
      report: o.report,
      ledger,
      out,
      runId,
      runAttempt,
      jobId: ctx.jobId,
      jobName,
      sequence,
      createdAt: new Date(nowMs(d.clock)).toISOString(),
      ...(ciReport === undefined ? {} : { ciReport }),
    });
    if (built === undefined) return { outcome: 'unchanged', listing };
    step = 'zip';
    const zip = await zipDirectory(fs, out);
    step = 'upload';
    await d.upload({
      name,
      zip,
      env: { ACTIONS_RUNTIME_TOKEN: token, ACTIONS_RESULTS_URL: ev(o, 'ACTIONS_RESULTS_URL') },
      now: () => nowMs(d.clock),
    });

    // Re-read: `ci update done` or a final push may have written meanwhile.
    step = 'ledger update';
    const fresh = await readLedger(fs, o.publishDir);
    if (!fresh.uploads.some((u) => u.name === name))
      await writeLedger(fs, o.publishDir, {
        sequence: Math.max(fresh.sequence, sequence),
        shipped: [...new Set([...fresh.shipped, ...built.sources])],
        uploads: [
          ...fresh.uploads,
          {
            name,
            sequence,
            sources: built.sources,
            finishedAt: new Date(nowMs(d.clock)).toISOString(),
          },
        ],
      });
    d.log(`uploaded ${name} (${built.sources.length} source(s), ${zip.length} bytes)`);
    step = 'dispatch';
    await dispatch(o, d, repository, runId);
    return { outcome: 'uploaded', listing };
  } catch (e) {
    d.log(`${step} failed, will retry: ${messageOf(e)}`);
    return { outcome: 'retry', listing };
  } finally {
    for (const f of folders) await fs.removeDir(f).catch(() => undefined);
  }
}

/** Wakes the deployer; `runDispatch` never throws and says what happened on its stdout, which goes to the log. */
async function dispatch(o: PusherOptions, d: PusherDeps, repository: string, runId: number): Promise<void> {
  const sink = (s: string): void => {
    for (const line of s.split('\n')) if (line.trim() !== '') d.log(line);
  };
  const io = { stdout: sink, stderr: sink, env: o.env, cwd: '' } as unknown as CliIo;
  await runDispatch({ workflow: o.deployerWorkflow, repository, runId }, io, d.fetchFn, { skip: true });
}

/**
 * Writes the pid file, ticks every `everyMs` until the stop file exists (checked every second and after an upload) or
 * a stop signal arrives, removes the pid file, resolves. The wait between ticks is taken in one-second steps.
 */
export async function runPusher(o: PusherOptions, d: PusherDeps, signals: CliIo['signals']): Promise<void> {
  const { fs } = d;
  let stopped = false;
  const off = signals.on(() => {
    stopped = true;
  });
  const stopFile = join(o.publishDir, STOP_FILE);
  const pidFile = join(o.publishDir, PID_FILE);
  const everyMs = Math.max(STOP_POLL_MS, o.everyMs);
  let warned = false;
  const shouldStop = async (): Promise<boolean> => {
    if (stopped) return true;
    try {
      return await fs.exists(stopFile);
    } catch (e) {
      if (!warned) d.log(`cannot check ${stopFile}: ${messageOf(e)}`);
      warned = true;
      return false;
    }
  };
  try {
    await fs.mkdirp(o.publishDir);
    await fs.writeTextAtomic(pidFile, String(d.deps.process.pid));
    let last: string[] | null = null;
    while (!(await shouldStop())) {
      const r = await tick(o, d, last);
      last = r.listing;
      if (await shouldStop()) break;
      for (let waited = 0; waited < everyMs && !stopped; ) {
        const step = Math.min(STOP_POLL_MS, everyMs - waited);
        await d.sleep(step);
        waited += step;
        if (await shouldStop()) break;
      }
    }
  } catch (e) {
    d.log(`the pusher stops: ${messageOf(e)}`);
  } finally {
    off();
    await fs.remove(pidFile).catch(() => undefined);
  }
}
