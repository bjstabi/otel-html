import { createHash } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Axis, CATALOGUE } from '../../src/viewer/data/catalogue.js';
import { BASE, CROSS, ciOf, isMerged, type Shape, shapeKey, stepsOf } from './generator.js';

/**
 * What the generated scaling reports depend on, as globs relative to the repo root: the lockfile, the writer and what it
 * imports, and the test-support files `test-support/scaling/generator.ts` builds a report with. The test
 * `the cache key covers every file the generator imports` walks the generator's imports and fails when one is missing.
 */
export const REPORT_CACHE_SOURCES: readonly string[] = [
  'pnpm-lock.yaml',
  '.github/otel-html-ci.yaml',
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

/** No build takes this long: a lock older than it is abandoned, whatever process its pid names now. */
const STALE_LOCK_MS = 30 * 60_000;

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
 * final name in one step, so a report folder is whole or absent). A lock without a holder file is kept for a minute (its owner is between `mkdir` and `writeFile`), then swept, and any lock
 * older than 30 minutes is swept. A `.part-<pid>` folder of a live process is kept.
 */
export async function sweepStale(dir: string, now: number = Date.now()): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith('.lock')) {
      const holder = await readFile(join(path, 'holder'), 'utf8').catch(() => undefined);
      const age = now - ((await stat(path).catch(() => undefined))?.mtimeMs ?? now);
      const pid = holder === undefined ? 0 : Number(holder.split(':')[0]);
      // dead holder; or no holder file for a minute (a crash between `mkdir` and the write); or older than any build
      // (30 min: a reused pid must not keep a lock alive forever)
      if ((pid > 0 && !alive(pid)) || (holder === undefined && age > 60_000) || age > STALE_LOCK_MS)
        await rm(path, { recursive: true, force: true });
    } else {
      const m = /\.part-(\d+)(?:-\d+)?$/.exec(name);
      if (m !== null && !alive(Number(m[1]))) await rm(path, { recursive: true, force: true });
    }
  }
}

const AXES: readonly Axis[] = ['retention', 'density', 'window'];

/**
 * Every shape the scaling measurement and the unit tests read, each once (by `shapeKey`): per catalogue entry and axis
 * the steps `test:scaling` measures (`stepsOf` as `measure.ts` calls it; the window axis only for entries with a
 * window), the compacted retention and window steps and the short-window steps `classes.test.ts` builds, `CROSS` in both
 * spacings, and the unit
 * tests' `BASE`, sparse `BASE` and the 8-partition one.
 */
export function scalingShapes(): Shape[] {
  const byKey = new Map<string, Shape>();
  const add = (shape: Shape): void => {
    byKey.set(shapeKey(shape), shape);
  };
  for (const entry of CATALOGUE)
    for (const axis of AXES) {
      if (axis === 'window' && !entry.window) continue;
      for (const shape of stepsOf(axis, entry.spacing, isMerged(entry), false, ciOf(entry))) add(shape);
      // the compacted cases of classes.test.ts: the `.short` entries on retention and window
      if (axis !== 'density' && entry.id.endsWith('.short'))
        for (const shape of stepsOf(axis, entry.spacing, false, true)) add(shape);
    }
  for (const spacing of ['dense', 'sparse'] as const) {
    add({ ...CROSS, spacing });
    // classes.test.ts: a compacted report with one inside partition (a window under LONG_WINDOW_NS), 3, 5 and 9 partitions
    for (const outside of [3, 5, 9]) add({ outside, inside: 1, rowGroups: 2, spacing, compacted: true });
  }
  add(BASE);
  add({ ...BASE, spacing: 'sparse' });
  add({ ...BASE, outside: 8, inside: 2 });
  return [...byKey.values()];
}
