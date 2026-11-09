import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { wrapDataFile } from '../src/format/data-file.js';
import { MANIFEST_KEY } from '../src/format/paths.js';
import type { Format4Fixture } from './format4-fixture.js';

/** A `Format4Fixture` written to a fresh temp folder as a report on disk: every listed file at its manifest path and `data/manifest.js` through `wrapDataFile(MANIFEST_KEY, manifest)`. */
export async function writeReportDir(f: Format4Fixture): Promise<{ dir: string; close(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'otel-html-report-'));
  const write = async (path: string, data: string | Uint8Array): Promise<void> => {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  };
  await write('data/manifest.js', wrapDataFile(MANIFEST_KEY, f.manifest));
  for (const [path, bytes] of f.files) await write(path, bytes);
  return { dir, close: () => rm(dir, { recursive: true, force: true }) };
}
