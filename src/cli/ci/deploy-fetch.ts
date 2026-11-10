import { OtelHtmlError } from '../../model/errors.js';
import type { FileSystem } from '../../writer/ports.js';
import { apiHeaders, type Fetch } from './github-api.js';
import { readZip } from './zip.js';

const API_TIMEOUT_MS = 15_000;
const BLOB_TIMEOUT_MS = 120_000;

const tooLarge = (maxBytes: number): OtelHtmlError =>
  new OtelHtmlError('unsupported-input', { path: 'artifact', message: `larger than ${maxBytes} bytes` });

/**
 * `GET /actions/artifacts/<id>/zip` → 302 → the signed URL (https only, no Authorization header, as for job logs),
 * read with `readZip(bytes, maxBytes)` and written under `out` (each entry a plain file; folders made). A previous,
 * partial `out` is replaced.
 */
export async function downloadArtifact(
  o: { apiUrl: string; repository: string; id: number; out: string; maxBytes: number },
  fs: FileSystem,
  token: string | undefined,
  fetchFn: Fetch,
): Promise<{ files: number; bytes: number }> {
  const url = `${o.apiUrl}/repos/${o.repository}/actions/artifacts/${o.id}/zip`;
  let res = await fetchFn(url, {
    headers: apiHeaders(token),
    redirect: 'manual',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location !== null) {
    let secure = false;
    try {
      secure = new URL(location).protocol === 'https:';
    } catch {
      // an unparsable Location is refused below
    }
    if (!secure) throw new Error(`${url} redirected to a non-https URL`);
    res = await fetchFn(location, { redirect: 'follow', signal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > o.maxBytes) throw tooLarge(o.maxBytes);
  const entries = readZip(new Uint8Array(await res.arrayBuffer()), o.maxBytes);

  await fs.removeDir(o.out);
  await fs.mkdirp(o.out);
  let bytes = 0;
  for (const [name, data] of entries) {
    const path = `${o.out}/${name}`;
    await fs.mkdirp(path.slice(0, path.lastIndexOf('/')));
    await fs.writeBytes(path, data);
    bytes += data.length;
  }
  return { files: entries.size, bytes };
}
