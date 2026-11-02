import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { calibrationMs, cpuModel } from '../test-support/calibrate.js';
import {
  FIXTURE_REPORTS,
  httpSubpath,
  LOAD_REPORT_ENV,
  PERF_CALIBRATION_ENV,
  PERF_REFERENCE_ENV,
  PORT_ENV,
  type ReportName,
  reportDir,
  runnerFactor,
} from './fixture.js';
import { serve } from './static-server.js';

/** Times the calibration workload before anything else runs, for `perfFactor` in the workers (env is inherited). */
function calibrate(): void {
  const ms = calibrationMs();
  process.env[PERF_CALIBRATION_ENV] = ms.toFixed(1);
  const reference = process.env[PERF_REFERENCE_ENV];
  process.stdout.write(
    `PERF calibration: ${ms.toFixed(1)} ms on ${cpuModel()}${reference ? ` (reference ${reference} ms, runner factor ${runnerFactor().toFixed(2)})` : ''}\n`,
  );
}

/** Throws naming the first mounted report (metrics-scale is built on demand) that `mise run e2e:fixtures` has not built. */
async function assertReportsBuilt(mounted: readonly ReportName[]): Promise<void> {
  for (const name of mounted) {
    if (name === 'metrics-scale') continue;
    // `no-manifest` is a copy of `main` without its manifest, by design.
    const probe = name === 'no-manifest' ? 'index.html' : 'data/manifest.js';
    try {
      await stat(new URL(probe, reportDir(name)));
    } catch {
      throw new Error(`the e2e fixture reports are missing: run \`mise run e2e:fixtures\` (${name})`);
    }
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  calibrate();
  const dir = (u: URL): string => fileURLToPath(u).replace(/\/$/, '');
  // `metrics-scale` is built on demand by the specs that need it (e2e/metrics-scale.ts); its mount may be empty.
  const mounted: ReportName[] = [
    'main',
    'hostile',
    'merged',
    'scale',
    'huge',
    'no-manifest',
    'metrics-merged',
    'metrics-single',
    'unfinished',
    'dashboards',
    'dashboards-hostile',
    'run-charts',
    'metrics-scale',
    'frozen-format-1',
    'frozen-format-2',
    ...FIXTURE_REPORTS,
  ];
  // The load spec serves its own report (`dist/load-receiver`) and runs without the fixture reports built.
  if (process.env[LOAD_REPORT_ENV] === undefined) await assertReportsBuilt(mounted);
  const server = await serve(
    mounted.map((name) => ({ prefix: httpSubpath(name), root: dir(reportDir(name)) })),
  );
  process.env[PORT_ENV] = String(server.port);
  return () => server.close();
}
