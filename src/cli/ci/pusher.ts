import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, FileSystem } from '../../writer/ports.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import { type uploadArtifact, zipDirectory } from './artifact-client.js';
import { type Fetch, messageOf } from './github-api.js';
import { FAILURE_MARK, PID_FILE, readLedger, STOP_FILE, writeLedger } from './ledger.js';
import { parseJobContext } from './publish.js';
import { buildPushUpdate, ciSpansFromApi } from './push-update.js';
import { readRunManifest } from './run-report.js';
import { updateName } from './update.js';

const STOP_POLL_MS = 1_000;
/** The CI-spans lookup (2 API calls and a scratch report) runs at most this often; between lookups the last result is reused. */
export const CI_SPANS_EVERY_MS = 300_000;

/**
 * Where in `[0, everyMs)` a pusher's first tick falls: a hash of the job's identity, so the pushers of one run, started
 * within seconds of each other, do not all make their first check at the same moment. Deterministic: the same job always
 * gets the same offset. It only spreads the first ticks, so the pushers' CI-spans lookups do not all hit the API at the same moment.
 */
export function jitterMs(identity: string, everyMs: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < identity.length; i++) h = Math.imul(h ^ identity.charCodeAt(i), 0x01000193) >>> 0;
  return Math.floor((h / 0x1_0000_0000) * Math.max(0, everyMs));
}

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
  /** Wait this long before the first tick (see `jitterMs`); default 0. */
  startDelayMs?: number;
  config?: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** What a pusher keeps between ticks: the last CI-spans lookup (its report lives in `dir` until the pusher ends). */
export interface PusherCache {
  at?: number;
  dir?: string;
  ci?: { jobName?: string; report?: string };
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
 * next sequence in the ledger, build the update folder under the OS temp dir (`$RUNNER_TEMP`; never inside the uploaded `.otel-html/`), zip, upload, record the
 * finished upload in the ledger (`shipped`, `uploads`), remove the folder. Every failure is one log line and
 * `'retry'`; a retry takes a fresh sequence, so a name is never offered twice.
 */
export async function tick(
  o: PusherOptions,
  d: PusherDeps,
  last: string[] | null,
  cache?: PusherCache,
): Promise<Outcome> {
  const { fs } = d;
  const kept = cache ?? {};
  let listing = last ?? [];
  const folders: string[] = [];
  let step = 'tick';
  try {
    const manifest = await readRunManifest(fs, o.report);
    if (manifest === null || manifest.partitions.length === 0) return { outcome: 'unchanged', listing };
    listing = manifest.partitions.map((p) => p.source).sort();
    let ledger = await readLedger(fs, o.publishDir);
    const shipped = new Set(ledger.shipped);
    if (listing.every((s) => shipped.has(s))) {
      return { outcome: 'unchanged', listing };
    }

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

    const work = await mkdtemp(join(ev(o, 'RUNNER_TEMP') || tmpdir(), 'otel-html-tick-'));
    folders.push(work);
    const out = join(work, `tick-${sequence}`);
    let jobName = ev(o, 'OTEL_HTML_JOB_NAME') ?? ctx.jobName ?? ev(o, 'GITHUB_JOB') ?? 'job';
    const now = nowMs(d.clock);
    if (kept.at === undefined || now - kept.at >= CI_SPANS_EVERY_MS) {
      kept.at = now;
      try {
        kept.dir ??= await mkdtemp(join(ev(o, 'RUNNER_TEMP') || tmpdir(), 'otel-html-ci-'));
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
          // Never the cached report's own folder: a failed refresh must leave the cached report whole.
          scratch: join(kept.dir, kept.ci?.report?.endsWith('ci-a') === true ? 'ci-b' : 'ci-a'),
          nowMs: now,
        });
        if (ci.report !== undefined) kept.ci = ci;
        if (ci.why !== undefined) d.log(`${FAILURE_MARK}no CI spans in update ${sequence}: ${ci.why}`);
      } catch (e) {
        d.log(`${FAILURE_MARK}no CI spans in update ${sequence}: ${messageOf(e)}`);
      }
    }
    if (kept.ci?.jobName !== undefined) jobName = kept.ci.jobName;
    const ciReport = kept.ci?.report;

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
    const uploadStart = nowMs(d.clock);
    await d.upload({
      name,
      zip,
      env: { ACTIONS_RUNTIME_TOKEN: token, ACTIONS_RESULTS_URL: ev(o, 'ACTIONS_RESULTS_URL') },
      now: () => nowMs(d.clock),
    });
    const uploadMs = nowMs(d.clock) - uploadStart;

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
    d.log(`uploaded ${name} (${built.sources.length} source(s), ${zip.length} bytes, ${uploadMs} ms)`);
    return { outcome: 'uploaded', listing };
  } catch (e) {
    d.log(`${FAILURE_MARK}${step} failed, will retry: ${messageOf(e)}`);
    return { outcome: 'retry', listing };
  } finally {
    for (const f of folders) await fs.removeDir(f).catch(() => undefined);
    if (cache === undefined && kept.dir !== undefined) await fs.removeDir(kept.dir).catch(() => undefined);
  }
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
      if (!warned) d.log(`${FAILURE_MARK}cannot check ${stopFile}: ${messageOf(e)}`);
      warned = true;
      return false;
    }
  };
  const cache: PusherCache = {};
  try {
    await fs.mkdirp(o.publishDir);
    await fs.writeTextAtomic(pidFile, String(d.deps.process.pid));
    let last: string[] | null = null;
    for (let waited = 0; waited < (o.startDelayMs ?? 0) && !(await shouldStop()); ) {
      const step = Math.min(STOP_POLL_MS, (o.startDelayMs ?? 0) - waited);
      await d.sleep(step);
      waited += step;
    }
    while (!(await shouldStop())) {
      const r = await tick(o, d, last, cache);
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
    d.log(`${FAILURE_MARK}the pusher stops: ${messageOf(e)}`);
  } finally {
    off();
    if (cache.dir !== undefined) await rm(cache.dir, { recursive: true, force: true }).catch(() => undefined);
    await fs.remove(pidFile).catch(() => undefined);
  }
}
