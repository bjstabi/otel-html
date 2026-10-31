import { describe, expect, test } from 'vitest';
import type { ApiJob } from '../../../scripts/ci/context.js';
import { jobSpanIdOf, runKey, runSpanIdOf, stepSpanIdOf, traceIdOf } from '../../../scripts/ci/ids.js';
import { type ApiRun, ciResource, workflowTraceRequest } from '../../../scripts/ci/workflow-trace.js';
import { parseOtlpObject } from '../../../src/model/otlp-json.js';

const run: ApiRun = {
  id: 42,
  run_attempt: 2,
  name: 'ci',
  event: 'push',
  status: 'completed',
  conclusion: 'cancelled',
  created_at: '2026-01-01T00:00:00Z',
  run_started_at: '2026-01-01T00:00:05Z',
  updated_at: '2026-01-01T00:10:00Z',
  html_url: 'https://github.com/o/r/actions/runs/42',
  head_branch: 'main',
  head_sha: 'abc',
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
};
const key = runKey({ repository: 'o/r', runId: 42, runAttempt: 2 });

const jobs: ApiJob[] = [
  {
    id: 1,
    name: 'build',
    status: 'completed',
    runner_name: 'r1',
    conclusion: 'success',
    created_at: '2026-01-01T00:00:01Z',
    started_at: '2026-01-01T00:00:10Z',
    completed_at: '2026-01-01T00:05:00Z',
    html_url: 'https://github.com/o/r/actions/runs/42/job/1',
    steps: [
      {
        number: 1,
        name: 'checkout',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-01-01T00:00:11Z',
        completed_at: '2026-01-01T00:00:20Z',
      },
    ],
  },
  {
    id: 2,
    name: 'test',
    status: 'in_progress',
    runner_name: null,
    conclusion: 'cancelled',
    created_at: '2026-01-01T00:00:01Z',
    started_at: '2026-01-01T00:01:00Z',
    completed_at: '2026-01-01T00:08:00Z',
    html_url: null,
    steps: [
      {
        number: 1,
        name: 'slow',
        status: 'in_progress',
        conclusion: 'cancelled',
        started_at: '2026-01-01T00:02:00Z',
        completed_at: null,
      },
      {
        number: 2,
        name: 'never started',
        status: 'pending',
        conclusion: null,
        started_at: null,
        completed_at: null,
      },
    ],
  },
];

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status?: { code: number; message: string };
  attributes: { key: string; value: Record<string, unknown> }[];
};
const spansOf = (req: object): Span[] =>
  (req as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }).resourceSpans[0]?.scopeSpans[0]?.spans ??
  [];
const ns = (s: string) => (BigInt(Date.parse(s)) * 1_000_000n).toString();
const byName = (spans: Span[], name: string) => {
  const s = spans.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no span ${name}`);
  return s;
};

describe('workflowTraceRequest', () => {
  const spans = spansOf(workflowTraceRequest(run, jobs, new Set([2])));

  test('span count and ids', () => {
    expect(spans).toHaveLength(1 + 2 + 2 + 3);
    const root = byName(spans, 'ci');
    expect(root.traceId).toBe(traceIdOf(key));
    expect(root.spanId).toBe(runSpanIdOf(key));
    expect(root.startTimeUnixNano).toBe(ns('2026-01-01T00:00:05Z'));
    expect(root.status).toEqual({ code: 2, message: 'cancellation' });
    expect(byName(spans, 'build').parentSpanId).toBe(root.spanId);
    expect(byName(spans, 'build').spanId).toBe(jobSpanIdOf(key, 1));
    expect(byName(spans, 'checkout').spanId).toBe(stepSpanIdOf(key, 1, 1));
    expect(spans.every((s) => s.traceId === traceIdOf(key))).toBe(true);
  });

  test('approximate job hashes its name and is flagged', () => {
    const job = byName(spans, 'test');
    expect(job.spanId).toBe(jobSpanIdOf(key, 'name:test'));
    expect(job.attributes).toContainEqual({
      key: 'otel_html.ci.parent_approximate',
      value: { boolValue: true },
    });
    expect(byName(spans, 'slow').spanId).toBe(stepSpanIdOf(key, 'name:test', 1));
    expect(byName(spans, 'slow').parentSpanId).toBe(job.spanId);
  });

  test('queued spans run from created_at to started_at', () => {
    const q = spans.filter((s) => s.name === 'queued');
    expect(q).toHaveLength(2);
    expect(q[0]?.startTimeUnixNano).toBe(ns('2026-01-01T00:00:01Z'));
    expect(q[0]?.endTimeUnixNano).toBe(ns('2026-01-01T00:00:10Z'));
    expect(q[0]?.attributes).toContainEqual({
      key: 'cicd.pipeline.task.name',
      value: { stringValue: 'build' },
    });
    expect(q[1]?.startTimeUnixNano).toBe(ns('2026-01-01T00:00:01Z'));
    expect(q[1]?.endTimeUnixNano).toBe(ns('2026-01-01T00:01:00Z'));
    expect(q[1]?.parentSpanId).toBe(byName(spans, 'test').spanId);
    expect(q[1]?.attributes).toContainEqual({
      key: 'cicd.pipeline.task.name',
      value: { stringValue: 'test' },
    });
  });

  test('a cancelled step without completed_at ends at the job completed_at', () => {
    const step = byName(spans, 'slow');
    expect(step.endTimeUnixNano).toBe(ns('2026-01-01T00:08:00Z'));
    expect(step.status).toEqual({ code: 2, message: 'cancellation' });
  });

  test('a step without started_at starts at the job start; no negative or NaN durations', () => {
    const step = byName(spans, 'never started');
    expect(step.startTimeUnixNano).toBe(ns('2026-01-01T00:01:00Z'));
    expect(step.status).toBeUndefined();
    for (const s of spans) expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
  });

  test('an unfinished job ends at the run updated_at; a job without started_at starts at the run start', () => {
    const j: ApiJob = {
      ...(jobs[1] as ApiJob),
      started_at: null,
      completed_at: null,
      steps: [
        {
          number: 1,
          name: 's',
          status: 'in_progress',
          conclusion: null,
          started_at: null,
          completed_at: null,
        },
      ],
    };
    const out = spansOf(workflowTraceRequest(run, [j], new Set()));
    expect(byName(out, 'test').startTimeUnixNano).toBe(ns('2026-01-01T00:00:05Z'));
    expect(byName(out, 'test').endTimeUnixNano).toBe(ns('2026-01-01T00:10:00Z'));
    expect(byName(out, 's').endTimeUnixNano).toBe(ns('2026-01-01T00:10:00Z'));
    expect(out.some((s) => s.name === 'queued')).toBe(false);
  });

  test('an in_progress job without completed_at ends at the run updated_at', () => {
    const j: ApiJob = { ...(jobs[1] as ApiJob), conclusion: null, completed_at: null, steps: [] };
    const job = byName(spansOf(workflowTraceRequest(run, [j], new Set())), 'test');
    expect(job.endTimeUnixNano).toBe(ns('2026-01-01T00:10:00Z'));
    expect(job.status).toBeUndefined();
  });

  test('unparsable run start times throw naming the run', () => {
    const bad = { ...run, run_started_at: null, created_at: 'nope' };
    expect(() => workflowTraceRequest(bad, [], new Set())).toThrow(/run 42/);
  });

  test('an end before its start is clamped to the start', () => {
    const j: ApiJob = { ...(jobs[0] as ApiJob), completed_at: '2025-01-01T00:00:00Z', steps: [] };
    const job = byName(spansOf(workflowTraceRequest(run, [j], new Set())), 'build');
    expect(job.endTimeUnixNano).toBe(job.startTimeUnixNano);
  });

  test('conclusions map to results', () => {
    const attr = (r: ApiRun, key: string) =>
      byName(spansOf(workflowTraceRequest(r, [], new Set())), 'ci').attributes.find((a) => a.key === key)
        ?.value;
    expect(attr(run, 'cicd.pipeline.result')).toEqual({ stringValue: 'cancellation' });
    expect(attr({ ...run, conclusion: 'timed_out' }, 'cicd.pipeline.result')).toEqual({
      stringValue: 'timeout',
    });
    expect(attr({ ...run, conclusion: 'weird' }, 'cicd.pipeline.result')).toEqual({ stringValue: 'error' });
    const ok = byName(spansOf(workflowTraceRequest({ ...run, conclusion: 'success' }, [], new Set())), 'ci');
    expect(ok.status).toBeUndefined();
  });

  test('ciResource carries the shared keys and service identity', () => {
    expect(ciResource(run)).toMatchObject({
      'cicd.pipeline.name': 'ci',
      'cicd.pipeline.run.id': '42',
      'vcs.ref.head.name': 'main',
      'service.name': 'ci',
      'service.namespace': 'o/r',
      'service.instance.id': '42/2',
    });
  });

  test('the library accepts the output', () => {
    const [req] = parseOtlpObject(workflowTraceRequest(run, jobs, new Set([2])), 'test');
    expect(req?.signal).toBe('traces');
  });
});
