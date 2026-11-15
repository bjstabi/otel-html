import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREBUILT_ENV } from './generator.js';
import { CACHE_OFF_ENV, MEASURED_ENV, reportCacheDir, sweepStale } from './report-cache.js';

const SCALING_ENV = 'OTEL_HTML_SCALING';

/**
 * Makes the folder the workers share their generated reports in (the first worker that needs a shape builds it there,
 * see `buildScalingReport`): the content-keyed `.cache/scaling-reports/<key>`, kept across runs, or with
 * `OTEL_HTML_SCALING_CACHE=off` a temp folder removed at the end (in scaling mode only, as before). Measurements
 * (`OTEL_HTML_SCALING=1`) never go there: they get a folder of their own, per run.
 */
export async function setup(): Promise<() => Promise<void>> {
  const scaling = process.env[SCALING_ENV] === '1';
  const cleanups: Array<() => Promise<void>> = [];
  if (process.env[CACHE_OFF_ENV] === 'off') {
    if (!scaling) return async () => {};
    const root = await mkdtemp(join(tmpdir(), 'otel-scaling-reports-'));
    process.env[PREBUILT_ENV] = root;
    cleanups.push(async () => {
      delete process.env[PREBUILT_ENV];
      await rm(root, { recursive: true, force: true });
    });
  } else {
    try {
      const dir = reportCacheDir();
      await mkdir(dir, { recursive: true });
      await sweepStale(dir);
      process.env[PREBUILT_ENV] = dir;
      cleanups.push(async () => {
        delete process.env[PREBUILT_ENV];
      });
    } catch {
      // no writable cache: each worker builds in-process
    }
  }
  if (scaling) {
    const measured = await mkdtemp(join(tmpdir(), 'otel-scaling-measured-'));
    process.env[MEASURED_ENV] = measured;
    cleanups.push(async () => {
      delete process.env[MEASURED_ENV];
      await rm(measured, { recursive: true, force: true });
    });
  }
  return async () => {
    for (const c of cleanups) await c();
  };
}
