import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Report } from '../src/api/index.js';
import { scaleMetrics } from '../test-support/scale-metrics.js';
import {
  REPORTS_DIR,
  reportDir,
  SCALE_METRIC_POINTS,
  SCALE_METRIC_SERIES,
  SCALE_METRICS,
  scaleMetricEmitted,
} from './fixture.js';

/** Collections written between two flushes, so the writer spills its buckets to segments as a long run does. */
const FLUSH_EVERY = 6;

/**
 * The metrics scale report (`fixture.ts`: 200 metrics × 1,000 series, 1 h at 10 s for the charted metric and the
 * first and last collection for the rest), written through the library API. It takes seconds, so it is written once
 * per run, into `REPORTS_DIR` (which the global setup clears), by the specs that need it.
 */
export async function ensureMetricsScaleReport(): Promise<void> {
  const dir = reportDir('metrics-scale');
  const written = await stat(dir).then(
    () => true,
    () => false,
  );
  if (written) return;
  const started = Date.now();
  // Written aside and moved into place, so the folder exists only once the report is whole.
  const tmp = new URL(`metrics-scale.tmp-${process.pid}/`, REPORTS_DIR);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const report = await Report.create({ out: fileURLToPath(tmp), title: 'metrics scale run' });
  for (let i = 0; i < SCALE_METRIC_POINTS; i++) {
    for (const request of scaleMetrics(SCALE_METRICS, SCALE_METRIC_SERIES, 1, i, scaleMetricEmitted))
      await report.addMetrics(request);
    if ((i + 1) % FLUSH_EVERY === 0) await report.flush();
  }
  await report.close();
  try {
    await rename(tmp, dir);
  } catch (e) {
    // Another worker finished first (`--workers=1` in CI and the @perf pass, but not a local run): its report is
    // whole, so this copy goes and the one in place is used. `rename` onto a non-empty folder fails with ENOTEMPTY
    // (EEXIST on some file systems, EPERM on Windows).
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM') throw e;
    await rm(tmp, { recursive: true, force: true });
  }
  process.stdout.write(`metrics scale report written in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
}
