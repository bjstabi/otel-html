import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PREBUILT_ENV } from './generator.js';

/**
 * With `OTEL_HTML_SCALING=1`, makes the folder the workers of this run share their generated reports in (the first
 * worker that needs a shape builds it there, see `buildScalingReport`) and removes it at the end.
 */
export async function setup(): Promise<() => Promise<void>> {
  if (process.env.OTEL_HTML_SCALING !== '1') return async () => {};
  const root = await mkdtemp(join(tmpdir(), 'otel-scaling-reports-'));
  process.env[PREBUILT_ENV] = root;
  return async () => {
    delete process.env[PREBUILT_ENV];
    await rm(root, { recursive: true, force: true });
  };
}
