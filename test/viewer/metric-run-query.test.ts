import { describe, expect, test } from 'vitest';
import type { AnyValue } from '../../src/model/anyvalue.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { BucketAgg } from '../../src/rollups/metric-agg.js';
import type { MetricEntry, SeriesDef } from '../../src/rollups/metric-catalog.js';
import { ValueBuckets } from '../../src/rollups/value-buckets.js';
import { type LoadedMetric, type LoadedSeries, metricFromLevels } from '../../src/viewer/data/metric-load.js';
import type { MetricQuery } from '../../src/viewer/data/metric-query.js';
import { runMetricRunQuery } from '../../src/viewer/data/metric-run-query.js';

const S = 1e9;
const WIDTH = 10 * S;
const RUN_BY = 'resource.attributes["cicd.pipeline.run.id"]';
const str = (value: string): AnyValue => ({ kind: 'string', value });

const ENTRY: MetricEntry = {
  id: 0,
  name: 'job.duration',
  description: '',
  unit: 's',
  type: 'histogram',
  temporality: 'delta',
  monotonic: false,
  conflicting: false,
  scopes: ['lib'],
  attributeKeys: [],
  resources: [],
  series: 0,
  folded: 0,
  foldedEvicted: 0,
  resets: 0,
  outOfOrder: 0,
  noValue: 0,
  points: 0,
  spark: new ValueBuckets(),
};

/** One histogram bucket holding `count` observations averaging `avg`. */
const obs = (avg: number, count = 1): BucketAgg => ({
  k: 'hist',
  count,
  sum: avg * count,
  min: avg,
  max: avg,
  bounds: [10, 100],
  counts: [0, count, 0],
});

interface Spec {
  /** Absent: the series carries no run id. */
  run?: string;
  revision?: string;
  job?: string;
  result?: string;
  other?: boolean;
  /** bucket index (of 10 s) → aggregate */
  buckets: [number, BucketAgg][];
}

function metric(specs: Spec[]): LoadedMetric {
  const series: LoadedSeries[] = specs.map((s, id) => {
    const def: SeriesDef = {
      id,
      resource: s.other === true ? -1 : id,
      scope: s.other === true ? -1 : 0,
      attributes: new Map([
        ['job', str(s.job ?? 'build')],
        ['result', str(s.result ?? 'success')],
      ]),
      bounds: [10, 100],
      other: s.other === true,
    };
    const rattrs = new Map<string, AnyValue>([['service.name', str('ci')]]);
    if (s.run !== undefined) rattrs.set('cicd.pipeline.run.id', str(s.run));
    if (s.revision !== undefined) rattrs.set('vcs.ref.head.revision', str(s.revision));
    return {
      def,
      resource: s.other === true ? null : { attributes: rattrs, droppedAttributesCount: 0, schemaUrl: '' },
      scope:
        s.other === true
          ? null
          : { name: 'lib', version: '1', attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' },
    };
  });
  return metricFromLevels(
    { entry: { ...ENTRY, series: specs.length }, series, gaps: null, quantiles: null, fromSegments: false },
    [
      {
        level: 0,
        widthNs: WIDTH,
        series: new Map(
          specs.map((s, id) => [id, { t: s.buckets.map(([t]) => t), a: s.buckets.map(([, a]) => a) }]),
        ),
        exemplars: [],
      },
    ],
  );
}

const query = (over: Partial<MetricQuery> = {}): MetricQuery => ({
  id: 'a',
  metric: 'job.duration',
  kind: null,
  unit: null,
  show: 'avg',
  by: ['attributes["job"]'],
  where: null,
  fn: [],
  alias: null,
  hidden: false,
  ...over,
});

const ALL = { start: 0, end: 1000 * S };
const opts = { window: ALL, runBy: RUN_BY, failedWhen: null };

/** Runs r1..r3 (revisions sha1..sha3): jobs build and check; run n's last point is at bucket 2n. */
const THREE_RUNS: Spec[] = [
  { run: 'r1', revision: 'sha1', job: 'build', buckets: [[1, obs(10)]] },
  { run: 'r1', revision: 'sha1', job: 'check', buckets: [[2, obs(20)]] },
  { run: 'r2', revision: 'sha2', job: 'build', buckets: [[10, obs(11)]] },
  { run: 'r2', revision: 'sha2', job: 'check', buckets: [[12, obs(21)]] },
  { run: 'r3', revision: 'sha3', job: 'build', buckets: [[20, obs(12)]] },
  { run: 'r3', revision: 'sha3', job: 'check', buckets: [[22, obs(22)]] },
];

describe('runMetricRunQuery', () => {
  test('one value per line per run', async () => {
    const r = await runMetricRunQuery(metric(THREE_RUNS), query(), opts);
    expect(r.runs.map((x) => x.id)).toEqual(['r1', 'r2', 'r3']);
    expect(r.runs.map((x) => x.revision)).toEqual(['sha1', 'sha2', 'sha3']);
    expect(r.lines.map((l) => l.points.map((p) => p?.value))).toEqual([
      [10, 11, 12],
      [20, 21, 22],
    ]);
    expect(r.lines[0]?.unit).toBe('s');
    expect(r.queryId).toBe('a');
    expect(r.leftOut).toBe(0);
  });

  test('labels are the group value', async () => {
    const r = await runMetricRunQuery(metric(THREE_RUNS), query(), opts);
    expect(r.lines.map((l) => l.label)).toEqual(['build', 'check']);
  });

  test("run time is the run's latest point", async () => {
    const r = await runMetricRunQuery(metric(THREE_RUNS), query(), opts);
    expect(r.runs.map((x) => x.time)).toEqual([2 * WIDTH, 12 * WIDTH, 22 * WIDTH]);
  });

  test('runs are ordered by time, then id', async () => {
    const specs: Spec[] = [
      { run: 'b', buckets: [[5, obs(1)]] },
      { run: 'a', buckets: [[5, obs(2)]] },
      { run: 'c', buckets: [[1, obs(3)]] },
    ];
    const r = await runMetricRunQuery(metric(specs), query({ by: [] }), opts);
    expect(r.runs.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  test('a re-run job combines', async () => {
    const specs: Spec[] = [
      { run: 'r1', job: 'build', buckets: [[1, obs(10)]] },
      { run: 'r1', job: 'build', buckets: [[3, obs(30)]] },
    ];
    const r = await runMetricRunQuery(metric(specs), query(), opts);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]?.points[0]?.value).toBe(20);
  });

  test('failedWhen marks a point', async () => {
    const specs = THREE_RUNS.map((s, i) => (i === 3 ? { ...s, result: 'failure' } : s));
    const r = await runMetricRunQuery(metric(specs), query(), {
      ...opts,
      failedWhen: 'attributes["result"] == "failure"',
    });
    expect(r.lines.map((l) => l.points.map((p) => p?.failed))).toEqual([
      [false, false, false],
      [false, true, false],
    ]);
  });

  test('a line missing from a run has null there', async () => {
    const specs = THREE_RUNS.filter((_, i) => i !== 3);
    const r = await runMetricRunQuery(metric(specs), query(), opts);
    expect(r.runs).toHaveLength(3);
    expect(r.lines[1]?.points.map((p) => p?.value ?? null)).toEqual([20, null, 22]);
  });

  test('a run outside the window is dropped', async () => {
    const r = await runMetricRunQuery(metric(THREE_RUNS), query(), {
      ...opts,
      window: { start: 0, end: 12 * WIDTH },
    });
    expect(r.runs.map((x) => x.id)).toEqual(['r1', 'r2']);
    expect(r.lines[0]?.points).toHaveLength(2);
  });

  test("a run whose time is in the window keeps its points before the window's start", async () => {
    const r = await runMetricRunQuery(metric(THREE_RUNS), query(), {
      ...opts,
      window: { start: 2 * WIDTH, end: 2 * WIDTH },
    });
    // r1's build point (bucket 1) precedes the window but belongs to a run whose time (bucket 2) is inside it.
    expect(r.runs.map((x) => x.id)).toEqual(['r1']);
    expect(r.lines.map((l) => l.points[0]?.value)).toEqual([10, 20]);
  });

  test('window echoes the option', async () => {
    const window = { start: 0, end: 12 * WIDTH };
    expect((await runMetricRunQuery(metric(THREE_RUNS), query(), { ...opts, window })).window).toBe(window);
  });

  test('series without the run attribute are left out', async () => {
    const specs: Spec[] = [...THREE_RUNS, { job: 'build', buckets: [[5, obs(99)]] }];
    const r = await runMetricRunQuery(metric(specs), query(), opts);
    expect(r.leftOut).toBe(1);
    expect(r.notes.some((n) => n.includes('1 series'))).toBe(true);
    expect(r.runs.every((x) => x.id !== '')).toBe(true);
    expect(r.runs).toHaveLength(3);
  });

  test.each(['nil', '"nil"', '["nil"]', 'vanilla'])(
    'a run id of %s is a run, not a missing one',
    async (run) => {
      const specs: Spec[] = [{ run, buckets: [[1, obs(10)]] }];
      const r = await runMetricRunQuery(metric(specs), query(), opts);
      expect(r.runs.map((x) => x.id)).toEqual([run]);
      expect(r.leftOut).toBe(0);
    },
  );

  test('a folded other series counts as left out', async () => {
    const specs: Spec[] = [...THREE_RUNS, { other: true, buckets: [[5, obs(99)]] }];
    const r = await runMetricRunQuery(metric(specs), query(), opts);
    expect(r.leftOut).toBe(1);
    expect(r.runs).toHaveLength(3);
  });

  test('empty by labels with the alias, else the metric name', async () => {
    const m = metric(THREE_RUNS);
    expect((await runMetricRunQuery(m, query({ by: [] }), opts)).lines.map((l) => l.label)).toEqual([
      'job.duration',
    ]);
    expect(
      (await runMetricRunQuery(m, query({ by: [], alias: 'Jobs' }), opts)).lines.map((l) => l.label),
    ).toEqual(['Jobs']);
  });

  test('an invalid show is rejected', async () => {
    await expect(runMetricRunQuery(metric(THREE_RUNS), query({ show: 'rate' }), opts)).rejects.toBeInstanceOf(
      OtelHtmlError,
    );
  });
});
