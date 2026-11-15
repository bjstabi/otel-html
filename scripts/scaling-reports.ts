// Builds the scaling reports into .cache/scaling-reports/<key> (test-support/scaling/report-cache.ts): every shape of
// `scalingShapes()` that is not there yet, in child processes of this script, then removes the folders of other keys.
//   bun scripts/scaling-reports.ts [--jobs N]        (N children, at most the cores; default 6)
//   bun scripts/scaling-reports.ts --part i/N        (what a child does: shapes i, i+N, i+2N, ... of the missing ones)
// The children share the folder safely: a shape is built by whoever takes its `.lock` folder and moved into place with
// one rename (see `ensurePrebuilt`), so overlapping runs of this script do not build a shape twice or read half of one.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { buildScalingReport, PREBUILT_ENV, type Shape, shapeKey } from '../test-support/scaling/generator.js';
import {
  reportCacheDir,
  reportCacheRoot,
  scalingShapes,
  sweepStale,
} from '../test-support/scaling/report-cache.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

const dir = reportCacheDir();
const shapes = scalingShapes();
const isThere = (s: Shape): boolean => existsSync(join(dir, shapeKey(s), 'meta.json'));
const missing = shapes.filter((s) => !isThere(s));

const part = flag('--part');
if (part !== undefined) {
  const [i = 0, n = 1] = part.split('/').map(Number);
  process.env[PREBUILT_ENV] = dir;
  // by position in the full list, not among the missing: another process finishing a shape must not shift the parts
  for (const [at, shape] of shapes.entries()) {
    if (at % n !== i || isThere(shape)) continue;
    const report = await buildScalingReport(shape);
    await report.close();
  }
  process.exit(0);
}

await mkdir(dir, { recursive: true });
await sweepStale(dir);
const jobs = Math.max(1, Math.min(Number(flag('--jobs') ?? 6), availableParallelism(), missing.length));
if (missing.length === 0)
  process.stdout.write(`scaling reports: all ${shapes.length} shapes are in ${dir}\n`);
else {
  process.stdout.write(
    `scaling reports: building ${missing.length} shapes in ${jobs} processes into ${dir}\n`,
  );
  const codes = await Promise.all(
    Array.from(
      { length: jobs },
      (_, i) =>
        new Promise<number>((done) => {
          const child = spawn(process.execPath, [import.meta.filename, '--part', `${i}/${jobs}`], {
            stdio: 'inherit',
          });
          child.on('exit', (code) => done(code ?? 1));
          child.on('error', () => done(1));
        }),
    ),
  );
  if (codes.some((c) => c !== 0)) {
    process.stderr.write(`scaling reports: a build process failed (exit codes ${codes.join(', ')})\n`);
    process.exit(1);
  }
}
const root = reportCacheRoot();
for (const name of await readdir(root))
  if (join(root, name) !== dir) await rm(join(root, name), { recursive: true, force: true });
