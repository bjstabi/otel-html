import type { TestProject } from 'vitest/node';
import { calibrationMs, cpuModel } from './calibrate.js';
import { parseReference, runnerFactor } from './perf-factor.js';

/**
 * Provides `perfFactor`, the factor the unit `@perf` budgets are multiplied by: `OTEL_HTML_PERF_FACTOR` times the
 * runner factor (the calibration workload's time over `OTEL_HTML_PERF_REFERENCE_MS`, never below 1; 1 when no
 * reference is set). Measured once per run, and only in the perf pass (`OTEL_HTML_PERF_PASS=1`), where budgets
 * apply; elsewhere the factor is 1 and nothing is measured or logged. Tests read it with `inject('perfFactor')`.
 */
export function setup(project: TestProject): void {
  const { OTEL_HTML_PERF_PASS, OTEL_HTML_PERF_REFERENCE_MS, OTEL_HTML_PERF_FACTOR } = process.env;
  if (OTEL_HTML_PERF_PASS !== '1') {
    project.provide('perfFactor', 1);
    return;
  }
  let reference: number | undefined;
  try {
    reference = parseReference(OTEL_HTML_PERF_REFERENCE_MS);
  } catch (e) {
    // Vitest's own startup-error printing trips over a global-setup error's stack and hides its message.
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    throw e;
  }
  const measured = calibrationMs(5);
  const factor = Number(OTEL_HTML_PERF_FACTOR ?? '1') * runnerFactor(reference, measured);
  project.provide('perfFactor', factor);
  process.stderr.write(
    `PERF calibration: ${measured.toFixed(1)} ms on ${cpuModel()}, ${
      reference === undefined ? 'no reference' : `reference ${reference} ms`
    } (factor ${factor.toFixed(2)})\n`,
  );
}
