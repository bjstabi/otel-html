import { OtelHtmlError } from '../../model/errors.js';
import type { WriterDeps } from '../../writer/session.js';
import type { CliIo } from '../io.js';
import { uploadArtifact, zipDirectory } from './artifact-client.js';
import { say } from './github-api.js';

/** `ci upload`: zips `path` and uploads it as the artifact `name`; prints the artifact id. */
export async function runUpload(
  o: { name: string; path: string; retentionDays?: number },
  io: CliIo,
  deps: Pick<WriterDeps, 'fs' | 'clock'>,
): Promise<void> {
  const dir = o.path.startsWith('/') || /^[A-Za-z]:/.test(o.path) ? o.path : `${io.cwd}/${o.path}`;
  if ((await deps.fs.entryKind(dir)) !== 'dir')
    throw new OtelHtmlError('usage', { message: `--path is not a folder: ${o.path}` });
  const zip = await zipDirectory(deps.fs, dir);
  const { id, size } = await uploadArtifact({
    name: o.name,
    zip,
    ...(o.retentionDays === undefined ? {} : { retentionDays: o.retentionDays }),
    env: io.env,
    now: () => Number(deps.clock.nowUnixNano() / 1_000_000n),
  });
  say(io, `artifact ${o.name} uploaded: id ${id}, ${size} bytes`);
}
