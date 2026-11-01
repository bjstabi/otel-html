import { fileURLToPath } from 'node:url';
import { calibrationMs, cpuModel } from '../test-support/calibrate.js';
import {
  FIXTURE_REPORTS,
  httpSubpath,
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
    ...FIXTURE_REPORTS,
  ];
  const server = await serve(
    mounted.map((name) => ({ prefix: httpSubpath(name), root: dir(reportDir(name)) })),
  );
  process.env[PORT_ENV] = String(server.port);
  return () => server.close();
}
