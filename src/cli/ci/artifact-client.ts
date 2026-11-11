import { createHash } from 'node:crypto';
import { OtelHtmlError } from '../../model/errors.js';
import type { FileSystem } from '../../writer/ports.js';
import type { Fetch } from './github-api.js';
import { storedZip } from './zip.js';

export interface ArtifactEnv {
  ACTIONS_RUNTIME_TOKEN?: string | undefined;
  ACTIONS_RESULTS_URL?: string | undefined;
}

/** D51: a zip above this is refused rather than block-uploaded. */
export const MAX_UPLOAD_BYTES: number = 256 * 1024 * 1024;

/** The client version `@actions/toolkit` sends (builder check 3). */
const CLIENT_VERSION = 7;
const SERVICE = '/twirp/github.actions.results.api.v1.ArtifactService/';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRIES = 5;
const CALL_TIMEOUT_MS = 120_000;
const DAY_MS = 86_400_000;

const usage = (message: string): OtelHtmlError => new OtelHtmlError('usage', { message });

/** The two backend ids in the runtime token's `scp` claim: `Actions.Results:<run>:<job>`. */
export function backendIds(token: string): { workflowRunBackendId: string; workflowJobRunBackendId: string } {
  let scp: unknown;
  try {
    const payload = token.split('.')[1] ?? '';
    scp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { scp?: unknown }).scp;
  } catch {
    throw usage('ACTIONS_RUNTIME_TOKEN is not a JWT');
  }
  for (const part of typeof scp === 'string' ? scp.split(/\s+/) : []) {
    const m = /^Actions\.Results:([^:\s]+):([^:\s]+)$/.exec(part);
    if (m?.[1] !== undefined && m[2] !== undefined)
      return { workflowRunBackendId: m[1], workflowJobRunBackendId: m[2] };
  }
  throw usage('ACTIONS_RUNTIME_TOKEN has no Actions.Results scope');
}

/** One request, retried on 429/5xx with 1, 2, 4, 8 and 16 s pauses; any other non-2xx answer throws at once. */
async function send(
  what: string,
  fetchFn: Fetch,
  sleep: (ms: number) => Promise<void>,
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (e) {
      // A connection reset or timeout: retried like a 5xx.
      if (attempt >= RETRIES)
        throw new Error(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res;
    if (!RETRYABLE.has(res.status) || attempt >= RETRIES) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`${what} answered ${res.status}${detail === '' ? '' : `: ${detail}`}`);
    }
    await sleep(1000 * 2 ** attempt);
  }
}

/** A Twirp JSON reply; the service may use the proto field names or their lowerCamel JSON names. */
interface TwirpReply {
  ok?: unknown;
  signedUploadUrl?: unknown;
  signed_upload_url?: unknown;
  artifactId?: unknown;
  artifact_id?: unknown;
}

/** CreateArtifact, then one block-blob PUT of the zip, then FinalizeArtifact; returns the artifact id. */
export async function uploadArtifact(o: {
  name: string;
  zip: Uint8Array;
  retentionDays?: number;
  env: ArtifactEnv;
  now: () => number;
  fetchFn?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ id: number; size: number }> {
  if (o.zip.length > MAX_UPLOAD_BYTES)
    throw usage(`the artifact is ${o.zip.length} bytes; the limit is ${MAX_UPLOAD_BYTES} (256 MiB)`);
  const token = o.env.ACTIONS_RUNTIME_TOKEN;
  const origin = o.env.ACTIONS_RESULTS_URL;
  if (!token || !origin)
    throw usage('ACTIONS_RUNTIME_TOKEN and ACTIONS_RESULTS_URL are set only for JavaScript actions');
  const ids = backendIds(token);
  const fetchFn = o.fetchFn ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const twirp = async (method: string, body: object): Promise<TwirpReply> => {
    const res = await send(method, fetchFn, sleep, `${origin.replace(/\/$/, '')}${SERVICE}${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as TwirpReply;
    if (json.ok !== true) throw new Error(`${method} answered ok: ${String(json.ok)}`);
    return json;
  };
  const created = await twirp('CreateArtifact', {
    ...ids,
    name: o.name,
    version: CLIENT_VERSION,
    // StringValue wrappers serialize as plain strings in proto3 JSON.
    mimeType: 'application/zip',
    ...(o.retentionDays === undefined
      ? {}
      : { expiresAt: new Date(o.now() + o.retentionDays * DAY_MS).toISOString() }),
  });
  // A Twirp JSON reply may use the proto field names or their lowerCamel JSON names; the toolkit accepts both.
  const signed = created.signedUploadUrl ?? created.signed_upload_url;
  if (typeof signed !== 'string' || signed === '')
    throw new Error(`CreateArtifact gave no signedUploadUrl (fields: ${Object.keys(created).join(', ')})`);
  await send('the blob upload', fetchFn, sleep, signed, {
    method: 'PUT',
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': 'application/zip',
      'content-type': 'application/zip',
    },
    body: o.zip as Uint8Array<ArrayBuffer>,
  });
  const done = await twirp('FinalizeArtifact', {
    ...ids,
    name: o.name,
    size: String(o.zip.length),
    hash: `sha256:${createHash('sha256').update(o.zip).digest('hex')}`,
  });
  const id = Number(done.artifactId ?? done.artifact_id);
  if (!Number.isSafeInteger(id))
    throw new Error(`FinalizeArtifact gave no artifactId (fields: ${Object.keys(done).join(', ')})`);
  return { id, size: o.zip.length };
}

/** The files under `dir` (recursive, relative names with `/`) as a stored zip. */
export async function zipDirectory(fs: FileSystem, dir: string): Promise<Uint8Array> {
  const files: { name: string; bytes: Uint8Array; mtime: Date }[] = [];
  const mtime = new Date();
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const entry of (await fs.list(abs)).sort()) {
      const path = `${abs.replace(/\/$/, '')}/${entry}`;
      const name = rel === '' ? entry : `${rel}/${entry}`;
      const kind = await fs.entryKind(path);
      if (kind === 'dir') await walk(path, name);
      else if (kind === 'file') files.push({ name, bytes: await fs.readBytes(path), mtime });
    }
  };
  await walk(dir, '');
  return storedZip(files);
}
