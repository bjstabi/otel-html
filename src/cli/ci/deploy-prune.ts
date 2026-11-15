import { OtelHtmlError } from '../../model/errors.js';
import type { FileSystem } from '../../writer/ports.js';
import { isDeploymentRunTrusted, listDeployments, successfulDeployments } from './deploy-plan.js';
import {
  type ApiRun,
  deleteJson,
  type Fetch,
  fetchArtifacts,
  getJson,
  getJsonIfFound,
  messageOf,
} from './github-api.js';
import { type AppliedJson, FilesSchema, parsePagesName, parseStateName, STATE_PREFIX } from './site-state.js';
import { UPDATE_PREFIX } from './update.js';

const API_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 120_000;
/** GitHub Pages serves at most 1 GiB. */
const MAX_LIVE_BYTES = 1024 * 1024 * 1024;
const MAX_LIVE_FILES = 100_000;

/**
 * §5.3 step 6: keeps the `github-pages` and `otel-html-site-state-*` artifacts of the newest `keep` successful deployments
 * and deletes older ones (a failed pass's too); deletes the update artifacts whose `applied.updates[id].pass` went live at
 * or before the oldest kept deployment (that deployment's own applied.json lists everything consumed at or before its
 * pass, so falling back to it never meets an update that is gone). Passes order by time, not run id: a re-run or a long
 * run deploys after runs with higher ids. Only trusted runs' deployments count (`isDeploymentRunTrusted`). Returns
 * what it deleted; a failed delete is a warning. With fewer than `keep` successful deployments nothing is deleted.
 */
export async function pruneArtifacts(
  o: {
    apiUrl?: string;
    repository: string;
    keep: number;
    applied: AppliedJson;
    token?: string;
    now: string;
    current?: { runId: number; runAttempt: number };
    /** The workflow files whose trusted runs may deploy, and the legacy deployer's files. */
    ciWorkflows: string[];
    deployerWorkflows: string[];
  },
  fetchFn: Fetch,
  warn: (m: string) => void,
): Promise<{ deleted: number[] }> {
  const apiUrl = o.apiUrl ?? 'https://api.github.com';
  const repo = `${apiUrl}/repos/${o.repository}`;
  const get = async <T>(url: string): Promise<T> =>
    (await getJson<T>(url, o.token, API_TIMEOUT_MS, fetchFn)).body;
  const getIfFound = <T>(url: string): Promise<T | undefined> =>
    getJsonIfFound<T>(url, o.token, API_TIMEOUT_MS, fetchFn);
  const nowMs = Date.parse(o.now);
  const runs = new Map<number, Promise<ApiRun | undefined>>();
  const getRun = (id: number): Promise<ApiRun | undefined> => {
    let p = runs.get(id);
    if (p === undefined) {
      p = getIfFound<ApiRun>(`${repo}/actions/runs/${id}`);
      runs.set(id, p);
    }
    return p;
  };
  const defaultBranch = (await get<{ default_branch: string }>(repo)).default_branch;
  const listed = await fetchArtifacts(
    { apiUrl, repository: o.repository },
    o.token,
    API_TIMEOUT_MS,
    () => false,
    fetchFn,
  );
  // a deployment counts only when its run uploaded the site (every job naming the environment has a deployment)
  const siteRuns = new Set<string>();
  for (const a of listed) {
    if (Date.parse(a.expires_at) <= nowMs || a.workflow_run?.id === undefined) continue;
    const form = parseStateName(a.name);
    const attempt =
      form?.kind === 'full' && form.runId === a.workflow_run.id ? form.runAttempt : parsePagesName(a.name);
    if (attempt !== undefined) siteRuns.add(`${a.workflow_run.id}/${attempt}`);
  }
  const kept: { runId: number; liveMs: number }[] = [];
  for await (const d of successfulDeployments(get, getIfFound, repo, await listDeployments(get, repo), {
    ...(o.current === undefined ? {} : { current: o.current }),
    nowMs,
    trusted: async (id) =>
      isDeploymentRunTrusted(await getRun(id), {
        repository: o.repository,
        defaultBranch,
        ciWorkflows: o.ciWorkflows,
        deployerWorkflows: o.deployerWorkflows,
      }),
    hasSite: async (run, attempt) => siteRuns.has(`${run}/${attempt}`),
  })) {
    kept.push({ runId: d.runId, liveMs: Date.parse(d.liveAt) });
    if (kept.length >= o.keep) break;
  }
  if (kept.length < o.keep || o.keep < 1) return { deleted: [] };
  // the oldest kept deployment by when it went live (not by run id)
  const oldest = kept.reduce((a, b) => (b.liveMs < a.liveMs ? b : a));
  const keptRuns = new Set(kept.map((k) => k.runId));
  // when a pass ran: its deployment's time, else its newest artifact's upload (a pass with neither is judged by run id)
  const passMs = new Map<number, number>(kept.map((k) => [k.runId, k.liveMs]));
  for (const a of listed) {
    const run = a.workflow_run?.id;
    const at = Date.parse(a.created_at);
    if (run !== undefined && !passMs.has(run) && !Number.isNaN(at))
      passMs.set(run, Math.max(passMs.get(run) ?? at, at));
  }
  const passAtOrBeforeOldest = (pass: number): boolean => {
    const at = passMs.get(pass);
    return at === undefined ? pass <= oldest.runId : at <= oldest.liveMs;
  };

  const doomed: number[] = [];
  for (const a of listed) {
    if (Date.parse(a.expires_at) <= nowMs) continue;
    if (a.name.startsWith(UPDATE_PREFIX)) {
      const entry = o.applied.updates[String(a.id)];
      if (entry !== undefined && passAtOrBeforeOldest(entry.pass)) doomed.push(a.id);
    } else if (parsePagesName(a.name) !== undefined || a.name.startsWith(STATE_PREFIX)) {
      const run = a.workflow_run?.id;
      if (run !== undefined && !keptRuns.has(run) && Date.parse(a.created_at) < oldest.liveMs)
        doomed.push(a.id);
    }
  }
  const deleted: number[] = [];
  for (const id of doomed) {
    try {
      await deleteJson(`${repo}/actions/artifacts/${id}`, o.token, API_TIMEOUT_MS, fetchFn);
      deleted.push(id);
    } catch (e) {
      warn(`could not delete artifact ${id}: ${messageOf(e)}`);
    }
  }
  return { deleted };
}

const bad = (path: string, message: string): OtelHtmlError =>
  new OtelHtmlError('invalid-report', { path, message });

/** A listed path is relative, forward-slashed, free of `.`/`..`/empty segments, and not in the state folder. */
function safePath(p: string): boolean {
  if (p === '' || p.includes('\\') || p.includes('\0') || p.startsWith('/')) return false;
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return false;
  return parts[0] !== 'site-state';
}

/** Cold start (§5.3 base 2): GETs `<pagesUrl>/site-state/files.json` and every listed path into `out`; fails `invalid-report` when a file is missing or its size differs. */
export async function fetchLiveSite(
  o: { pagesUrl: string; out: string },
  fs: FileSystem,
  fetchFn: Fetch,
): Promise<{ files: number; bytes: number }> {
  const root = o.pagesUrl.replace(/\/+$/, '');
  const get = async (path: string, timeoutMs: number): Promise<Response> => {
    const res = await fetchFn(`${root}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw bad(path, `the live site answered ${res.status}`);
    return res;
  };
  let parsed: ReturnType<typeof FilesSchema.safeParse>;
  try {
    parsed = FilesSchema.safeParse(await (await get('site-state/files.json', API_TIMEOUT_MS)).json());
  } catch (e) {
    if (e instanceof OtelHtmlError) throw e;
    throw bad('site-state/files.json', `is not JSON (${messageOf(e)})`);
  }
  if (!parsed.success)
    throw bad('site-state/files.json', parsed.error.issues[0]?.message ?? 'is not a files listing');
  const entries = Object.entries(parsed.data.files);
  if (entries.length === 0) throw bad('site-state/files.json', 'the live site lists no files');
  if (entries.length > MAX_LIVE_FILES) throw bad('files.json', `lists more than ${MAX_LIVE_FILES} files`);
  let total = 0;
  for (const [path, size] of entries) {
    if (!safePath(path)) throw bad(path, 'unsafe path in files.json');
    total += size;
  }
  if (total > MAX_LIVE_BYTES) throw bad('files.json', `lists more than ${MAX_LIVE_BYTES} bytes`);

  await fs.removeDir(o.out);
  await fs.mkdirp(o.out);
  let bytes = 0;
  for (const [path, size] of entries) {
    const res = await get(path, FILE_TIMEOUT_MS);
    if (Number(res.headers.get('content-length') ?? 0) > size)
      throw bad(path, `larger than the listed ${size} bytes`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length !== size) throw bad(path, `is ${data.length} bytes, files.json says ${size}`);
    const target = `${o.out}/${path}`;
    try {
      await fs.mkdirp(target.slice(0, target.lastIndexOf('/')));
      await fs.writeBytes(target, data);
    } catch (e) {
      throw bad(path, `cannot be written (${messageOf(e)})`);
    }
    bytes += data.length;
  }
  return { files: entries.length, bytes };
}
