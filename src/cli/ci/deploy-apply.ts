import { copyFile, lstat, mkdir, readdir, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveApiConfig } from '../../api/report.js';
import type { ResolvedConfig } from '../../config/schema.js';
import { MANIFEST_PATH } from '../../format/paths.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { FileSystem } from '../../writer/ports.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import type { PendingPlan, PendingUpdate } from './deploy-plan.js';
import { messageOf, warning } from './github-api.js';
import { addRunReport, diskNext, ensureMainReport, removeRun } from './main-report.js';
import { dashboardIds, withBranchDefault } from './report-links.js';
import {
  emptyRunState,
  type JobUpdate,
  newRunManifest,
  planSync,
  type RunReportState,
  readRunManifest,
  writeRunReport,
} from './run-report.js';
import {
  applyTiers,
  assetsBaseFor,
  type Channel,
  closePullRequest,
  dropWorkflowChannels,
  IN_PROGRESS,
  placeRun,
  reopenPullRequest,
  type SiteIndex,
  type SiteRun,
  slug,
} from './site.js';
import { ensureSharedAssets, migrateAssetsBases, pruneAssets, referencedAssets } from './site-assets.js';
import { readSiteIndex, removePaths, writeBadges, writeSite } from './site-io.js';
import { migrateToOneReport } from './site-migrate.js';
import {
  DELETION_GRACE_MS,
  readSiteState,
  SITE_STATE_DIR,
  type SiteState,
  type StateForm,
  scanFiles,
  type UpdateOutcome,
  writeSiteState,
} from './site-state.js';
import { trimRun } from './trim-run.js';
import { nameMatches, type ParsedName, parseUpdateName, readUpdate, type UpdateJson } from './update.js';

/** §5.3 steps 3 to 5 over directories (D54, D59, D63, D64, D66): a pure function of the unpacked base, the state and the updates. */

export interface ApplyOptions {
  /** The unpacked base, edited in place. */
  site: string;
  /** The state `plan` chose; overwrites `<site>/site-state/` first (§5.3 step 1). */
  state?: string;
  /** `<dir>/<artifact name>/` per update. */
  updates: string;
  pending: PendingPlan;
  repository: string;
  /** Runs kept in full per workflow in the branch report. */
  retention: number;
  /** Runs kept in full per workflow for each open pull request. */
  prRetention: number;
  /** Runs kept per workflow in the branch report, full or slim. */
  slimRetention: number;
  /** Slim pull request runs kept per workflow across all pull requests. */
  prSlimRetention: number;
  config?: string;
  /** This deployer run's id: the `pass` of what it consumes and drops. */
  passRunId: number;
  /** The attempt of the pass's run; 1 when omitted. */
  passRunAttempt?: number;
  now: string;
  /** D63: apply every update folder under `updates` into this channel, without `pending.json` entries. */
  trust?: { channel: string };
}

export interface ApplyResult {
  changed: boolean;
  consumed: number;
  /** = `changed`, but for a base that names no deployment (a consumed-only state cannot name one). */
  deployed: boolean;
  /** Branch reports that changed. */
  previews: string[];
  /** Job keys whose updates wait for files an earlier update has not carried yet. */
  pendingJobs: string[];
  rejected: number;
}

/** D59: a run report holds at most this many bytes of partitions (a fork cannot fill the 1 GB Pages site). */
export const MAX_RUN_PARTITION_BYTES: number = 512 * 1024 * 1024;

const HOUR_MS = 3_600_000;

const toRel = (...parts: string[]): string => parts.join('/');

async function listFiles(abs: string, rel: string, out: string[]): Promise<void> {
  const st = await lstat(abs).catch(() => undefined);
  if (st === undefined) return;
  if (st.isDirectory()) {
    for (const name of (await readdir(abs)).sort()) await listFiles(join(abs, name), toRel(rel, name), out);
  } else if (st.isFile()) out.push(rel);
}

/**
 * D66: lists the files under each path (a folder's files recursively) into `deletions.json` with `pass`; removes
 * nothing. A path already listed keeps its entry. Throws, listing nothing, when a path leaves `site`.
 */
export async function scheduleDeletion(
  state: SiteState,
  site: string,
  paths: string[],
  pass: number,
): Promise<void> {
  const clean = paths.map((p) => {
    if (!isSafeRel(p))
      throw new OtelHtmlError('usage', { message: `refusing to delete ${p}: it is not inside ${site}` });
    return p;
  });
  const known = new Set(state.deletions.files.map((f) => f.path));
  for (const p of clean) {
    const found: string[] = [];
    await listFiles(join(site, ...p.split('/')), p, found);
    for (const path of found) {
      if (known.has(path)) continue;
      known.add(path);
      state.deletions.files.push({ path, pass });
    }
  }
}

/** A relative `/` path that stays inside the site. */
const isSafeRel = (p: string): boolean =>
  !p.startsWith('/') && p.split('/').every((x) => x !== '' && x !== '.' && x !== '..') && !p.includes('\\');

/** Files written again by this pass are live again: they leave the list. */
function unschedule(state: SiteState, keep: (path: string) => boolean): void {
  state.deletions.files = state.deletions.files.filter((f) => !keep(f.path));
}

/** The site-relative folder of the one report: the default branch's, else the trusted channel's, else the only branch channel's, else `branch/main`. */
function mainReportPath(pending: PendingPlan, trust: ApplyOptions['trust'], index: SiteIndex): string {
  if (pending.defaultBranch !== undefined) return `branch/${slug(pending.defaultBranch)}`;
  if (trust?.channel.startsWith('branch/') === true) return trust.channel;
  const branches = Object.entries(index.channels).filter(([, c]) => c.kind === 'branch');
  const [only] = branches;
  return branches.length === 1 && only !== undefined ? only[0] : 'branch/main';
}

const ms = (text: string | undefined): number | undefined => {
  const n = Date.parse(text ?? '');
  return Number.isNaN(n) ? undefined : n;
};

/** One update to apply, with the facts the deployer trusts: from `pending.json` (D59), or from the folder's name (D63). */
interface Candidate {
  key: string;
  name: string;
  dir: string;
  parsed: ParsedName;
  createdAt: string;
  /** Absent for a trusted folder. */
  plan?: PendingUpdate;
}
/** A candidate whose `update.json` was read and whose name it agrees with. */
interface Loaded extends Candidate {
  u: UpdateJson;
}
/** A `push` or `run`: its channel and the run's index entry (`reportPath` set). */
interface Placed extends Loaded {
  channel: { key: string; channel: Omit<Channel, 'runs'> };
  run: SiteRun;
}

/** A failed check of one update: recorded as its rejection, never stops the pass. */
class Rejection extends Error {}
const refuse = (reason: string): never => {
  throw new Rejection(reason);
};

/** The bytes of partitions a manifest lists. */
const partitionBytes = (m: {
  partitions: readonly { files: Partial<Record<string, { bytes: number }>> }[];
}): number =>
  m.partitions.reduce((n, p) => n + Object.values(p.files).reduce((k, f) => k + (f?.bytes ?? 0), 0), 0);

/** `<key>/runs/<run id>` of channel `key`. */
const reportPathOf = (key: string, runId: number): string => `${key}/runs/${runId}`;

/** A run's index entry as the site would have it from the API, for a trusted folder (D63). */
function trustedRun(u: UpdateJson, reportPath: string, conclusion: string): SiteRun {
  return {
    runId: u.runId,
    attempt: u.runAttempt,
    conclusion,
    headSha: '',
    headBranch: '',
    completedAt: u.createdAt,
    runUrl: '',
    reportPath,
    workflow: 'ci',
  };
}

function trustedChannel(key: string): { key: string; channel: Omit<Channel, 'runs'> } {
  const [kind, name = key] = key.split('/', 2);
  return kind === 'pr'
    ? { key, channel: { kind: 'pr', title: `#${name}`, headBranch: name } }
    : { key, channel: { kind: 'branch', title: name, headBranch: name } };
}

async function copyInto(fromAbs: string, toAbs: string): Promise<void> {
  await mkdir(dirname(toAbs), { recursive: true });
  await copyFile(fromAbs, toAbs);
}

/** Empty folders left by deleted files are removed up to (not including) `site`. */
async function pruneEmpty(site: string, rel: string): Promise<void> {
  for (let dir = dirname(rel); dir !== '.' && dir !== ''; dir = dirname(dir)) {
    try {
      await rmdir(join(site, ...dir.split('/')));
    } catch {
      return; // not empty, or gone
    }
  }
}

async function replaceStateDir(fs: FileSystem, from: string, to: string): Promise<void> {
  await fs.removeDir(to);
  await fs.mkdirp(to);
  for (const name of await fs.list(from)) {
    if ((await fs.entryKind(`${from}/${name}`)) === 'file')
      await fs.writeTextAtomic(`${to}/${name}`, await fs.readText(`${from}/${name}`));
  }
}

export async function applyUpdates(o: ApplyOptions, deps: WriterDeps, io: CliIo): Promise<ApplyResult> {
  const { fs } = deps;
  const stateDir = `${o.site}/${SITE_STATE_DIR}`;
  const nowMs = ms(o.now) ?? Date.now();
  const warn = (m: string): void => warning(io, 'deploy', m);

  // (1) the state
  // an absent --state folder (the plan found no state to write) keeps the base's own site-state/
  if (o.state !== undefined && (await fs.exists(o.state))) await replaceStateDir(fs, o.state, stateDir);
  const state = await readSiteState(fs, stateDir, warn);
  const consumedBefore = new Set(Object.keys(state.applied.updates));
  const { pending } = o;

  let changed = false;
  let consumed = 0;
  let rejected = 0;
  const previews: string[] = [];
  const pendingJobs: string[] = [];
  const left: string[] = [];
  const record = (c: Candidate, outcome: UpdateOutcome, why?: string): void => {
    state.applied.updates[c.key] = { outcome, createdAt: c.createdAt, pass: o.passRunId };
    consumed++;
    if (outcome === 'rejected') {
      rejected++;
      warn(`${c.name}: rejected${why === undefined ? '' : ` (${why})`}`);
    }
  };
  const rejectOrRethrow = (c: Candidate, e: unknown): void => {
    if (!(e instanceof Rejection || e instanceof OtelHtmlError)) throw e;
    record(c, 'rejected', messageOf(e));
  };

  // (2) the candidates
  const candidates: Candidate[] = [];
  if (o.trust !== undefined) {
    for (const name of (await fs.list(o.updates)).sort()) {
      const parsed = parseUpdateName(name);
      if (parsed === undefined || (await fs.entryKind(`${o.updates}/${name}`)) !== 'dir') {
        warn(`${name}: not an update folder, skipped`);
        continue;
      }
      candidates.push({ key: name, name, dir: `${o.updates}/${name}`, parsed, createdAt: o.now });
    }
  } else {
    for (const p of pending.updates) {
      const c: Candidate = {
        key: String(p.id),
        name: p.name,
        dir: `${o.updates}/${p.name}`,
        parsed: p.parsed,
        createdAt: p.createdAt,
        plan: p,
      };
      if (consumedBefore.has(c.key)) continue;
      if (p.retry === true) {
        left.push(p.createdAt);
        continue;
      }
      if (!p.accepted) {
        record(c, 'rejected', p.reason ?? 'rejected by the plan');
        continue;
      }
      candidates.push(c);
    }
  }

  // (3) read and check each update: the name, the tree, and the facts the plan vouched for
  const prUpdates: Loaded[] = [];
  const placedUpdates: Placed[] = [];
  for (const c of candidates) {
    try {
      const u = await readUpdate(fs, c.dir);
      if (!nameMatches(c.parsed, u)) refuse('update.json disagrees with the update name');
      if (u.kind === 'remove-pr' || u.kind === 'reopen-pr') {
        prUpdates.push({ ...c, u });
        continue;
      }
      const { plan } = c;
      let channel: Placed['channel'];
      let run: SiteRun;
      if (plan === undefined) {
        channel = trustedChannel((o.trust ?? refuse('not a trusted folder')).channel);
        run = trustedRun(u, reportPathOf(channel.key, u.runId), u.kind === 'run' ? 'success' : IN_PROGRESS);
      } else {
        if (u.kind === 'push') {
          if (u.runId !== plan.uploader.runId)
            refuse(`names run ${u.runId}, uploaded by run ${plan.uploader.runId}`);
          if (plan.run === null || u.runAttempt > plan.run.attempt)
            refuse(`names attempt ${u.runAttempt}, but the run is at attempt ${plan.run?.attempt ?? 0}`);
          if (plan.jobAttempt !== undefined && u.runAttempt !== plan.jobAttempt)
            refuse(`job ${String(u.jobId)} belongs to attempt ${plan.jobAttempt}, not ${u.runAttempt}`);
        }
        if (u.kind === 'run' && plan.run !== null && u.runAttempt > plan.run.attempt)
          refuse(`names attempt ${u.runAttempt}, but run ${u.runId} is at attempt ${plan.run.attempt}`);
        if (plan.channel === null || plan.run === null) return refuse('no channel');
        channel = plan.channel;
        run = { ...stripEvent(plan.run), reportPath: reportPathOf(channel.key, u.runId) };
        // recorded values are the run without its in-graph jobs (what the report shows): they win over the API's
        if (u.kind === 'run' && u.conclusion !== undefined) {
          run.conclusion = u.conclusion;
          run.attempt = u.runAttempt;
          if (u.completedAt !== undefined) run.completedAt = u.completedAt;
        }
      }
      if (u.kind === 'run') await checkRunReport(fs, `${c.dir}/report`);
      placedUpdates.push({ ...c, u, channel, run });
    } catch (e) {
      rejectOrRethrow(c, e);
    }
  }
  const byTime = (a: Candidate, b: Candidate): number =>
    (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0) || a.key.localeCompare(b.key);

  let index = await readSiteIndex(o.site, warn);
  const mainPath = mainReportPath(pending, o.trust, index);
  const mainDir = join(o.site, ...mainPath.split('/'));
  const mainBase = assetsBaseFor(mainPath);
  const resolved = withBranchDefault(
    await resolveApiConfig(deps, o.config, undefined, { format: 'site', assetsBase: mainBase }),
    pending.defaultBranch ?? mainPath.slice('branch/'.length),
  );
  const links = { dashboard: dashboardIds(resolved).dashboard };
  const commitIndex = async (): Promise<void> => writeSite(o.site, index, o.repository, links);
  const prRemoved = (c: Placed): boolean => {
    if (c.channel.channel.kind !== 'pr') return false;
    return c.channel.key.slice(3) in state.removed.prs;
  };

  /** Schedules `paths` for deletion; a run report among them is gone, so its bookkeeping goes (a re-sent update must not meet it). */
  const scheduleRemoval = async (site: string, paths: string[]): Promise<void> => {
    await scheduleDeletion(state, site, paths, o.passRunId);
    for (const key of Object.keys(state.runs.runs))
      if (paths.some((p) => key === p || key.startsWith(`${p}/`))) delete state.runs.runs[key];
  };
  const mainFiles = (rel: string[]): string[] => rel.map((f) => toRel(mainPath, f));

  const migrateSite = async (): Promise<boolean> => {
    const manifestFile = join(mainDir, MANIFEST_PATH);
    const fingerprint = async (): Promise<string> =>
      JSON.stringify([
        index,
        state.deletions.files.length,
        (await fs.exists(manifestFile)) ? await fs.readText(manifestFile) : '',
      ]);
    const moved = (await migrateAssetsBases(o.site, deps, warn)).length > 0;
    const before = await fingerprint();
    const legacy = dropWorkflowChannels(index);
    index = legacy.index;
    // a legacy channel named like a shared folder must not take the site's own files with it
    await scheduleRemoval(
      o.site,
      legacy.remove.filter((p) => p !== 'assets' && p !== SITE_STATE_DIR),
    );
    const migrated = await migrateToOneReport({
      site: o.site,
      index,
      reportPath: mainPath,
      deps,
      warn,
      remove: scheduleRemoval,
    });
    index = migrated.index;
    // folders still on disk (deferred deletion) are listed again, but nothing new is
    return moved || (await fingerprint()) !== before;
  };

  // (3.5) a site laid out as before the one report moves to it; what that leaves behind is scheduled
  if (await migrateSite()) {
    changed = true;
    await commitIndex();
  }

  // (4) remove-pr and reopen-pr, by time
  for (const c of [...prUpdates].sort(byTime)) {
    const pr = c.u.pr ?? 0;
    if (c.u.kind === 'reopen-pr') {
      delete state.removed.prs[String(pr)];
      const reopened = reopenPullRequest(index, pr);
      index = reopened.index;
      if (reopened.changed) changed = true;
    } else {
      state.removed.prs[String(pr)] = { runId: c.u.runId, at: o.now };
      const closedNow = closePullRequest(index, pr, o.now);
      index = closedNow.index;
      if (closedNow.changed) changed = true;
      // a pull request folder of the layout before the one report (and a push staging folder in it)
      if (await fs.exists(join(o.site, 'pr', String(pr)))) {
        await scheduleRemoval(o.site, [`pr/${pr}`]);
        changed = true;
      }
    }
    await commitIndex();
    record(c, 'applied');
  }

  // (5) push, one sync per run and job
  const pushes = placedUpdates.filter((l) => l.u.kind === 'push');
  const completeAtStart = new Map<string, { complete: boolean; attempt: number }>();
  let pushConfig: ResolvedConfig | undefined;
  const groups = new Map<string, Placed[]>();
  for (const c of pushes) {
    if (prRemoved(c)) {
      record(c, 'removed-pr');
      continue;
    }
    const jobKey = c.parsed.kind === 'push' ? c.parsed.jobKey : '';
    const k = `${c.run.reportPath}\n${jobKey}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  for (const group of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g)) {
    const first = group[0];
    if (first === undefined || first.parsed.kind !== 'push') continue;
    const { jobKey } = first.parsed;
    const { reportPath } = first.run;
    const runDir = join(o.site, ...reportPath.split('/'));
    try {
      const indexed = index.channels[first.channel.key]?.runs.find((r) => r.runId === first.run.runId);
      let seen = completeAtStart.get(reportPath);
      if (seen === undefined) {
        const m = indexed === undefined ? null : await readRunManifest(fs, runDir);
        seen = {
          // a run the index says is finished is complete, whatever its staging folder (awaiting deletion) says
          complete: m?.complete === true || (indexed !== undefined && indexed.conclusion !== IN_PROGRESS),
          attempt: Math.max(state.runs.runs[reportPath]?.attempt ?? 0, indexed?.attempt ?? 0),
        };
        completeAtStart.set(reportPath, seen);
      }
      const live: Placed[] = [];
      for (const c of group) {
        if (seen.complete && c.u.runAttempt <= seen.attempt) record(c, 'superseded');
        else live.push(c);
      }
      if (live.length === 0) continue;

      const attempt = Math.max(...live.map((c) => c.u.runAttempt));
      const known = state.runs.runs[reportPath] ?? emptyRunState(attempt);
      const runState: RunReportState = {
        ...known,
        next: Math.max(known.next, await diskNext(runDir)),
      };
      const assetsBase = assetsBaseFor(reportPath);
      // a finished run's staging folder is awaiting deletion: a re-run starts it over
      const staged = indexed !== undefined && indexed.conclusion === IN_PROGRESS;
      let manifest = staged ? await readRunManifest(fs, runDir) : null;
      if (manifest === null) {
        pushConfig ??= await resolveApiConfig(deps, o.config, undefined, { format: 'site', assetsBase });
        manifest = newRunManifest({
          title: `run ${first.run.runId}`,
          createdAt: o.now,
          assetsBase,
          config: pushConfig,
          version: deps.version,
        });
      }
      const updates: JobUpdate[] = live.map((c) => ({ dir: c.dir, update: c.u }));
      const jobName = first.plan?.jobName ?? live.find((c) => c.u.jobName !== undefined)?.u.jobName ?? jobKey;
      const plan = planSync({ manifest, state: runState, jobKey, jobName, attempt, updates, now: o.now });

      if (plan.outcome === 'pending') {
        pendingJobs.push(jobKey);
        left.push(...live.map((c) => c.createdAt));
        continue;
      }
      if (plan.outcome === 'stale') {
        for (const c of live) record(c, 'superseded');
        continue;
      }
      if (plan.outcome === 'applied') {
        if (partitionBytes(plan.manifest) > MAX_RUN_PARTITION_BYTES) {
          for (const c of live) record(c, 'rejected', 'too large');
          continue;
        }
        for (const m of plan.copies)
          await copyInto(join(m.fromDir, m.from), join(runDir, ...m.to.split('/')));
        await writeRunReport(deps, runDir, plan.manifest);
        await scheduleDeletion(
          state,
          o.site,
          plan.drops.map((d) => toRel(reportPath, d)),
          o.passRunId,
        );
        const written = [
          ...plan.copies.map((m) => toRel(reportPath, m.to)),
          ...['index.html', '.nojekyll', MANIFEST_PATH].map((f) => toRel(reportPath, f)),
        ];
        unschedule(state, (p) => written.includes(p));
        state.runs.runs[reportPath] = plan.state;
        index = placeRun(index, first.channel.key, first.channel.channel, {
          ...first.run,
          attempt,
          conclusion: IN_PROGRESS,
          reportPath,
        });
        await commitIndex();
        changed = true;
      }
      for (const c of live) record(c, 'applied');
    } catch (e) {
      if (!(e instanceof OtelHtmlError)) throw e;
      for (const c of group) if (!(c.key in state.applied.updates)) record(c, 'rejected', messageOf(e));
    }
  }

  // (6) run, by time: its partitions join the one report
  const published = new Set<number>();
  let mainChanged = false;
  let mainNext = state.runs.runs[mainPath]?.next ?? 0;
  for (const c of placedUpdates.filter((l) => l.u.kind === 'run').sort(byTime)) {
    if (prRemoved(c)) {
      record(c, 'removed-pr');
      continue;
    }
    const stagingPath = c.run.reportPath;
    const indexed = index.channels[c.channel.key]?.runs.find((r) => r.runId === c.run.runId);
    const known = state.runs.runs[stagingPath];
    if (c.u.runAttempt < Math.max(known?.attempt ?? 0, indexed?.attempt ?? 0)) {
      record(c, 'superseded');
      continue;
    }
    const deletionsBefore = [...state.deletions.files];
    const runsBefore = structuredClone(state.runs);
    try {
      const ensured = await ensureMainReport(deps, mainDir, resolved, { now: o.now, assetsBase: mainBase });
      const added = await addRunReport(
        deps,
        mainDir,
        `${c.dir}/report`,
        { runId: c.u.runId, attempt: c.u.runAttempt },
        { now: o.now, next: Math.max(mainNext, await diskNext(mainDir)) },
      );
      await scheduleDeletion(state, o.site, mainFiles(added.dropped), o.passRunId);
      if (await fs.exists(join(o.site, ...stagingPath.split('/'))))
        await scheduleRemoval(o.site, [stagingPath]);
      const written = new Set(mainFiles([...ensured, ...added.written]));
      unschedule(state, (p) => written.has(p));
      mainNext = added.next;
      state.runs.runs[mainPath] = { next: mainNext, attempt: 0, jobs: {} };
      index = placeRun(index, c.channel.key, c.channel.channel, {
        ...c.run,
        reportPath: mainPath,
        detail: 'full',
        ...(c.u.reportUrl === undefined ? {} : { reportUrl: c.u.reportUrl }),
      });
      published.add(c.u.runId);
      mainChanged = true;
      changed = true;
      record(c, 'applied');
    } catch (e) {
      if (!(e instanceof OtelHtmlError)) throw e;
      // nothing the failed update scheduled stands: its files are still live
      state.deletions.files = deletionsBefore;
      state.runs = runsBefore;
      record(c, 'rejected', messageOf(e));
    }
  }

  // (6b) the tiers, every pass: older runs turn slim or leave the report
  const tiers = applyTiers(
    index,
    { full: o.retention, slim: o.slimRetention, prFull: o.prRetention, prSlim: o.prSlimRetention },
    published,
  );
  const held = (runId: number): boolean =>
    Object.values(tiers.index.channels).some((ch) => ch.runs.some((r) => r.runId === runId));
  const reshaped = async (r: { written: string[]; dropped: string[]; next: number }): Promise<void> => {
    await scheduleDeletion(state, o.site, mainFiles(r.dropped), o.passRunId);
    const keep = new Set(mainFiles(r.written));
    unschedule(state, (p) => keep.has(p));
    mainNext = r.next;
    state.runs.runs[mainPath] = { next: mainNext, attempt: 0, jobs: {} };
    mainChanged ||= r.written.length > 0 || r.dropped.length > 0;
  };
  for (const { run } of tiers.drop) {
    if (held(run.runId)) continue; // another channel still lists it
    try {
      await reshaped(await removeRun(deps, mainDir, run.runId, { now: o.now }));
    } catch (e) {
      if (!(e instanceof OtelHtmlError)) throw e;
      warn(`run ${run.runId}: not dropped from ${mainPath}: ${messageOf(e)}`);
    }
  }
  const stayFull = new Set<number>();
  for (const runId of new Set(tiers.trim.map((t) => t.run.runId))) {
    const attempt = tiers.trim.find((t) => t.run.runId === runId)?.run.attempt ?? 1;
    try {
      await reshaped(
        await trimRun(deps, mainDir, { runId, attempt }, resolved, { now: o.now, next: mainNext }),
      );
    } catch (e) {
      if (!(e instanceof OtelHtmlError)) throw e;
      warn(`run ${runId}: not trimmed in ${mainPath}, kept in full: ${messageOf(e)}`);
      stayFull.add(runId);
    }
  }
  const tiered: SiteIndex = {
    ...tiers.index,
    channels: Object.fromEntries(
      Object.entries(tiers.index.channels).map(([key, ch]) => [
        key,
        stayFull.size === 0
          ? ch
          : {
              ...ch,
              runs: ch.runs.map((r) => (stayFull.has(r.runId) ? { ...r, detail: 'full' as const } : r)),
            },
      ]),
    ),
  };
  const retiered = JSON.stringify(tiered) !== JSON.stringify(index);
  index = tiered;
  if (retiered) changed = true;
  if (retiered || mainChanged) await commitIndex();
  const mainChannel = index.channels[mainPath];
  if (mainChanged && mainChannel !== undefined) await writeBadges(o.site, mainPath, mainChannel);
  if (mainChanged) {
    previews.push(mainPath);
    changed = true;
  }

  // (7) the deletions that are due
  const baseLiveAt = pending.base.liveAt;
  state.deletions.files = state.deletions.files.map((f) =>
    f.pass === pending.base.runId && baseLiveAt !== undefined ? { ...f, liveAt: baseLiveAt } : f,
  );
  const due = state.deletions.files.filter((f) => {
    const at = ms(f.liveAt);
    return at !== undefined && at + DELETION_GRACE_MS <= nowMs;
  });
  for (const f of due.filter((d) => !isSafeRel(d.path)))
    warn(`${f.path}: not a site path, dropped from deletions.json`);
  if (due.length > 0) {
    const safe = due.filter((f) => isSafeRel(f.path));
    await removePaths(
      o.site,
      safe.map((f) => f.path),
    );
    for (const f of safe) await pruneEmpty(o.site, f.path);
    const gone = new Set(due.map((f) => f.path));
    state.deletions.files = state.deletions.files.filter((f) => !gone.has(f.path));
    changed = true;
  }

  // (8) record
  if (changed) {
    await ensureSharedAssets(o.site, deps);
    // an asset scheduled while nothing referenced it is live again once a report does
    const referenced = await referencedAssets(o.site, deps, warn);
    if (referenced !== null) {
      const prefixes = [...referenced].filter((p) => p.endsWith('/'));
      unschedule(state, (p) => referenced.has(p) || prefixes.some((x) => p.startsWith(x)));
    }
    await scheduleDeletion(state, o.site, await pruneAssets(o.site, deps, warn, referenced), o.passRunId);
  }
  const noBase = pending.base.deploymentId === undefined;
  if (!changed && consumed === 0)
    return { changed, consumed, deployed: false, previews, pendingJobs, rejected };
  const deployed = changed || noBase;
  const runAttempt = o.passRunAttempt ?? 1;
  const form: StateForm = deployed
    ? { kind: 'full', runId: o.passRunId, runAttempt }
    : { kind: 'consumed', base: pending.base.deploymentId ?? 0, runAttempt };
  const oldest = Math.min(...left.map((t) => ms(t) ?? Number.POSITIVE_INFINITY));
  state.applied = {
    ...state.applied,
    form,
    floor: new Date((Number.isFinite(oldest) ? oldest : nowMs) - HOUR_MS).toISOString(),
    writtenAt: o.now,
  };
  state.files = await scanFiles(fs, o.site);
  await writeSiteState(fs, stateDir, state);
  return { changed, consumed, deployed, previews, pendingJobs, rejected };
}

/** The index entry of a pending update's run, without the `event` the plan keeps beside it. */
function stripEvent(run: SiteRun & { event: string }): SiteRun {
  const { event: _event, ...rest } = run;
  return rest;
}

/** A `run` update's report must be a partition report (format 5 or 6) whose listed files are in the update. */
async function checkRunReport(fs: FileSystem, dir: string): Promise<void> {
  let manifest: Awaited<ReturnType<typeof readRunManifest>>;
  try {
    manifest = await readRunManifest(fs, dir);
  } catch (e) {
    return refuse(`report: ${messageOf(e)}`);
  }
  if (manifest === null) return refuse('report has no data/manifest.js');
  for (const p of manifest.partitions)
    for (const f of Object.values(p.files))
      if ((await fs.entryKind(`${dir}/${f.path}`)) !== 'file') refuse(`report lacks ${f.path}`);
}
