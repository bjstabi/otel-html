import { describe, expect, test } from 'vitest';
import { type CiJob, combineRuns } from '../../../src/viewer/cicd/runs.js';
import type { CicdRow } from '../../../src/viewer/data/cicd-query.js';

const SEC = 1_000_000_000;

const base: CicdRow = {
  kind: 'run',
  traceId: 't1',
  spanId: 'r1',
  start: 100 * SEC,
  end: 160 * SEC,
  name: 'ci',
  result: 'success',
  pipeline: 'ci',
  runId: '7',
  attempt: 1,
  trigger: 'push',
  branch: 'main',
  revision: 'abc',
  title: 'a title',
  task: null,
  taskId: null,
  labels: null,
  queuedNs: null,
  needs: null,
  condition: null,
  failedStep: null,
  tasksReplayed: null,
  tasksRun: null,
};
const run = (over: Partial<CicdRow>): CicdRow => ({ ...base, ...over });
const job = (over: Partial<CicdRow>): CicdRow =>
  run({
    kind: 'job',
    spanId: 'j1',
    start: 101 * SEC,
    end: 130 * SEC,
    name: 'check',
    task: 'check',
    taskId: 'check',
    result: 'success',
    pipeline: null,
    runId: null,
    attempt: null,
    trigger: null,
    branch: null,
    revision: null,
    title: null,
    labels: 'ubuntu',
    needs: ['lint'],
    ...over,
  });
const tasks = (traceId: string, replayed: number, ran: number): CicdRow =>
  run({
    kind: 'tasks',
    traceId,
    spanId: null,
    name: null,
    result: null,
    pipeline: null,
    runId: null,
    attempt: null,
    trigger: null,
    branch: null,
    revision: null,
    title: null,
    tasksReplayed: replayed,
    tasksRun: ran,
  });

describe('combineRuns', () => {
  test('joins a run with its jobs by trace and reads the job fields', () => {
    const [r, ...rest] = combineRuns([
      run({}),
      job({}),
      job({
        spanId: 'j2',
        task: 'test',
        name: 'test',
        start: 102 * SEC,
        end: 190 * SEC,
        queuedNs: 3 * SEC,
        failedStep: 'Run it',
        result: 'failure',
        needs: null,
      }),
    ]);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({
      traceId: 't1',
      runId: '7',
      attempt: 1,
      attempts: 1,
      start: 100 * SEC,
      // the latest job end minus the run start, not the root's own end
      duration: 90 * SEC,
      result: 'success',
      trigger: 'push',
      branch: 'main',
      revision: 'abc',
      title: 'a title',
      minutes: (29 * SEC + 88 * SEC) / (60 * SEC),
      cached: null,
    });
    const jobs: CiJob[] = r?.jobs ?? [];
    expect(jobs.map((j) => [j.name, j.result, j.queuedNs, j.failedStep, j.needs, j.spanId])).toEqual([
      ['check', 'success', null, null, ['lint'], 'j1'],
      ['test', 'failure', 3 * SEC, 'Run it', [], 'j2'],
    ]);
  });

  test('a run with no job row lasts from the start to the end of its root', () => {
    expect(combineRuns([run({})])[0]).toMatchObject({ duration: 60 * SEC, minutes: 0, jobs: [] });
  });

  test('two attempts of a run id give the later one, with attempts 2 (Review Focus 2)', () => {
    const rows = [
      run({ traceId: 'a1', result: 'failure', attempt: 1, start: 100 * SEC }),
      job({ traceId: 'a1', result: 'failure' }),
      run({ traceId: 'a2', result: 'success', attempt: 2, start: 900 * SEC, end: 940 * SEC }),
      job({ traceId: 'a2', start: 901 * SEC, end: 920 * SEC }),
      run({ traceId: 'b', runId: '8', start: 500 * SEC }),
    ];
    for (const rs of [rows, [...rows].reverse()]) {
      const out = combineRuns(rs);
      expect(out.map((r) => [r.runId, r.traceId, r.attempt, r.attempts, r.result])).toEqual([
        ['8', 'b', 1, 1, 'success'],
        ['7', 'a2', 2, 2, 'success'],
      ]);
    }
  });

  test('tasks rows from two partitions of one trace sum, and cached follows them (Review Focus 3)', () => {
    const [r] = combineRuns([run({}), tasks('t1', 1, 2), tasks('t1', 3, 0)]);
    expect(r).toMatchObject({ replayed: 4, ran: 2, cached: true });
    expect(combineRuns([run({}), tasks('t1', 0, 3)])[0]).toMatchObject({
      replayed: 0,
      ran: 3,
      cached: false,
    });
    expect(combineRuns([run({}), tasks('t1', 0, 0)])[0]).toMatchObject({ cached: null });
  });

  test('a trace with no run row is not a run', () => {
    expect(combineRuns([job({ traceId: 'x' }), tasks('x', 1, 1)])).toEqual([]);
  });

  test('a job row seen twice counts once, and a repeated run row keeps the later-ending one', () => {
    const [r] = combineRuns([
      run({ end: 150 * SEC }),
      run({ end: 160 * SEC, result: 'failure' }),
      job({}),
      job({ end: 140 * SEC }),
    ]);
    expect(r?.result).toBe('failure');
    expect(r?.jobs).toHaveLength(1);
    expect(r?.jobs[0]?.end).toBe(140 * SEC);
  });

  test('maps results: cancellation to cancelled, anything but success to failure', () => {
    const results = ['success', 'cancellation', 'failure', 'timeout', null].map((result, i) =>
      run({ traceId: `t${i}`, runId: `r${i}`, start: i, result }),
    );
    expect(combineRuns(results).map((r) => r.result)).toEqual([
      'success',
      'cancelled',
      'failure',
      'failure',
      'failure',
    ]);
  });

  test('sorts by start', () => {
    const out = combineRuns([
      run({ traceId: 'b', runId: '2', start: 20 }),
      run({ traceId: 'a', runId: '1', start: 30 }),
      run({ traceId: 'c', runId: '3', start: 10 }),
    ]);
    expect(out.map((r) => r.runId)).toEqual(['3', '2', '1']);
  });
});
