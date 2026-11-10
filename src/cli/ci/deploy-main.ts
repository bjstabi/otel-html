import { OtelHtmlError } from '../../model/errors.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import { type ApplyResult, applyUpdates } from './deploy-apply.js';
import { downloadArtifact } from './deploy-fetch.js';
import { type PendingPlan, planDeploy } from './deploy-plan.js';
import { fetchLiveSite, pruneArtifacts } from './deploy-prune.js';
import { envVar, type Fetch, messageOf, say, setOutputs } from './github-api.js';
import { readSiteState, SITE_STATE_DIR, scanFiles } from './site-state.js';
import { MAX_UPDATE_BYTES } from './update.js';

export interface DeployPlanOptions {
  repository: string;
  /** Where `pending.json` is written. */
  out: string;
  /** Where the chosen state's files are written. */
  stateOut: string;
  pagesUrl: string;
  ciWorkflows: string[];
  reportWorkflow: string;
  deployerWorkflow: string;
  now: string;
}
export interface DeployFetchOptions {
  repository: string;
  pending: string;
  out: string;
}

export interface DeployApplyOptions {
  site: string;
  state?: string;
  updates: string;
  /** `pending.json`; optional with `trust`. */
  pending?: string;
  repository: string;
  retention: number;
  prRetention: number;
  config?: string;
  passRunId: number;
  trust?: { channel: string };
  now: string;
}

const apiUrlOf = (io: CliIo): string => envVar(io, 'GITHUB_API_URL') ?? 'https://api.github.com';

/** `ci deploy plan`: writes `pending.json` and the chosen state, prints the summary and sets the step outputs. */
export async function runDeployPlan(
  opts: DeployPlanOptions,
  io: CliIo,
  deps: Pick<WriterDeps, 'fs'>,
  fetchFn: Fetch = fetch,
): Promise<PendingPlan> {
  const plan = await planDeploy({ ...opts, apiUrl: apiUrlOf(io) }, deps, envVar(io, 'GITHUB_TOKEN'), fetchFn);
  await deps.fs.mkdirp(opts.out.slice(0, Math.max(0, opts.out.lastIndexOf('/'))) || '.');
  await deps.fs.writeTextAtomic(opts.out, `${JSON.stringify(plan)}\n`);
  const accepted = plan.updates.filter((u) => u.accepted);
  const base = plan.base.runId === undefined ? plan.base.kind : `${plan.base.kind} (run ${plan.base.runId})`;
  say(
    io,
    `otel-html deploy plan: base ${base}; ${accepted.length} of ${plan.updates.length} updates accepted; ${plan.deletionsDue} deletions due`,
  );
  for (const u of plan.updates) if (!u.accepted) say(io, `  rejected ${u.name} (${u.id}): ${u.reason}`);
  setOutputs(io, {
    // a rejected update is recorded by apply (else it is re-authenticated every pass)
    pending: String(plan.updates.length > 0 || plan.deletionsDue > 0),
    base_kind: plan.base.kind,
    base_run_id: String(plan.base.runId ?? ''),
    base_artifact_id: String(plan.base.artifactId ?? ''),
    base_deployment_id: String(plan.base.deploymentId ?? ''),
    wait: String(plan.base.kind === 'wait'),
  });
  return plan;
}

/**
 * `ci deploy fetch`: downloads every accepted update of `pending` into `<out>/<name>/`. A download that fails marks the
 * update rejected (`download failed: ...`) in the rewritten `pending.json` and the pass goes on; the next pass retries it.
 */
export async function runDeployFetch(
  opts: DeployFetchOptions,
  io: CliIo,
  deps: Pick<WriterDeps, 'fs'>,
  fetchFn: Fetch = fetch,
): Promise<void> {
  const { fs } = deps;
  const plan = JSON.parse(await fs.readText(opts.pending)) as PendingPlan;
  const token = envVar(io, 'GITHUB_TOKEN');
  let failed = 0;
  for (const u of plan.updates) {
    if (!u.accepted) continue;
    try {
      await downloadArtifact(
        {
          apiUrl: apiUrlOf(io),
          repository: opts.repository,
          id: u.id,
          out: `${opts.out}/${u.name}`,
          maxBytes: MAX_UPDATE_BYTES,
        },
        fs,
        token,
        fetchFn,
      );
    } catch (e) {
      failed++;
      u.accepted = false;
      if (e instanceof OtelHtmlError) {
        // the content itself is bad (a crafted zip, too large): rejected for good, not retried
        u.reason = `unreadable: ${messageOf(e)}`;
      } else {
        u.retry = true;
        u.reason = `download failed: ${messageOf(e)}`;
      }
      say(io, `::warning::otel-html deploy fetch: ${u.name} (${u.id}): ${u.reason}`);
    }
  }
  if (failed > 0) await fs.writeTextAtomic(opts.pending, `${JSON.stringify(plan)}\n`);
  say(
    io,
    `otel-html deploy fetch: ${plan.updates.filter((u) => u.accepted).length} updates downloaded, ${failed} failed`,
  );
}

/** `ci deploy apply`: applies the pending updates to the unpacked site (never calls the API, never deploys) and sets the step outputs. */
export async function runDeployApply(
  opts: DeployApplyOptions,
  io: CliIo,
  deps: WriterDeps,
): Promise<ApplyResult> {
  const pending: PendingPlan =
    opts.pending === undefined
      ? {
          version: 1,
          base: { kind: 'live' },
          state: null,
          updates: [],
          deletionsDue: 0,
          floor: new Date(Date.parse(opts.now) - 3_600_000).toISOString(),
          now: opts.now,
        }
      : JSON.parse(await deps.fs.readText(opts.pending));
  const { pending: _file, ...rest } = opts;
  const result = await applyUpdates({ ...rest, pending }, deps, io);
  say(
    io,
    `otel-html deploy apply: ${result.consumed} updates consumed (${result.rejected} rejected), site ${result.changed ? 'changed' : 'unchanged'}`,
  );
  setOutputs(io, {
    changed: String(result.changed),
    consumed: String(result.consumed),
    deploy: String(result.deployed),
    previews: result.previews.join(','),
    pending_jobs: result.pendingJobs.join(','),
  });
  return result;
}

export interface DeployPruneOptions {
  site: string;
  repository: string;
  keep: number;
  now: string;
}

/** `ci deploy prune`: §5.3 step 6 with a write token; a failed delete is a warning, never a failure. */
export async function runDeployPrune(
  opts: DeployPruneOptions,
  io: CliIo,
  deps: Pick<WriterDeps, 'fs'>,
  fetchFn: Fetch = fetch,
): Promise<{ deleted: number[] }> {
  const state = await readSiteState(deps.fs, `${opts.site}/${SITE_STATE_DIR}`, (m) =>
    say(io, `::warning::otel-html deploy prune: ${m}`),
  );
  const token = envVar(io, 'GITHUB_TOKEN');
  const { deleted } = await pruneArtifacts(
    {
      apiUrl: apiUrlOf(io),
      repository: opts.repository,
      keep: opts.keep,
      applied: state.applied,
      now: opts.now,
      ...(token === undefined ? {} : { token }),
    },
    fetchFn,
    (m) => say(io, `::warning::otel-html deploy prune: ${m}`),
  );
  say(io, `otel-html deploy prune: ${deleted.length} artifacts deleted`);
  return { deleted };
}

/** `ci deploy fetch-live`: rebuilds a base from the live site's `files.json` (cold start). */
export async function runDeployFetchLive(
  opts: { pagesUrl: string; out: string },
  io: CliIo,
  deps: Pick<WriterDeps, 'fs'>,
  fetchFn: Fetch = fetch,
): Promise<{ files: number; bytes: number }> {
  const result = await fetchLiveSite(opts, deps.fs, fetchFn);
  say(io, `otel-html deploy fetch-live: ${result.files} files, ${result.bytes} bytes`);
  return result;
}

/** `ci deploy scan`: rewrites `<site>/site-state/files.json` after the preview step added files. */
export async function runDeployScan(
  opts: { site: string },
  io: Pick<CliIo, 'stdout'>,
  deps: Pick<WriterDeps, 'fs'>,
): Promise<void> {
  const files = await scanFiles(deps.fs, opts.site);
  await deps.fs.mkdirp(`${opts.site}/${SITE_STATE_DIR}`);
  await deps.fs.writeTextAtomic(`${opts.site}/${SITE_STATE_DIR}/files.json`, `${JSON.stringify(files)}\n`);
  say(io, `otel-html deploy scan: ${Object.keys(files.files).length} files`);
}
