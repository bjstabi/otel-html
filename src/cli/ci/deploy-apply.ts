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
import {
  emptyRunState,
  type JobUpdate,
  newRunManifest,
  planSync,
  type RunReportState,
  readRunManifest,
  writeRunReport,
} from './run-report.js';
import { type Channel, IN_PROGRESS, placeRun, type SiteRun } from './site.js';
import { ensureSharedAssets, readSiteIndex, removePaths, writeSite } from './site-io.js';
import { placeFinishedRun, removePullRequest } from './site-main.js';
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
  retention: number;
  prRetention: number;
  config?: string;
  /** This deployer run's id: the `pass` of what it consumes and drops. */
  passRunId: number;
  now: string;
  /** D63: apply every update folder under `updates` into this channel, without `pending.json` entries. */
  trust?: { channel: string };
}

export interface ApplyResult {
  changed: boolean;
  consumed: number;
  /** = `changed`, but for a base that names no deployment (a consumed-only state cannot name one). */
  deployed: boolean;
  /** Branch channels whose rolling report was rebuilt. */
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

/** One above the highest `data/partitions/<p6>/` folder (the high-water mark, including folders awaiting deletion). */
async function diskNext(runDir: string): Promise<number> {
  let next = 0;
  for (const name of await readdir(join(runDir, 'data', 'partitions')).catch(() => [] as string[])) {
    if (/^\d+$/.test(name)) next = Math.max(next, Number(name) + 1);
  }
  return next;
}

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
  if (o.state !== undefined) await replaceStateDir(fs, o.state, stateDir);
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
  const commitIndex = async (): Promise<void> => writeSite(o.site, index, o.repository);
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

  // (4) remove-pr and reopen-pr, by time
  for (const c of [...prUpdates].sort(byTime)) {
    const pr = c.u.pr ?? 0;
    if (c.u.kind === 'reopen-pr') {
      delete state.removed.prs[String(pr)];
    } else {
      state.removed.prs[String(pr)] = { runId: c.u.runId, at: o.now };
      const gone = await removePullRequest(o.site, pr, o.repository, deps, io, scheduleRemoval);
      if (gone) changed = true;
      index = await readSiteIndex(o.site, warn);
    }
    record(c, 'applied');
  }

  // (5) push, one sync per run and job
  const pushes = placedUpdates.filter((l) => l.u.kind === 'push');
  const completeAtStart = new Map<string, { complete: boolean; attempt: number }>();
  let resolved: ResolvedConfig | undefined;
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
          complete: m?.complete === true,
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
      const assetsBase = `${'../'.repeat(reportPath.split('/').length)}assets/${deps.version}/`;
      let manifest = indexed === undefined ? null : await readRunManifest(fs, runDir);
      if (manifest === null) {
        resolved ??= await resolveApiConfig(deps, o.config, undefined, { format: 'site', assetsBase });
        const top = live.reduce((a, b) => ((b.u.sequence ?? 0) > (a.u.sequence ?? 0) ? b : a));
        manifest = newRunManifest({
          title: `run ${first.run.runId}`,
          epochUnixNano: earliestNano(top.u, top.createdAt),
          createdAt: o.now,
          assetsBase,
          config: resolved,
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

  // (6) run, by time
  for (const c of placedUpdates.filter((l) => l.u.kind === 'run').sort(byTime)) {
    if (prRemoved(c)) {
      record(c, 'removed-pr');
      continue;
    }
    const { reportPath } = c.run;
    const runDir = join(o.site, ...reportPath.split('/'));
    const indexed = index.channels[c.channel.key]?.runs.find((r) => r.runId === c.run.runId);
    const known = state.runs.runs[reportPath];
    if (c.u.runAttempt < Math.max(known?.attempt ?? 0, indexed?.attempt ?? 0)) {
      record(c, 'superseded');
      continue;
    }
    try {
      const old = await readRunManifest(fs, runDir).catch(() => null);
      const oldFiles = (old?.partitions ?? []).flatMap((p) =>
        Object.values(p.files).map((f) => toRel(reportPath, f.path)),
      );
      const renumberFrom = Math.max(known?.next ?? 0, await diskNext(runDir));
      const deletionsBefore = [...state.deletions.files];
      const runsBefore = structuredClone(state.runs);
      const placed = await placeFinishedRun(o.site, c.channel, c.run, `${c.dir}/report`, {
        retention: o.retention,
        prRetention: o.prRetention,
        config: o.config,
        repository: o.repository,
        deps,
        io,
        remove: scheduleRemoval,
        renumberFrom,
      }).catch((e: unknown) => {
        // nothing the failed placement scheduled stands: its files are still live
        state.deletions.files = deletionsBefore;
        state.runs = runsBefore;
        throw e;
      });
      await scheduleDeletion(state, o.site, oldFiles, o.passRunId);
      const manifest = await readRunManifest(fs, runDir);
      const next = Math.max(renumberFrom, ...(manifest?.partitions ?? []).map((p) => p.n + 1));
      state.runs.runs[reportPath] = {
        next,
        attempt: Math.max(known?.attempt ?? 0, c.u.runAttempt),
        jobs: known?.jobs ?? {},
      };
      const written = [
        ...['index.html', '.nojekyll', MANIFEST_PATH].map((f) => toRel(reportPath, f)),
        ...(manifest?.partitions ?? []).flatMap((p) =>
          Object.values(p.files).map((f) => toRel(reportPath, f.path)),
        ),
      ];
      const channelPrefix = `${c.channel.key}/`;
      unschedule(
        state,
        (p) => written.includes(p) || (p.startsWith(channelPrefix) && !p.startsWith(`${channelPrefix}runs/`)),
      );
      index = await readSiteIndex(o.site, warn);
      if (placed.rolling === 'built' && c.channel.channel.kind === 'branch') previews.push(c.channel.key);
      changed = true;
      record(c, 'applied');
    } catch (e) {
      if (!(e instanceof OtelHtmlError)) throw e;
      record(c, 'rejected', messageOf(e));
    }
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
  if (changed) await ensureSharedAssets(o.site, deps.version, deps);
  const noBase = pending.base.deploymentId === undefined;
  if (!changed && consumed === 0)
    return { changed, consumed, deployed: false, previews, pendingJobs, rejected };
  const deployed = changed || noBase;
  const form: StateForm = deployed
    ? { kind: 'full', runId: o.passRunId }
    : { kind: 'consumed', base: pending.base.deploymentId ?? 0 };
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

/** The earliest time of the update's partitions (R127: the epoch is the report's first data), else the update's creation. */
function earliestNano(u: UpdateJson, createdAt: string): string {
  let min: bigint | undefined;
  const parts = [...(u.partitions ?? []), ...(u.ci === undefined ? [] : [u.ci])];
  for (const p of parts)
    for (const f of Object.values(p.files))
      if (f.timeMin !== null && f.timeMin !== undefined) {
        const t = BigInt(f.timeMin);
        if (min === undefined || t < min) min = t;
      }
  if (min !== undefined && min >= 0n) return min.toString();
  return (BigInt(ms(createdAt) ?? 0) * 1_000_000n).toString();
}

/** A `run` update's report must be a format 4 report whose listed files are in the update. */
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
