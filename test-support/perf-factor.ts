/**
 * How much slower this runner is than the reference (at least 1), or 1 without a usable reference. Pure and free of
 * Node types, so any test project may import it; the measuring lives in `perf-global-setup.ts`.
 */
export function runnerFactor(referenceMs: number | undefined, calibrationMs: number): number {
  return referenceMs === undefined || referenceMs <= 0 ? 1 : Math.max(1, calibrationMs / referenceMs);
}

/** `OTEL_HTML_PERF_REFERENCE_MS` as a number: undefined when unset or empty, an error when not a positive number. */
export function parseReference(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`OTEL_HTML_PERF_REFERENCE_MS must be a positive number, got ${raw}`);
  }
  return ms;
}
