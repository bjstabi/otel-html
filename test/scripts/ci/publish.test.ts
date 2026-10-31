import { describe, expect, test } from 'vitest';
import type { ApiJob } from '../../../scripts/ci/context.js';
import { approximateJobs, jobIdFor, parseJobContext, parsePublishArgs } from '../../../scripts/ci/publish.js';

const j = (id: number, name = `job${id}`): ApiJob => ({ id, name }) as ApiJob;

describe('parsePublishArgs', () => {
  const base = ['--run-id', '7', '--repository', 'o/r', '--artifacts', 'a', '--out', 'o'];
  test('reads every option', () => {
    expect(parsePublishArgs([...base, '--config', 'c.yaml'])).toEqual({
      runId: 7,
      repository: 'o/r',
      artifacts: 'a',
      out: 'o',
      config: 'c.yaml',
    });
  });
  test('config is optional', () => expect(parsePublishArgs(base).config).toBeUndefined());
  test.each([
    [['--repository', 'o/r', '--artifacts', 'a', '--out', 'o'], '--run-id is required'],
    [['--run-id', 'x', '--repository', 'o/r', '--artifacts', 'a', '--out', 'o'], 'not a positive integer'],
    [['--run-id', '7', '--repository', 'nope', '--artifacts', 'a', '--out', 'o'], 'not owner/repo'],
  ])('rejects %j', (argv, message) => expect(() => parsePublishArgs(argv)).toThrow(message));
});

describe('parseJobContext', () => {
  test('numeric and name ids', () => {
    expect(parseJobContext('{"jobId":5,"approximate":false}')).toEqual({ jobId: 5, approximate: false });
    expect(parseJobContext('{"jobId":"name:x","approximate":true}')).toEqual({
      jobId: 'name:x',
      approximate: true,
    });
  });
  test.each([undefined, '', 'nope', '[]', '{"jobId":5}', '{"jobId":null,"approximate":false}'])(
    'tolerates %j',
    (t) => expect(parseJobContext(t)).toBeUndefined(),
  );
});

describe('approximateJobs', () => {
  const jobs = [j(1), j(2), j(3)];
  test('jobs no exact artifact claims are approximate', () => {
    const ctx = [{ jobId: 1, approximate: false }, { jobId: 'name:job2', approximate: true }, undefined];
    expect([...approximateJobs(jobs, ctx)]).toEqual([2, 3]);
  });
  test('an approximate claim does not count even with a numeric id', () => {
    expect([...approximateJobs([j(1)], [{ jobId: 1, approximate: true }])]).toEqual([1]);
  });
  test('no artifacts: all approximate', () => expect(approximateJobs(jobs, []).size).toBe(3));
  test('jobIdFor uses the name hash for approximate jobs', () => {
    expect(jobIdFor(j(2, 'lint'), new Set([2]))).toBe('name:lint');
    expect(jobIdFor(j(2, 'lint'), new Set())).toBe(2);
  });
});
