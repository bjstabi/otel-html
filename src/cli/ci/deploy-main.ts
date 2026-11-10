import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import { downloadArtifact } from './deploy-fetch.js';
import { type PendingPlan, planDeploy } from './deploy-plan.js';
import { envVar, type Fetch, messageOf, say, setOutputs } from './github-api.js';
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
  now: string;
}
export interface DeployFetchOptions {
  repository: string;
  pending: string;
  out: string;
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
    pending: String(accepted.length > 0 || plan.deletionsDue > 0),
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
      u.retry = true;
      u.reason = `download failed: ${messageOf(e)}`;
      say(io, `::warning::otel-html deploy fetch: ${u.name} (${u.id}): ${u.reason}`);
    }
  }
  if (failed > 0) await fs.writeTextAtomic(opts.pending, `${JSON.stringify(plan)}\n`);
  say(
    io,
    `otel-html deploy fetch: ${plan.updates.filter((u) => u.accepted).length} updates downloaded, ${failed} failed`,
  );
}
