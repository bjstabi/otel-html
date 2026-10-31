import { createHash } from 'node:crypto';

/** The id a job hashes into its span id: the API job id, or `name:<job name>` when the lookup was approximate. */
export type JobId = number | string;

const sha256Hex = (s: string, bytes: number): string =>
  createHash('sha256')
    .update(s)
    .digest('hex')
    .slice(0, bytes * 2);

export function runKey(i: { repository: string; runId: number; runAttempt: number }): string {
  return `github.com/${i.repository}/actions/runs/${i.runId}/attempts/${i.runAttempt}`;
}

export const traceIdOf = (key: string): string => sha256Hex(key, 16);

export const runSpanIdOf = (key: string): string => sha256Hex(`${key}#run`, 8);

export const jobSpanIdOf = (key: string, jobId: JobId): string => sha256Hex(`${key}/jobs/${jobId}`, 8);

export const stepSpanIdOf = (key: string, jobId: JobId, stepNumber: number): string =>
  sha256Hex(`${key}/jobs/${jobId}/steps/${stepNumber}`, 8);

export const jobTraceparent = (key: string, jobId: JobId): string =>
  `00-${traceIdOf(key)}-${jobSpanIdOf(key, jobId)}-01`;
