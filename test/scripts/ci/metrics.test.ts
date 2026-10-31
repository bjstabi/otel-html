import { describe, expect, test } from 'vitest';
import type { ApiJob } from '../../../scripts/ci/context.js';
import { ciMetricsRequest } from '../../../scripts/ci/metrics.js';
import type { ApiRun } from '../../../scripts/ci/workflow-trace.js';
import { parseOtlpObject } from '../../../src/model/otlp-json.js';

const run: ApiRun = {
  id: 42,
  run_attempt: 1,
  name: 'ci',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-01-01T00:00:00Z',
  run_started_at: '2026-01-01T00:00:05Z',
  updated_at: '2026-01-01T00:10:05Z',
  html_url: 'https://github.com/o/r/actions/runs/42',
  head_branch: 'main',
  head_sha: 'abc',
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
};

const job = (id: number, name: string, conclusion: string | null, over: Partial<ApiJob> = {}): ApiJob => ({
  id,
  name,
  status: 'completed',
  runner_name: null,
  conclusion,
  created_at: '2026-01-01T00:00:00Z',
  started_at: '2026-01-01T00:00:10Z',
  completed_at: '2026-01-01T00:01:10Z',
  html_url: null,
  steps: [],
  ...over,
});

type Value = { stringValue?: string };
type Point = {
  timeUnixNano: string;
  count?: string;
  sum?: number;
  asInt?: string;
  bucketCounts?: string[];
  explicitBounds?: number[];
  attributes: { key: string; value: Value }[];
};
type Metric = {
  name: string;
  unit?: string;
  histogram?: { aggregationTemporality: number; dataPoints: Point[] };
  sum?: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: Point[] };
};

function metrics(r: ApiRun, jobs: ApiJob[]): Metric[] {
  const req = ciMetricsRequest(r, jobs, { 'cicd.pipeline.name': 'ci' }) as {
    resourceMetrics: { scopeMetrics: { scope: { name: string }; metrics: Metric[] }[] }[];
  };
  expect(req.resourceMetrics[0]?.scopeMetrics[0]?.scope.name).toBe('otel-html-ci');
  return req.resourceMetrics[0]?.scopeMetrics[0]?.metrics ?? [];
}
const named = (ms: Metric[], n: string) => ms.find((m) => m.name === n);
const attr = (p: Point, k: string) => p.attributes.find((a) => a.key === k)?.value.stringValue;

describe('ciMetricsRequest', () => {
  const green = metrics(run, [job(1, 'build', 'success')]);

  test('metric names', () => {
    expect(green.map((m) => m.name)).toEqual([
      'cicd.pipeline.run.duration',
      'cicd.pipeline.task.run.duration',
      'cicd.pipeline.task.run.queue.duration',
    ]);
  });

  test('task duration histogram', () => {
    const h = named(green, 'cicd.pipeline.task.run.duration');
    expect(h?.unit).toBe('s');
    expect(h?.histogram?.aggregationTemporality).toBe(1);
    const [p] = h?.histogram?.dataPoints ?? [];
    expect(p?.count).toBe('1');
    expect(p?.sum).toBe(60);
    expect(p?.explicitBounds).toEqual([1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600]);
    // 60 s lands in the (30, 60] bucket
    expect(p?.bucketCounts).toEqual(['0', '0', '0', '0', '1', '0', '0', '0', '0', '0', '0', '0']);
    expect(p?.timeUnixNano).toBe('1767226205000000000');
    expect(attr(p as Point, 'cicd.pipeline.task.name')).toBe('build');
    expect(attr(p as Point, 'cicd.pipeline.task.run.result')).toBe('success');
  });

  test('run duration and queue duration', () => {
    const [r] = named(green, 'cicd.pipeline.run.duration')?.histogram?.dataPoints ?? [];
    expect(r?.sum).toBe(600);
    expect(attr(r as Point, 'cicd.pipeline.result')).toBe('success');
    const [q] = named(green, 'cicd.pipeline.task.run.queue.duration')?.histogram?.dataPoints ?? [];
    expect(q?.sum).toBe(10);
  });

  test('values beyond the last bound land in the overflow bucket', () => {
    const slow = metrics(run, [job(1, 'b', 'success', { completed_at: '2026-01-01T03:00:00Z' })]);
    const [p] = named(slow, 'cicd.pipeline.task.run.duration')?.histogram?.dataPoints ?? [];
    expect(p?.bucketCounts?.[11]).toBe('1');
  });

  test('the errors sum is absent when every job succeeded or was skipped', () => {
    expect(named(green, 'cicd.pipeline.run.errors')).toBeUndefined();
    const skipped = metrics(run, [job(1, 'a', 'success'), job(2, 'b', 'skipped')]);
    expect(named(skipped, 'cicd.pipeline.run.errors')).toBeUndefined();
  });

  test('the errors sum has a point per failed job', () => {
    const ms = metrics({ ...run, conclusion: 'failure' }, [
      job(1, 'a', 'success'),
      job(2, 'b', 'failure'),
      job(3, 'c', 'cancelled'),
      job(4, 'd', null),
    ]);
    const sum = named(ms, 'cicd.pipeline.run.errors')?.sum;
    expect(sum?.isMonotonic).toBe(true);
    expect(sum?.aggregationTemporality).toBe(1);
    expect(
      sum?.dataPoints.map((p) => [p.asInt, attr(p, 'error.type'), attr(p, 'cicd.pipeline.name')]),
    ).toEqual([
      ['1', 'failure', 'ci'],
      ['1', 'cancelled', 'ci'],
    ]);
    const [r] = named(ms, 'cicd.pipeline.run.duration')?.histogram?.dataPoints ?? [];
    expect(attr(r as Point, 'cicd.pipeline.result')).toBe('failure');
  });

  test('jobs without timings produce no duration or queue points', () => {
    const ms = metrics(run, [job(1, 'a', null, { started_at: null, completed_at: null })]);
    expect(named(ms, 'cicd.pipeline.task.run.duration')).toBeUndefined();
    expect(named(ms, 'cicd.pipeline.task.run.queue.duration')).toBeUndefined();
  });

  test('the library accepts the output', () => {
    const [req] = parseOtlpObject(
      ciMetricsRequest(run, [job(1, 'a', 'failure')], { 'cicd.pipeline.name': 'ci' }),
      'test',
    );
    expect(req?.signal).toBe('metrics');
  });
});
