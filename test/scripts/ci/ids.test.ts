import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  jobSpanIdOf,
  jobTraceparent,
  runKey,
  runSpanIdOf,
  stepSpanIdOf,
  traceIdOf,
} from '../../../scripts/ci/ids.js';
import { parseTraceparent } from '../../../src/run/traceparent.js';

const key = runKey({ repository: 'bjstabi/otel-html', runId: 42, runAttempt: 2 });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('ci ids', () => {
  test('runKey renders the documented form', () => {
    expect(key).toBe('github.com/bjstabi/otel-html/actions/runs/42/attempts/2');
  });

  test('ids are lower-case hex of the right length, taken from sha256 prefixes', () => {
    expect(traceIdOf(key)).toBe(sha(key).slice(0, 32));
    expect(runSpanIdOf(key)).toBe(sha(`${key}#run`).slice(0, 16));
    expect(jobSpanIdOf(key, 7)).toBe(sha(`${key}/jobs/7`).slice(0, 16));
    expect(stepSpanIdOf(key, 7, 3)).toBe(sha(`${key}/jobs/7/steps/3`).slice(0, 16));
    expect(traceIdOf(key)).toMatch(/^[0-9a-f]{32}$/);
    expect(jobSpanIdOf(key, 7)).toMatch(/^[0-9a-f]{16}$/);
  });

  test('deterministic, and a different attempt gives a different trace id', () => {
    expect(traceIdOf(key)).toBe(traceIdOf(key));
    const k2 = runKey({ repository: 'bjstabi/otel-html', runId: 42, runAttempt: 3 });
    expect(traceIdOf(k2)).not.toBe(traceIdOf(key));
  });

  test('a numeric job id and a name fallback hash differently', () => {
    expect(jobSpanIdOf(key, 7)).not.toBe(jobSpanIdOf(key, 'name:e2e (webkit)'));
  });

  test('jobTraceparent round-trips through parseTraceparent', () => {
    const tp = jobTraceparent(key, 7);
    expect(tp).toBe(`00-${traceIdOf(key)}-${jobSpanIdOf(key, 7)}-01`);
    const parsed = parseTraceparent(tp);
    expect(Buffer.from(parsed.traceId).toString('hex')).toBe(traceIdOf(key));
    expect(Buffer.from(parsed.spanId).toString('hex')).toBe(jobSpanIdOf(key, 7));
    expect(parsed.flags).toBe(1);
  });
});
