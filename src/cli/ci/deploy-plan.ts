import { OtelHtmlError } from '../../model/errors.js';
import type { WriterDeps } from '../../writer/session.js';
import { downloadArtifact } from './deploy-fetch.js';
import {
  type ApiArtifact,
  type ApiDeployment,
  type ApiDeploymentStatus,
  type ApiPull,
  type ApiRun,
  type Fetch,
  fetchArtifacts,
  fetchJobs,
  fetchPullsForSha,
  getJson,
  getJsonIfFound,
} from './github-api.js';
import { type Channel, channelFor, type SiteRun, siteRunOf } from './site.js';
import {
  DELETION_GRACE_MS,
  parseStateName,
  readSiteState,
  type SiteState,
  type StateForm,
  stateArtifactName,
  writeSiteState,
} from './site-state.js';
import { MAX_UPDATE_BYTES, type ParsedName, parseUpdateName, UPDATE_PREFIX } from './update.js';

/** §5.3 step 1 and D59/D65: the base, the newest site state and the pending updates, authenticated by their runs and names. */

const API_TIMEOUT_MS = 15_000;
const HOUR_MS = 3_600_000;
/** A deployment younger than this may still be going live: the pass waits rather than build on a stale site. */
const WAIT_MS = 10 * 60_000;
/** A state artifact is five small JSON files. */
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const PUSH_EVENTS = ['push', 'pull_request', 'schedule', 'workflow_dispatch'];
const DEPLOYER_EVENTS = ['workflow_dispatch', 'schedule', 'workflow_run'];
const RUN_EVENTS = ['workflow_run', 'workflow_dispatch'];

export interface PlanOptions {
  apiUrl: string;
  repository: string;
  ciWorkflows: string[];
  reportWorkflow: string;
  /** The deployer workflow file: only its runs on the default branch may upload a consumed state. */
  deployerWorkflow: string;
  pagesUrl: string;
  /** Where the chosen state's files are written. */
  stateOut: string;
  now: string;
}
type BaseKind = 'artifact' | 'live' | 'gh-pages' | 'empty' | 'wait';
interface BaseInfo {
  kind: BaseKind;
  deploymentId?: number;
  runId?: number;
  artifactId?: number;
  /** The success status's `created_at`. */
  liveAt?: string;
}
export interface PendingUpdate {
  id: number;
  name: string;
  parsed: ParsedName;
  createdAt: string;
  sizeBytes: number;
  uploader: { runId: number; path: string; event: string; headBranch: string | null; sameRepo: boolean };
  /** The run the update is about: the uploader for push/remove/reopen, the named run for `run`. */
  run: (SiteRun & { event: string }) | null;
  channel: { key: string; channel: Omit<Channel, 'runs'> } | null;
  /** push: the API's display name of a numeric job key. */
  jobName?: string;
  /** push: the attempt of the uploader's run in which the numeric job key is a job (an update's own `runAttempt` must not exceed it). */
  jobAttempt?: number;
  accepted: boolean;
  /** Set by `ci deploy fetch` when the download failed: not rejected for good, the next pass tries again. */
  retry?: true;
  reason?: string;
}
export interface PendingPlan {
  version: 1;
  base: BaseInfo;
  /** The state written to `stateOut`, null when none counted. */
  state: StateForm | null;
  updates: PendingUpdate[];
  deletionsDue: number;
  floor: string;
  now: string;
}

/** A failed check of one update: recorded as its rejection, never stops the pass. */
class Rejection extends Error {}
const refuse = (reason: string): never => {
  throw new Rejection(reason);
};

const isoOrUndefined = (text: string | undefined): number | undefined => {
  const n = Date.parse(text ?? '');
  return Number.isNaN(n) ? undefined : n;
};
const sameForm = (a: StateForm, b: StateForm): boolean => stateArtifactName(a) === stateArtifactName(b);

/** The repository's `github-pages` deployments, newest first. */
export const listDeployments = (
  get: <T>(url: string) => Promise<T>,
  repo: string,
): Promise<ApiDeployment[]> =>
  get<ApiDeployment[]>(`${repo}/deployments?environment=github-pages&per_page=100`);

/** The deployments that went live, newest first, with the deployer run that made each (from its success status's log URL). */
export async function* successfulDeployments(
  get: <T>(url: string) => Promise<T>,
  repo: string,
  deployments: ApiDeployment[],
): AsyncGenerator<{ id: number; runId: number; liveAt: string }> {
  for (const d of deployments) {
    const statuses = await get<ApiDeploymentStatus[]>(`${repo}/deployments/${d.id}/statuses?per_page=100`);
    const ok = statuses.find((s) => s.state === 'success');
    const runId = /\/actions\/runs\/(\d+)\//.exec(ok?.log_url ?? '')?.[1];
    if (ok === undefined || runId === undefined) continue;
    yield { id: d.id, runId: Number(runId), liveAt: ok.created_at };
  }
}

export async function planDeploy(
  o: PlanOptions,
  deps: Pick<WriterDeps, 'fs'>,
  token: string | undefined,
  fetchFn: Fetch,
): Promise<PendingPlan> {
  const { fs } = deps;
  const repo = `${o.apiUrl}/repos/${o.repository}`;
  const nowMs = Date.parse(o.now);
  const hourBefore = (ms: number): string => new Date(ms - HOUR_MS).toISOString();
  const get = async <T>(url: string): Promise<T> =>
    (await getJson<T>(url, token, API_TIMEOUT_MS, fetchFn)).body;
  const live = async (path: string): Promise<Response | undefined> => {
    // the public site: no credentials go there
    const res = await fetchFn(`${o.pagesUrl.replace(/\/+$/, '')}/${path}`, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`${res.url || path} answered ${res.status}`);
    return res;
  };
  const unexpired = (a: ApiArtifact): boolean => !((isoOrUndefined(a.expires_at) ?? Infinity) <= nowMs);
  const runArtifacts = async (runId: number, name: string): Promise<ApiArtifact[]> =>
    (
      await get<{ artifacts?: ApiArtifact[] }>(`${repo}/actions/runs/${runId}/artifacts?name=${name}`)
    ).artifacts?.filter(unexpired) ?? [];

  // (1) the last successful deployment
  const deployments = await listDeployments(get, repo);
  const newestDeployedAt = deployments[0]?.created_at;
  let base: BaseInfo = { kind: 'live' };
  for await (const d of successfulDeployments(get, repo, deployments)) {
    base = { kind: 'live', deploymentId: d.id, runId: d.runId, liveAt: d.liveAt };
    break;
  }
  const baseRun = base.runId;
  const tarball = baseRun === undefined ? undefined : (await runArtifacts(baseRun, 'github-pages'))[0];
  if (tarball !== undefined) base = { ...base, kind: 'artifact', artifactId: tarball.id };
  else {
    if (await live('site-state/files.json')) {
      const age = nowMs - (isoOrUndefined(newestDeployedAt) ?? -Infinity);
      if (age < WAIT_MS) {
        return {
          version: 1,
          base: { kind: 'wait' },
          state: null,
          updates: [],
          deletionsDue: 0,
          floor: hourBefore(nowMs),
          now: o.now,
        };
      }
    } else {
      const branch = await getJsonIfFound<unknown>(
        `${repo}/branches/gh-pages`,
        token,
        API_TIMEOUT_MS,
        fetchFn,
      );
      base = { ...base, kind: branch === undefined ? 'empty' : 'gh-pages' };
    }
  }

  // (2) the state: its form and files from an artifact, else the live site's applied.json
  const scratch = `${o.stateOut}.download`;
  const loadState = async (a: ApiArtifact, form: StateForm): Promise<SiteState | undefined> => {
    try {
      await downloadArtifact(
        { apiUrl: o.apiUrl, repository: o.repository, id: a.id, out: scratch, maxBytes: MAX_STATE_BYTES },
        fs,
        token,
        fetchFn,
      );
      const state = await readSiteState(fs, scratch, () => {});
      return sameForm(state.applied.form, form) ? state : undefined;
    } finally {
      await fs.removeDir(scratch);
    }
  };
  let state: SiteState | undefined;
  const fullName = baseRun === undefined ? undefined : stateArtifactName({ kind: 'full', runId: baseRun });
  const fullArtifact =
    baseRun === undefined || fullName === undefined ? undefined : (await runArtifacts(baseRun, fullName))[0];
  if (fullArtifact !== undefined && baseRun !== undefined)
    state = await loadState(fullArtifact, { kind: 'full', runId: baseRun });
  let applied = state?.applied;
  if (applied === undefined) {
    const res = await live('site-state/applied.json');
    if (res !== undefined) {
      // cold start: the live site's own state files (a missing one is its empty form)
      await fs.removeDir(scratch);
      await fs.mkdirp(scratch);
      await fs.writeTextAtomic(`${scratch}/applied.json`, await res.text());
      for (const name of ['removed', 'files', 'deletions', 'runs']) {
        const other = await live(`site-state/${name}.json`);
        if (other !== undefined) await fs.writeTextAtomic(`${scratch}/${name}.json`, await other.text());
      }
      const read = await readSiteState(fs, scratch, () => {});
      await fs.removeDir(scratch);
      // a malformed file reads as the empty form: everything pending
      if (!(read.applied.form.kind === 'full' && read.applied.form.runId === 0)) {
        state = read;
        applied = read.applied;
      }
    }
  }
  const floorMs = isoOrUndefined(applied?.floor) ?? nowMs - HOUR_MS;

  // the API lookups, cached per pass
  const runs = new Map<number, Promise<ApiRun | undefined>>();
  const getRun = (id: number): Promise<ApiRun | undefined> => {
    let p = runs.get(id);
    if (p === undefined) {
      p = getJsonIfFound<ApiRun>(`${repo}/actions/runs/${id}`, token, API_TIMEOUT_MS, fetchFn);
      runs.set(id, p);
    }
    return p;
  };
  const pullsByRun = new Map<number, Promise<ApiPull[]>>();
  const pullsOf = (run: ApiRun): Promise<ApiPull[]> => {
    let p = pullsByRun.get(run.id);
    if (p === undefined) {
      p = fetchPullsForSha(
        { apiUrl: o.apiUrl, repository: o.repository, sha: run.head_sha },
        token,
        API_TIMEOUT_MS,
        fetchFn,
      );
      pullsByRun.set(run.id, p);
    }
    return p;
  };
  const jobsByAttempt = new Map<string, Promise<{ id: number; name: string }[]>>();
  const jobsOf = (run: ApiRun, attempt: number): Promise<{ id: number; name: string }[]> => {
    const key = `${run.id}/${attempt}`;
    let p = jobsByAttempt.get(key);
    if (p === undefined) {
      p = fetchJobs(
        { apiUrl: o.apiUrl, repository: o.repository, runId: run.id, runAttempt: attempt },
        token,
        API_TIMEOUT_MS,
        fetchFn,
      );
      jobsByAttempt.set(key, p);
    }
    return p;
  };
  let defaultBranch: Promise<string> | undefined;
  const defaultBranchOf = (): Promise<string> =>
    (defaultBranch ??= get<{ default_branch: string }>(repo).then((r) => r.default_branch));

  // (3) the listing walk, newest first, down to the floor
  const listed = (
    await fetchArtifacts(
      { apiUrl: o.apiUrl, repository: o.repository },
      token,
      API_TIMEOUT_MS,
      (c) => (isoOrUndefined(c) ?? Infinity) < floorMs,
      fetchFn,
    )
  ).filter(unexpired);
  const deployerPath = `.github/workflows/${o.deployerWorkflow}`;
  // a fork's pull_request run can upload artifacts here: only the deployer's own runs on the default branch count
  const isDeployerRun = async (a: ApiArtifact): Promise<boolean> => {
    const id = a.workflow_run?.id;
    const run = id === undefined ? undefined : await getRun(id);
    return (
      run !== undefined &&
      run.path === deployerPath &&
      run.head_repository?.full_name === o.repository &&
      run.head_branch === (await defaultBranchOf()) &&
      DEPLOYER_EVENTS.includes(run.event) &&
      run.id > (base.runId ?? 0)
    );
  };
  for (const a of listed) {
    const form = parseStateName(a.name);
    if (form?.kind !== 'consumed' || form.base !== base.deploymentId) continue;
    if (!(await isDeployerRun(a))) continue;
    // a fork's pull_request run can upload artifacts here: only the deployer's own runs on the default branch count
    if (!(await isDeployerRun(a))) continue;
    let found: SiteState | undefined;
    try {
      found = await loadState(a, form);
    } catch (e) {
      // unreadable content: the next candidate, or the base's own state; a network or HTTP failure fails the pass
      if (!(e instanceof OtelHtmlError)) throw e;
    }
    if (found !== undefined) {
      state = found;
      applied = found.applied;
      break;
    }
  }

  // (4) the candidates, authenticated
  const ciPaths = o.ciWorkflows.map((w) => `.github/workflows/${w}`);
  const reportPath = `.github/workflows/${o.reportWorkflow}`;
  const channelOf = async (run: ApiRun): Promise<NonNullable<PendingUpdate['channel']>> =>
    channelFor(run, await pullsOf(run), await defaultBranchOf()) ?? refuse('no channel');

  const check = async (a: ApiArtifact, update: PendingUpdate): Promise<void> => {
    const { parsed } = update;
    const uploaderId = a.workflow_run?.id;
    const uploader = uploaderId === undefined ? undefined : await getRun(uploaderId);
    if (uploader === undefined) return refuse(`run ${uploaderId ?? 'of the artifact'} not found`);
    update.uploader = {
      runId: uploader.id,
      path: uploader.path,
      event: uploader.event,
      headBranch: uploader.head_branch,
      sameRepo: uploader.head_repository?.full_name === o.repository,
    };
    if (parsed.kind === 'push') {
      if (!ciPaths.includes(uploader.path)) refuse('not a ci workflow');
      if (!PUSH_EVENTS.includes(uploader.event))
        refuse(`event ${uploader.event} is not allowed for push updates`);
    } else {
      if (uploader.path !== reportPath) refuse('not the report workflow');
      const events = parsed.kind === 'run' ? RUN_EVENTS : ['pull_request_target'];
      if (!events.includes(uploader.event))
        refuse(`event ${uploader.event} is not allowed for ${parsed.kind} updates`);
      if (parsed.kind === 'run' && uploader.head_branch !== (await defaultBranchOf()))
        refuse('not the default branch');
    }
    if (a.size_in_bytes > MAX_UPDATE_BYTES) refuse('too large');

    switch (parsed.kind) {
      case 'push': {
        update.run = { ...siteRunOf(uploader, ''), event: uploader.event };
        const placed = await channelOf(uploader);
        update.channel = placed;
        update.run = { ...siteRunOf(uploader, `${placed.key}/runs/${uploader.id}`), event: uploader.event };
        if (/^\d+$/.test(parsed.jobKey)) {
          const id = Number(parsed.jobKey);
          for (let attempt = uploader.run_attempt; attempt >= 1; attempt--) {
            const job = (await jobsOf(uploader, attempt)).find((j) => j.id === id);
            if (job === undefined) continue;
            update.jobName = job.name;
            update.jobAttempt = attempt;
            return;
          }
          refuse(
            uploader.run_attempt === 1
              ? `not a job of run ${uploader.id} attempt 1`
              : `not a job of run ${uploader.id} in attempts 1 to ${uploader.run_attempt}`,
          );
        }
        return; // a hashed key of an approximate job cannot be checked (D59)
      }
      case 'run': {
        const named = await getRun(parsed.runId);
        if (named === undefined) return refuse(`run ${parsed.runId} not found`);
        if (!ciPaths.includes(named.path) || named.repository.full_name !== o.repository)
          refuse(`run ${named.id} is not a ci workflow run of ${o.repository}`);
        if (parsed.runAttempt > named.run_attempt)
          refuse(`run ${named.id} has no attempt ${parsed.runAttempt}`);
        const placed = await channelOf(named);
        update.channel = placed;
        update.run = { ...siteRunOf(named, `${placed.key}/runs/${named.id}`), event: named.event };
        return;
      }
      case 'remove-pr':
      case 'reopen-pr':
        if (parsed.runId !== uploader.id)
          refuse(`named for run ${parsed.runId}, uploaded by run ${uploader.id}`);
        {
          // a pull_request_target run reports the pull request's head branch: the pull request itself vouches for it
          const pull = await getJsonIfFound<ApiPull & { base: { ref: string } }>(
            `${repo}/pulls/${parsed.pr}`,
            token,
            API_TIMEOUT_MS,
            fetchFn,
          );
          if (pull === undefined) return refuse(`pull request ${parsed.pr} not found`);
          if (
            pull.base.ref !== (await defaultBranchOf()) ||
            pull.head.ref !== uploader.head_branch ||
            pull.head.repo?.full_name !== uploader.head_repository?.full_name
          )
            refuse("not the pull request's run");
        }
    }
  };

  const consumed = applied?.updates ?? {};
  // everything below the chosen state's floor is consumed, whatever its pruned `updates` still list
  const chosenFloorMs = isoOrUndefined(applied?.floor) ?? -Infinity;
  const updates: PendingUpdate[] = [];
  for (const a of listed) {
    if (!a.name.startsWith(UPDATE_PREFIX) || String(a.id) in consumed) continue;
    if ((isoOrUndefined(a.created_at) ?? Infinity) < chosenFloorMs) continue;
    const parsed = parseUpdateName(a.name);
    if (parsed === undefined) continue;
    const update: PendingUpdate = {
      id: a.id,
      name: a.name,
      parsed,
      createdAt: a.created_at,
      sizeBytes: a.size_in_bytes,
      uploader: { runId: a.workflow_run?.id ?? 0, path: '', event: '', headBranch: null, sameRepo: false },
      run: null,
      channel: null,
      accepted: false,
    };
    try {
      await check(a, update);
      update.accepted = true;
    } catch (e) {
      if (!(e instanceof Rejection)) throw e;
      update.reason = e.message;
    }
    updates.push(update);
  }

  // (5) the deletions of the base pass that are due
  let deletionsDue = 0;
  if (state !== undefined) {
    const liveAtMs = isoOrUndefined(base.liveAt);
    state.deletions.files = state.deletions.files.map((f) =>
      f.pass === base.runId && base.liveAt !== undefined ? { ...f, liveAt: base.liveAt } : f,
    );
    for (const f of state.deletions.files) {
      const at = f.pass === base.runId ? liveAtMs : isoOrUndefined(f.liveAt);
      if (at !== undefined && at + DELETION_GRACE_MS <= nowMs) deletionsDue++;
    }
    await writeSiteState(fs, o.stateOut, state);
  }

  const pendingFrom = updates.filter((u) => u.accepted).map((u) => isoOrUndefined(u.createdAt) ?? Infinity);
  const oldest = Math.min(...pendingFrom);
  const floor = hourBefore(Number.isFinite(oldest) ? oldest : nowMs);
  return { version: 1, base, state: state?.applied.form ?? null, updates, deletionsDue, floor, now: o.now };
}
