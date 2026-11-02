import { inject } from 'vitest';

/** The factor when it is a finite number of at least 1; anything else means the global setup did not provide it. */
export function checkedPerfFactor(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return value;
  throw new Error(
    `perfFactor is ${String(value)}: test-support/perf-global-setup.ts did not provide it (is globalSetup still at the root of vitest.config.ts?)`,
  );
}

/** The factor `@perf` budgets are multiplied by. Call it inside the test body, never at module load. */
export function perfFactor(): number {
  return checkedPerfFactor(inject('perfFactor'));
}
