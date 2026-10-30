/// <reference types="node" />
import { calibrationMs, cpuModel } from './calibrate.js';

/** How much slower this runner is than the reference (at least 1), or 1 without a usable reference. */
export function runnerFactor(referenceMs: number | undefined, calibrationMs: number): number {
  return referenceMs === undefined || referenceMs <= 0 ? 1 : Math.max(1, calibrationMs / referenceMs);
}

function reference(): number | undefined {
  const { OTEL_HTML_PERF_REFERENCE_MS: raw } = process.env;
  if (raw === undefined || raw === '') return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

const measured = calibrationMs(5);
const { OTEL_HTML_PERF_FACTOR } = process.env;

/**
 * The factor the unit `@perf` budgets are multiplied by: `OTEL_HTML_PERF_FACTOR` times the runner factor (the
 * calibration workload's time over `OTEL_HTML_PERF_REFERENCE_MS`, never below 1; 1 when no reference is set).
 * Computed once per process, when the first perf test file imports this.
 */
export const PERF_FACTOR: number = Number(OTEL_HTML_PERF_FACTOR ?? '1') * runnerFactor(reference(), measured);

process.stderr.write(
  `PERF calibration: ${measured.toFixed(1)} ms on ${cpuModel()} (factor ${PERF_FACTOR.toFixed(2)})\n`,
);
