import { describe, expect, test } from 'vitest';
import {
  bucketOf,
  failures,
  jobsTable,
  minutesPerDay,
  narrowJobs,
  queue,
  rerunsAndCancelled,
  splitPeriods,
  stat,
  statusGrid,
  trendBuckets,
  triggers,
} from '../../../src/viewer/cicd/derive.js';
import type { CiJob, CiRun } from '../../../src/viewer/cicd/runs.js';
import type { CicdRow } from '../../../src/viewer/data/cicd-query.js';

const SEC = 1_000_000_000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;

const job = (name: string, start: number, secs: number, over: Partial<CiJob> = {}): CiJob => ({
  name,
  id: name,
  result: 'success',
  start,
  end: start + secs * SEC,
  queuedNs: null,
  labels: null,
  needs: [],
  condition: null,
  failedStep: null,
  spanId: null,
  ...over,
});

let n = 0;
function run(start: number, over: Partial<CiRun> & { jobs?: CiJob[] } = {}): CiRun {
  n++;
  const jobs = over.jobs ?? [job('check', start, 60)];
  return {
    traceId: `t${n}`,
    runId: `${n}`,
    attempt: 1,
    attempts: 1,
    start,
    duration: 60 * SEC,
    result: 'success',
    trigger: 'push',
    branch: 'main',
    revision: 'abc',
    title: 'title',
    minutes: jobs.reduce((s, j) => s + (j.end - j.start), 0) / MIN,
    replayed: 0,
    ran: 1,
    cached: false,
    ...over,
    jobs,
  };
}

/** 12 runs, one per half day; durations 10, 20, ..., 120 s; run 4 fails and run 8 is cancelled, run 9 fails. */
function twelve(): CiRun[] {
  return Array.from({ length: 12 }, (_, i) =>
    run(i * (DAY / 2) * 1, {
      duration: (i + 1) * 10 * SEC,
      result: i === 8 ? 'cancelled' : i === 3 || i === 9 ? 'failure' : 'success',
      cached: i % 2 === 0,
      trigger: i < 8 ? 'push' : 'pull_request',
      jobs: [job('check', i * (DAY / 2), 60, { queuedNs: (i + 1) * SEC, labels: i < 6 ? 'ubuntu' : null })],
    }),
  );
}

function everyNumberFinite(v: unknown, path = 'result'): void {
  if (typeof v === 'number') expect(Number.isFinite(v), `${path} is ${v}`).toBe(true);
  else if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) everyNumberFinite(x, `${path}[${i}]`);
  } else if (v !== null && typeof v === 'object' && !('traceId' in v))
    for (const [k, x] of Object.entries(v)) everyNumberFinite(x, `${path}.${k}`);
}

describe('stat', () => {
  test('success rate leaves the cancelled run out: 9 of 11', () => {
    const s = stat('success-rate', twelve(), []);
    expect(s.value).toBe('81.8%');
    expect(s.note).toBe('9 of 11 runs, 1 cancelled left out');
    expect(s.delta).toBeNull();
  });

  test('median run, with a delta against the previous period (lower is better)', () => {
    const runs = twelve();
    const prev = [run(0, { duration: 100 * SEC })];
    const s = stat('median-run', runs, prev);
    // durations without the cancelled 90 s: 10..80, 100, 110, 120 -> median of 11 values is the 6th = 60
    expect(s.value).toBe('60 s');
    expect(s.delta).toEqual({ text: '−40%', better: true });
    expect(s.spark?.length).toBeGreaterThanOrEqual(2);
  });

  test('cache is the cold median over the warm median, and a dash when either side is empty', () => {
    const runs = [
      run(0, { duration: 100 * SEC, cached: false }),
      run(1, { duration: 40 * SEC, cached: true }),
      run(2, { duration: 80 * SEC, cached: null }),
    ];
    expect(stat('cache', runs, []).value).toBe('2.5×');
    expect(stat('cache', runs.slice(0, 1), []).value).toBe('–');
  });

  test('minutes, queue-p95 and reruns', () => {
    const runs = twelve();
    expect(stat('minutes', runs, []).value).toBe('12 min');
    expect(stat('queue-p95', runs, []).value).toBe('11.4 s');
    const again = [run(0, { attempts: 3, attempt: 3 }), run(1), run(2, { result: 'cancelled' })];
    const s = stat('reruns', again, [run(0)]);
    expect(s.value).toBe('1');
    expect(s.note).toBe('1 cancelled');
    expect(s.delta).toEqual({ text: '+1', better: false });
  });

  test('the sparkline carries the value over an empty slice', () => {
    const runs = [run(0, { duration: 10 * SEC }), run(12 * DAY, { duration: 30 * SEC })];
    expect(stat('median-run', runs, []).spark).toEqual([10 * SEC, ...Array(10).fill(10 * SEC), 30 * SEC]);
  });

  test('an empty period gives a dash and nothing else', () => {
    for (const k of ['success-rate', 'median-run', 'cache', 'minutes', 'queue-p95', 'reruns'] as const) {
      expect(stat(k, [], twelve())).toEqual({ value: '–', delta: null, spark: null, note: null });
    }
  });
});

describe('trendBuckets', () => {
  test('12 runs over 7 days: at most 6 buckets, so 2 d', () => {
    const t = trendBuckets(twelve(), [0, 7 * DAY]);
    expect(t.step).toBe(2 * DAY);
    expect(t.buckets).toHaveLength(4);
    expect(t.buckets.map((b) => b.runs.length)).toEqual([4, 4, 4, 0]);
    expect(t.buckets[0]).toMatchObject({ passed: 3, failed: 1, cancelled: 0, p50: 25 * SEC });
    expect(t.buckets[3]).toMatchObject({ p50: null, p95: null });
    expect(t.buckets[2]?.cancelled).toBe(1);
  });

  test('257 runs over 7 days: 6 h', () => {
    const runs = Array.from({ length: 257 }, (_, i) => run((i * 7 * DAY) / 257));
    expect(trendBuckets(runs, [0, 7 * DAY]).step).toBe(6 * 60 * MIN);
  });

  test('no runs: empty buckets', () => {
    expect(trendBuckets([], [0, 7 * DAY])).toEqual({ step: 2 * DAY, buckets: [] });
  });
});

describe('jobsTable', () => {
  test('drops jobs with fewer than 3 points and orders by median start offset', () => {
    const runs = Array.from({ length: 4 }, (_, i) =>
      run(i * MIN, {
        jobs: [
          job('late', i * MIN + 50 * SEC, 10),
          job('early', i * MIN, 20 + i, { result: i === 1 ? 'failure' : 'success' }),
          ...(i < 2 ? [job('rare', i * MIN, 5)] : []),
        ],
      }),
    );
    const rows = jobsTable(runs, runs);
    expect(rows.map((r) => r.name)).toEqual(['early', 'late']);
    expect(rows[0]).toMatchObject({
      latest: 23 * SEC,
      median: 21.5 * SEC,
      p25: 20.75 * SEC,
      p75: 22.25 * SEC,
      failed: [1, 4],
      delta: null,
      deltaA: null,
      deltaB: null,
    });
  });

  test('delta compares the last 10 successes with the 20 before; under 3 on a side is "too small"', () => {
    const mk = (count: number): CiRun[] =>
      Array.from({ length: count }, (_, i) =>
        run(i * MIN, { jobs: [job('check', i * MIN, i < count - 10 ? 10 : 30)] }),
      );
    const rows = jobsTable(mk(30), mk(30));
    expect(rows[0]).toMatchObject({ deltaA: 10 * SEC, deltaB: 30 * SEC, delta: 20 * SEC });
    expect(jobsTable(mk(12), mk(12))[0]?.delta).toBeNull();
    expect(jobsTable(mk(13), mk(13))[0]?.delta).toBe(20 * SEC);
  });

  test('a job binding drops runs without that job here but not from the median run', () => {
    const a = run(0, { duration: 10 * SEC, jobs: [job('check', 0, 5)] });
    const b = run(1, { duration: 30 * SEC, jobs: [job('lint', 1, 5)] });
    const narrowed = narrowJobs([a, b], 'check', null);
    expect(narrowed).toHaveLength(1);
    expect(jobsTable(narrowed, narrowed)).toEqual([]);
    const five = [0, 1, 2].map((i) => run(i, { jobs: [job('check', i, 5), job('lint', i, 5)] }));
    const lone = [...five, run(9, { jobs: [job('lint', 9, 5)] })];
    expect(jobsTable(narrowJobs(lone, 'check', null), lone).map((r) => [r.name, r.points.length])).toEqual([
      ['check', 3],
    ]);
    expect(jobsTable(lone, lone).find((r) => r.name === 'lint')?.points).toHaveLength(4);
    expect(stat('median-run', [a, b], []).value).toBe('20 s');
    expect(narrowJobs([a, b], null, null)).toHaveLength(2);
    expect(narrowJobs([a, b], null, 'x')).toHaveLength(0);
  });
});

describe('narrowing and skipped jobs', () => {
  const epoch = BigInt(new Date(2026, 0, 1).getTime()) * 1_000_000n;
  test('narrowed minutes follow the kept jobs: by trigger equals by job', () => {
    const r = run(0, { jobs: [job('a', 0, 60), job('b', 0, 120)] });
    const [n] = narrowJobs([r], 'b', null);
    expect(n?.minutes).toBe(2);
    expect(minutesPerDay([r], 'trigger', epoch).days[0]?.total).toBe(3);
    expect(minutesPerDay([n as CiRun], 'trigger', epoch).days[0]?.total).toBe(2);
    expect(minutesPerDay([n as CiRun], 'job', epoch).days[0]?.total).toBe(2);
  });

  test('a skipped job did not run: not in triggers, minutes or queue', () => {
    const skipped = job('x', 0, 600, { result: 'skipped', queuedNs: SEC });
    const rs = Array.from({ length: 5 }, (_, i) =>
      run(i, { jobs: [job('a', 0, 60, { queuedNs: SEC }), skipped] }),
    );
    expect(triggers(rs)[0]).toMatchObject({ jobs: 1, always: 1, chips: [] });
    expect(minutesPerDay(rs, 'trigger', epoch).days[0]?.total).toBe(5);
    expect(stat('minutes', rs, []).value).toBe('5 min');
    expect(queue(rs)[0]?.n).toBe(5);
  });
});

describe('statusGrid', () => {
  test('keeps the last runs, oldest first, with did-not-run cells', () => {
    const runs = [
      run(0, { jobs: [job('a', 0, 5), job('b', 0, 5)] }),
      run(MIN, { jobs: [job('a', MIN, 5, { result: 'failure' })] }),
      run(2 * MIN, { jobs: [job('a', 2 * MIN, 5, { result: 'cancellation' }), job('b', 2 * MIN, 5)] }),
    ];
    const g = statusGrid(runs, 2);
    expect(g.runs).toHaveLength(2);
    expect(g.rows).toEqual([
      { job: 'a', cells: ['failure', 'cancelled'], failed: 1, ran: 2 },
      { job: 'b', cells: [null, 'success'], failed: 0, ran: 1 },
    ]);
  });

  test('two attempts of one run are one column', () => {
    const rows: CicdRow[] = [
      cicd('run', 'ta1', { start: 0, end: 10 * SEC, runId: '9', attempt: 1, result: 'failure' }),
      cicd('run', 'ta2', { start: 20 * SEC, end: 30 * SEC, runId: '9', attempt: 2, result: 'success' }),
    ];
    const { runs } = splitPeriods(rows, [0, 100 * SEC]);
    expect(runs).toHaveLength(1);
    expect(statusGrid(runs, 60).runs).toHaveLength(1);
    expect(rerunsAndCancelled(runs).reruns).toBe(1);
    const prev = splitPeriods(rows, [20 * SEC, 100 * SEC]);
    expect(stat('reruns', prev.runs, prev.previous).value).toBe('1');
  });
});

describe('rerunsAndCancelled', () => {
  test('rerunRuns are the runs whose latest attempt is above 1, as many as reruns', () => {
    const runs = [run(0), run(DAY, { attempt: 2, attempts: 1 }), run(2 * DAY, { attempt: 1, attempts: 2 })];
    const r = rerunsAndCancelled(runs);
    expect(r.reruns).toBe(1);
    expect(r.rerunRuns).toHaveLength(r.reruns);
    expect(r.rerunRuns[0]).toBe(runs[1]);
  });
});

describe('bucketOf', () => {
  test('the index of the bucket that holds the run, else null', () => {
    const a = run(0);
    const b = run(2 * DAY);
    const { buckets } = trendBuckets([a, b], [0, 4 * DAY]);
    const i = bucketOf(buckets, b.traceId);
    expect(i).not.toBeNull();
    expect(buckets[i ?? -1]?.runs).toContain(b);
    expect(bucketOf(buckets, 'nope')).toBeNull();
    expect(bucketOf(buckets, null)).toBeNull();
    expect(bucketOf([], a.traceId)).toBeNull();
  });
});

describe('failures', () => {
  test('the latest failed runs first, limited', () => {
    const runs = twelve();
    const f = failures(runs, 1);
    expect(f).toHaveLength(1);
    expect(f[0]?.run.start).toBe(9 * (DAY / 2));
    expect(failures(runs, 10)).toHaveLength(2);
  });
});

describe('triggers', () => {
  test('folds jobs of equal ran-count into one chip', () => {
    const push = Array.from({ length: 20 }, (_, i) =>
      run(i * MIN, {
        jobs: [
          job('check', 0, 5),
          ...(i < 19 ? ['a', 'b', 'c'].map((x) => job(x, 0, 5)) : []),
          ...(i < 10 ? [{ ...job('d', 0, 5), condition: 'if: main' }] : []),
        ],
      }),
    );
    const pr = [run(0, { trigger: 'pull_request', jobs: [job('check', 0, 5)] })];
    const t = triggers([...push, ...pr]);
    expect(t.map((x) => x.trigger)).toEqual(['push', 'pull_request']);
    expect(t[0]).toMatchObject({ runs: 20, jobs: 5, always: 1, passedShare: 1 });
    expect(t[0]?.chips).toEqual([
      { names: ['a', 'b', 'c'], share: 0.95, count: 19, conditions: [] },
      { names: ['d'], share: 0.5, count: 10, conditions: ['if: main'] },
    ]);
    expect(t[1]).toMatchObject({ runs: 1, jobs: 1, always: 1, chips: [] });
  });
});

describe('queue', () => {
  test('a (no label) row, and labels under 5 jobs left out', () => {
    const q = queue(twelve());
    // ubuntu: runs 0..5 -> 1..6 s; no label: 7..12 s
    expect(q).toEqual([
      { label: '(no label)', p50: 9.5 * SEC, p95: 11.75 * SEC, max: 12 * SEC, n: 6 },
      { label: 'ubuntu', p50: 3.5 * SEC, p95: 5.75 * SEC, max: 6 * SEC, n: 6 },
    ]);
    expect(queue(twelve().slice(0, 4))).toEqual([]);
  });
});

describe('minutesPerDay', () => {
  const epoch = BigInt(new Date(2026, 0, 1, 0, 0, 0).getTime()) * 1_000_000n;

  test('by trigger, per local day, with empty days kept', () => {
    const runs = [run(0), run(3 * DAY, { trigger: 'schedule' })];
    const m = minutesPerDay(runs, 'trigger', epoch);
    expect(m.keys).toEqual(['push', 'schedule']);
    expect(m.days.map((d) => d.total)).toEqual([1, 0, 0, 1]);
    expect(m.days[0]?.day).toBe(new Date(2026, 0, 1).getTime());
  });

  test('by job: the top 7 plus Other', () => {
    const jobs = Array.from({ length: 9 }, (_, i) => job(`j${i}`, 0, 60 * (i + 1)));
    const m = minutesPerDay([run(0, { jobs })], 'job', epoch);
    expect(m.keys).toEqual(['j8', 'j7', 'j6', 'j5', 'j4', 'j3', 'j2', 'Other']);
    expect(m.days[0]?.parts.at(-1)).toEqual({ key: 'Other', minutes: 3 });
    expect(m.days[0]?.total).toBe(45);
  });
});

describe('splitPeriods', () => {
  test('attempt 1 before and attempt 2 in the span count once in each period', () => {
    const rows: CicdRow[] = [
      cicd('run', 'ta1', { start: 10 * SEC, end: 20 * SEC, runId: '9', attempt: 1, result: 'failure' }),
      cicd('job', 'ta1', { start: 10 * SEC, end: 20 * SEC, task: 'check' }),
      cicd('run', 'ta2', { start: 110 * SEC, end: 130 * SEC, runId: '9', attempt: 2, result: 'success' }),
      cicd('tasks', 'orphan', { start: 110 * SEC, end: 110 * SEC }),
    ];
    const p = splitPeriods(rows, [100 * SEC, 200 * SEC]);
    expect(p.runs.map((r) => [r.runId, r.attempt, r.attempts])).toEqual([['9', 2, 1]]);
    expect(p.previous.map((r) => [r.runId, r.attempt, r.attempts])).toEqual([['9', 1, 1]]);
    expect(p.previous[0]?.jobs).toHaveLength(1);
  });
});

describe('empty input', () => {
  test('every result is empty and every number finite', () => {
    const results = [
      stat('success-rate', [], []),
      stat('queue-p95', [], []),
      trendBuckets([], [0, 0]),
      trendBuckets([], [5, 1]),
      jobsTable([], []),
      statusGrid([], 60),
      failures([], 10),
      triggers([]),
      queue([]),
      minutesPerDay([], 'job', 0n),
      rerunsAndCancelled([]),
    ];
    expect(stat('median-run', [], []).value).toBe('–');
    expect(trendBuckets([], [0, DAY]).buckets).toEqual([]);
    expect(statusGrid([], 60).rows).toEqual([]);
    everyNumberFinite(results);
  });

  test('runs with no jobs and zero durations stay finite', () => {
    const runs = [
      run(0, { duration: 0, minutes: 0, jobs: [] }),
      run(0, { duration: 0, minutes: 0, jobs: [] }),
    ];
    const results = [
      ...(['success-rate', 'median-run', 'cache', 'minutes', 'queue-p95', 'reruns'] as const).map((k) =>
        stat(k, runs, runs),
      ),
      trendBuckets(runs, [0, 0]),
      jobsTable(runs, runs),
      statusGrid(runs, 60),
      triggers(runs),
      queue(runs),
      minutesPerDay(runs, 'trigger', 0n),
      rerunsAndCancelled(runs),
    ];
    everyNumberFinite(results);
  });
});

function cicd(kind: CicdRow['kind'], traceId: string, over: Partial<CicdRow>): CicdRow {
  return {
    kind,
    traceId,
    spanId: kind === 'job' ? `${traceId}-j` : null,
    start: 0,
    end: 0,
    name: null,
    result: 'success',
    pipeline: 'ci',
    runId: null,
    attempt: null,
    trigger: 'push',
    branch: 'main',
    revision: null,
    title: null,
    task: null,
    taskId: null,
    labels: null,
    queuedNs: null,
    needs: null,
    condition: null,
    failedStep: null,
    tasksReplayed: null,
    tasksRun: null,
    ...over,
  };
}
