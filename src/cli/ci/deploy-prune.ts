import { OtelHtmlError } from '../../model/errors.js';
import type { FileSystem } from '../../writer/ports.js';
import { listDeployments, successfulDeployments } from './deploy-plan.js';
import { deleteJson, type Fetch, fetchArtifacts, getJson, messageOf } from './github-api.js';
import { type AppliedJson, FilesSchema, STATE_PREFIX, stateArtifactName } from './site-state.js';
import { UPDATE_PREFIX } from './update.js';

const API_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 120_000;
/** GitHub Pages serves at most 1 GiB. */
const MAX_LIVE_BYTES = 1024 * 1024 * 1024;
const MAX_LIVE_FILES = 100_000;

/**
 * §5.3 step 6: keeps the `github-pages` and `otel-html-site-state-*` artifacts of the newest `keep` successful deployments
 * and deletes older ones (a failed pass's too); deletes the update artifacts whose `applied.updates[id].pass` is at or
 * below the oldest kept deployment's run id (deployer run ids grow with time, and that deployment's own applied.json
 * lists everything consumed at or before its pass, so falling back to it never meets an update that is gone). Returns
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
    currentRunId?: number;
  },
  fetchFn: Fetch,
  warn: (m: string) => void,
): Promise<{ deleted: number[] }> {
  const apiUrl = o.apiUrl ?? 'https://api.github.com';
  const repo = `${apiUrl}/repos/${o.repository}`;
  const get = async <T>(url: string): Promise<T> =>
    (await getJson<T>(url, o.token, API_TIMEOUT_MS, fetchFn)).body;
  const nowMs = Date.parse(o.now);
  const listed = await fetchArtifacts(
    { apiUrl, repository: o.repository },
    o.token,
    API_TIMEOUT_MS,
    () => false,
    fetchFn,
  );
  // a deployment counts only when its run uploaded the site (every job naming the environment has a deployment)
  const siteRuns = new Set<number>();
  for (const a of listed) {
    if (Date.parse(a.expires_at) <= nowMs || a.workflow_run?.id === undefined) continue;
    if (a.name === 'github-pages' || a.name === stateArtifactName({ kind: 'full', runId: a.workflow_run.id }))
      siteRuns.add(a.workflow_run.id);
  }
  const kept: number[] = [];
  for await (const d of successfulDeployments(get, repo, await listDeployments(get, repo), {
    ...(o.currentRunId === undefined ? {} : { currentRunId: o.currentRunId }),
    nowMs,
    hasSite: async (run) => siteRuns.has(run),
  })) {
    kept.push(d.runId);
    if (kept.length >= o.keep) break;
  }
  if (kept.length < o.keep || o.keep < 1) return { deleted: [] };
  const oldest = Math.min(...kept);

  const doomed: number[] = [];
  for (const a of listed) {
    if (Date.parse(a.expires_at) <= nowMs) continue;
    if (a.name.startsWith(UPDATE_PREFIX)) {
      const entry = o.applied.updates[String(a.id)];
      if (entry !== undefined && entry.pass <= oldest) doomed.push(a.id);
    } else if (a.name === 'github-pages' || a.name.startsWith(STATE_PREFIX)) {
      const run = a.workflow_run?.id;
      if (run !== undefined && run < oldest && !kept.includes(run)) doomed.push(a.id);
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
