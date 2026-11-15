import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * What the generated scaling reports depend on, as globs relative to the repo root: the lockfile, the writer and what it
 * imports, and the test-support files `test-support/scaling/generator.ts` builds a report with. The test
 * `the cache key covers every file the generator imports` walks the generator's imports and fails when one is missing.
 */
export const REPORT_CACHE_SOURCES: readonly string[] = [
  'pnpm-lock.yaml',
  'src/config/**',
  'src/format/**',
  'src/model/**',
  'src/writer/**',
  'src/dashboards/schema.ts',
  'src/host/{engine-files,node-duckdb}.ts',
  'src/viewer/data/**',
  'src/viewer/components/filter-tokens.ts',
  'src/query/**',
  'src/rollups/**',
  'src/semconv/**',
  'src/ottl/**',
  'test-support/scaling/{generator,bounded,cost,model,counting-engine}.ts',
  'test-support/{duckdb-node,format6,host-engine-files,format4-fixture,report-dir,writer-deps,memory-fs,fixed-clock,fake-timers,otlp-builders}.ts',
];

/** `off` restores the per-run temp folder for the reports (no cache across runs). */
export const CACHE_OFF_ENV = 'OTEL_HTML_SCALING_CACHE';

/** The per-run folder `sharedMeasure` writes `measured-*.json` into: measurements are never replayed from the cache. */
export const MEASURED_ENV = 'OTEL_HTML_SCALING_MEASURED';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** The first 16 hex characters of the SHA-256 over the sorted (path, bytes) of every file the globs match. */
export function reportCacheKey(root: string = REPO_ROOT): string {
  const files = new Set<string>();
  for (const glob of REPORT_CACHE_SOURCES)
    for (const f of globSync(glob, { cwd: root })) files.add(f.split('\\').join('/'));
  const hash = createHash('sha256');
  for (const f of [...files].sort()) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, f));
    } catch (e) {
      // a directory a `**` glob matched
      if ((e as NodeJS.ErrnoException).code === 'EISDIR') continue;
      throw e;
    }
    hash.update(`${f}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex').slice(0, 16);
}

/** `<root>/.cache/scaling-reports/<key>`: the reports of the writer as it is now. */
export function reportCacheDir(root: string = REPO_ROOT): string {
  return join(root, '.cache', 'scaling-reports', reportCacheKey(root));
}

/** The folder that holds every key's folder. */
export function reportCacheRoot(root: string = REPO_ROOT): string {
  return join(root, '.cache', 'scaling-reports');
}

function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Removes what a builder that died left in a persistent report folder: `*.lock` folders whose holder process is gone
 * (nobody would ever release them) and `*.part-*` folders (a half-copied report: a finished one is renamed to its
 * final name in one step, so a report folder is whole or absent). A lock without a holder file yet is kept: its owner
 * is between `mkdir` and `writeFile`. A `.part-<pid>` folder of a live process is kept.
 */
export async function sweepStale(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (name.endsWith('.lock')) {
      const holder = await readFile(join(dir, name, 'holder'), 'utf8').catch(() => undefined);
      const pid = holder === undefined ? 0 : Number(holder.split(':')[0]);
      if (pid > 0 && !alive(pid)) await rm(join(dir, name), { recursive: true, force: true });
    } else {
      const m = /\.part-(\d+)(?:-\d+)?$/.exec(name);
      if (m !== null && !alive(Number(m[1]))) await rm(join(dir, name), { recursive: true, force: true });
    }
  }
}
