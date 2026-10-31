import { describe, expect, test } from 'vitest';
import {
  type ApiJob,
  contextEnv,
  contextJson,
  envFileText,
  jobsUrl,
  parseNextLink,
  readInputs,
  resolveJob,
} from '../../../scripts/ci/context.js';
import { jobTraceparent, runKey } from '../../../scripts/ci/ids.js';

const job = (id: number, over: Partial<ApiJob> = {}): ApiJob => ({
  id,
  name: `job ${id}`,
  status: 'in_progress',
  runner_name: 'runner-1',
  conclusion: null,
  started_at: null,
  completed_at: null,
  created_at: '2026-10-30T00:00:00Z',
  html_url: null,
  steps: [],
  ...over,
});

describe('resolveJob', () => {
  test('one in-progress job on the runner is exact', () => {
    const jobs = [job(1, { status: 'completed' }), job(2), job(3, { runner_name: 'runner-2' })];
    expect(resolveJob(jobs, 'runner-1', 'e2e')).toEqual({ jobId: 2, approximate: false });
  });

  test('two in-progress jobs on one runner name fall back to the name hash', () => {
    expect(resolveJob([job(1), job(2)], 'runner-1', 'e2e')).toEqual({ jobId: 'name:e2e', approximate: true });
  });

  test('no match falls back to the name hash', () => {
    expect(resolveJob([job(1, { status: 'queued' })], 'runner-1', 'e2e')).toEqual({
      jobId: 'name:e2e',
      approximate: true,
    });
    expect(resolveJob([], 'runner-1', 'e2e')).toEqual({ jobId: 'name:e2e', approximate: true });
  });
});

const base = {
  repository: 'bjstabi/otel-html',
  runId: 42,
  runAttempt: 2,
  workflow: 'ci',
  runUrl: 'https://github.com/bjstabi/otel-html/actions/runs/42',
  ref: 'main',
  sha: 'abc123',
  serverUrl: 'https://github.com',
  jobName: 'e2e (webkit)',
  jobId: 7,
};

describe('contextEnv', () => {
  test('exports the job traceparent, resource attributes and service name', () => {
    const env = contextEnv(base);
    expect(env.TRACEPARENT).toBe(jobTraceparent(runKey(base), 7));
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('cicd.pipeline.run.id=42');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('cicd.pipeline.task.name=e2e (webkit)');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain(
      'vcs.repository.url.full=https://github.com/bjstabi/otel-html',
    );
    expect(env.OTEL_SERVICE_NAME).toBe('ci/e2e (webkit)');
  });

  test('percent-encodes commas and equals signs in values', () => {
    expect(contextEnv({ ...base, jobName: 'a,b=c' }).OTEL_RESOURCE_ATTRIBUTES).toContain(
      'cicd.pipeline.task.name=a%2Cb%3Dc',
    );
  });

  test('keeps existing attributes first', () => {
    const attrs = contextEnv({ ...base, existingResourceAttributes: 'a=b' }).OTEL_RESOURCE_ATTRIBUTES;
    expect(attrs?.startsWith('a=b,cicd.pipeline.name=ci')).toBe(true);
  });

  test('drops existing pairs for keys we set; ours win', () => {
    const attrs = contextEnv({
      ...base,
      existingResourceAttributes: 'a=b,cicd.pipeline.run.id=999,c=d',
    }).OTEL_RESOURCE_ATTRIBUTES;
    expect(attrs.startsWith('a=b,c=d,cicd.pipeline.name=ci')).toBe(true);
    expect(attrs).not.toContain('999');
  });

  test('a fallback job id hashes the name', () => {
    expect(contextEnv({ ...base, jobId: 'name:e2e' }).TRACEPARENT).toBe(
      jobTraceparent(runKey(base), 'name:e2e'),
    );
  });
});

describe('readInputs', () => {
  const env = {
    GITHUB_REPOSITORY: 'bjstabi/otel-html',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_WORKFLOW: 'ci',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REF_NAME: 'main',
    GITHUB_SHA: 'abc123',
    RUNNER_NAME: 'runner-1',
    GITHUB_JOB: 'e2e',
    GITHUB_TOKEN: 'tok',
    GITHUB_ENV: '/tmp/env',
  };

  test('maps the environment to inputs', () => {
    expect(readInputs(env)).toMatchObject({
      repository: 'bjstabi/otel-html',
      runId: 42,
      runAttempt: 2,
      runUrl: 'https://github.com/bjstabi/otel-html/actions/runs/42',
      jobNameHint: 'e2e',
      token: 'tok',
      apiUrl: 'https://api.github.com',
    });
  });

  test('OTEL_HTML_JOB_NAME overrides the hint; an empty token is no token', () => {
    const r = readInputs({ ...env, OTEL_HTML_JOB_NAME: 'e2e (webkit)', GITHUB_TOKEN: '' });
    expect(r.jobNameHint).toBe('e2e (webkit)');
    expect(r.token).toBeUndefined();
  });

  test('names the missing or malformed variable', () => {
    expect(() => readInputs({ ...env, GITHUB_SHA: undefined })).toThrow('GITHUB_SHA is not set');
    expect(() => readInputs({ ...env, GITHUB_RUN_ID: 'x' })).toThrow('GITHUB_RUN_ID is not a number');
  });
});

describe('jobs API plumbing', () => {
  test('jobsUrl names the attempt', () => {
    expect(jobsUrl({ apiUrl: 'https://api.github.com', repository: 'o/r', runId: 1, runAttempt: 2 })).toBe(
      'https://api.github.com/repos/o/r/actions/runs/1/attempts/2/jobs?per_page=100',
    );
  });

  test('parseNextLink finds rel="next"', () => {
    const h = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
    expect(parseNextLink(h)).toBe('https://api.github.com/x?page=2');
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
});

describe('env file output', () => {
  test('one KEY=value line each, newlines flattened', () => {
    expect(envFileText({ A: '1', B: 'x\ny=z' })).toBe('A=1\nB=x y=z\n');
  });

  test('context.json carries the id and approximation', () => {
    expect(JSON.parse(contextJson({ jobId: 'name:e2e', approximate: true }))).toEqual({
      jobId: 'name:e2e',
      approximate: true,
    });
  });
});
