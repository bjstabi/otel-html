import { afterAll, describe, expect, test, vi } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import type { ManifestV4 } from '../../src/format/manifest.js';
import type { OtlpRequest } from '../../src/model/otlp-json.js';
import type { MetricQuery } from '../../src/query/metric-query.js';
import { type MetricContext, metricMethods } from '../../src/viewer/data/duckdb-metrics.js';
import type { MetricRunQueryRequest } from '../../src/viewer/data/metric-results.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import { buildFormat4Report, openFixtureDb } from '../../test-support/format4-fixture.js';
import { attr, histogram, metricsRequest, pointsAt, summary } from '../../test-support/otlp-builders.js';
import { openCountingEngine } from '../../test-support/scaling/counting-engine.js';
import { BASE, buildScalingReport } from '../../test-support/scaling/generator.js';
import { metricRunQueryWhole } from '../../test-support/scaling/metric-run-whole.js';
import { otlp } from '../../test-support/writer-deps.js';

vi.setConfig({ testTimeout: 30_000 });

const S = 1e9;
const sec = (...s: number[]): number[] => s.map((x) => x * 1000);
const str = (v: string) => ({ stringValue: v });
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const RUN = 'resource.attributes["cicd.pipeline.run.id"]';
const KEYED: ConfigInput = { writer: { statisticsKeys: ['resource:cicd.pipeline.run.id'] } };
const STAT = 'resource:cicd.pipeline.run.id';

const query = (metric: string, over: Partial<MetricQuery> = {}): MetricQuery => ({
  id: 'a',
  metric,
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

interface Job {
  run: string | null;
  sha: string | null;
  job: string;
  at: number[];
  result: string;
  /** the point attributes in the order `result`, `job` */
  swap: boolean;
  metric: 'job.duration' | 'job.latency';
}
const job = (
  run: string | null,
  sha: string | null,
  name: string,
  at: number[],
  over: Partial<Job> = {},
): Job => ({ run, sha, job: name, at, result: 'success', swap: false, metric: 'job.duration', ...over });

/** One partition: a request whose resources are the jobs'. */
function partition(jobs: Job[]): OtlpRequest {
  const resourceMetrics = jobs.map((j) => {
    const attrs = [attr('job', str(j.job)), attr('result', str(j.result))];
    const points = pointsAt(
      sec(...j.at),
      (i) =>
        j.metric === 'job.duration'
          ? { count: '1', sum: 10 + i, explicitBounds: [10, 100], bucketCounts: ['0', '1', '0'] }
          : { count: '2', sum: 3 + i, quantileValues: [{ quantile: 0.5, value: 1 + i }] },
      j.swap ? [...attrs].reverse() : attrs,
    );
    const metric =
      j.metric === 'job.duration'
        ? histogram(j.metric, points, { temporality: 'delta', unit: 's' })
        : summary(j.metric, points);
    const resource = [
      attr('service.name', str('ci')),
      ...(j.run === null ? [] : [attr('cicd.pipeline.run.id', str(j.run))]),
      ...(j.sha === null ? [] : [attr('vcs.ref.head.revision', str(j.sha))]),
    ];
    const [rm] = (metricsRequest([metric], resource) as { resourceMetrics: unknown[] }).resourceMetrics;
    return rm;
  });
  return otlp({ resourceMetrics } as never);
}

// Three partitions: before the window (0-10 s), in it (110-140 s) and after it (300-310 s).
const P0 = partition([
  job('r1', 'sha1', 'build', [0, 10]),
  job('r1', 'sha1', 'check', [10]),
  job('r0', 'sha0', 'build', [5]),
  job('r5', 'sha5', 'build', [0]), // (h) the only point of r5 with a revision
  job(null, null, 'build', [3]), // (c) no run value
  job(null, null, 'lint', [4]),
]);
const P1 = partition([
  job('r1', 'sha1', 'build', [110]), // (a) starts before the window, its latest point is inside
  job('r2', 'sha2', 'check', [112], { result: 'failure' }),
  job('r3', 'sha3', 'build', [120]), // (b) its latest point is after the window (P2)
  job('r5', null, 'build', [130]), // (h) its latest point has no revision
  job(null, null, 'lint', [140], { swap: true }), // (i) the series of P0, its attributes in the other order
  job('r1', 'sha1', 'lat', [111], { metric: 'job.latency' }),
  job('r2', 'sha2', 'lat', [113], { metric: 'job.latency' }),
]);
const P2 = partition([job('r3', 'sha3', 'build', [300]), job('r4', 'sha4', 'build', [310])]);

const opened: TestDb[] = [];
afterAll(() => {
  for (const d of opened) d.close();
});

async function open(
  config: ConfigInput,
  patch: (m: ManifestV4) => ManifestV4 = (m) => m,
): Promise<MetricContext> {
  const fx = await buildFormat4Report([P0, P1, P2], { config, close: false });
  const db = await openFixtureDb(fx);
  opened.push(db);
  const engine = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
  return { engine, manifest: patch(fx.manifest), epoch: fx.epoch, range: { start: 0, end: 4000 * S } };
}

/** The points file of partition `i` with its run statistic unknown (a key over its cap). */
const unknownStat = (i: number) => (m: ManifestV4) => ({
  ...m,
  partitions: m.partitions.map((p, k) => {
    const points = p.files.points;
    return k !== i || points === undefined
      ? p
      : { ...p, files: { ...p.files, points: { ...points, values: { ...points.values, [STAT]: null } } } };
  }),
});

const W = { start: 100 * S, end: 200 * S };

async function check(
  ctx: MetricContext,
  over: Partial<MetricRunQueryRequest> & { q?: Partial<MetricQuery>; metric?: string } = {},
) {
  const m = metricMethods(ctx);
  const cat = await m.metricCatalog();
  const name = over.metric ?? 'job.duration';
  const entry = cat.entries.find((e) => e.name === name);
  if (entry === undefined) throw new Error(`no ${name}`);
  const req: MetricRunQueryRequest = {
    entry,
    query: query(name, over.q),
    window: W,
    runBy: RUN,
    failedWhen: null,
    ...(over.window === undefined ? {} : { window: over.window }),
    ...(over.runBy === undefined ? {} : { runBy: over.runBy }),
    ...(over.failedWhen === undefined ? {} : { failedWhen: over.failedWhen }),
    ...(over.resources === undefined ? {} : { resources: over.resources }),
  };
  const got = await m.metricRunQuery(req);
  expect(got).toEqual(await metricRunQueryWhole(ctx, req));
  return got;
}

describe('metricRunQuery answers as the whole read does', () => {
  test('a run that began before the window, one that ends after it, series without a run, a revision only an earlier point carries', async () => {
    const ctx = await open(KEYED);
    const r = await check(ctx);
    expect(r.runs.map((x) => [x.id, x.time / S])).toEqual([
      ['r1', 110],
      ['r2', 112],
      ['r5', 130],
    ]);
    // (c) and (i): two series have no run, the second stored twice under two attribute orders
    expect(r.leftOut).toBe(2);
    expect(r.lines.map((l) => l.label).sort()).toEqual(['build', 'check']);
  });

  test('failedWhen, a where, a residual where, a resources filter, a summary and other windows', async () => {
    const ctx = await open(KEYED);
    const failed = await check(ctx, { failedWhen: 'attributes["result"] == "failure"' });
    expect(failed.lines.flatMap((l) => l.points.map((p) => p?.failed))).toContain(true);
    await check(ctx, { q: { where: 'attributes["job"] == "build"' } });
    // `Len` has no SQL form: the term is evaluated in the browser (D5)
    const residual = await check(ctx, { q: { where: 'Len(attributes["job"]) > 4' } });
    expect(residual.notes.join(' ')).toMatch(/browser/);
    await check(ctx, { resources: [0, 1] });
    const lat = await check(ctx, { metric: 'job.latency', q: { show: 'q0.5', by: [] } });
    expect(lat.runs.map((x) => x.id)).toEqual(['r1', 'r2']);
    await check(ctx, { window: { start: 0, end: 1000 * S } });
    await check(ctx, { window: { start: -Infinity, end: Infinity } });
    // no run in the window: no line, the series left out are still counted and noted
    const none = await check(ctx, { window: { start: 400 * S, end: 500 * S } });
    expect(none.runs).toEqual([]);
    expect(none.leftOut).toBe(2);
    await check(ctx, { window: { start: 150 * S, end: 160 * S } });
  });

  test('no statistics key for the run, a run expression that is not a resource attribute, a file whose statistic is unknown', async () => {
    await check(await open({}));
    await check(await open(KEYED), { runBy: 'attributes["job"]' });
    await check(await open(KEYED, unknownStat(0)));
    await check(await open(KEYED, unknownStat(1)), { failedWhen: 'attributes["result"] == "failure"' });
  });
});

describe('metricRunQuery reads the files of the runs it answers', () => {
  test('files before the window that hold none of the runs are not read', async () => {
    const report = await buildScalingReport({ ...BASE, outside: 8, inside: 2 });
    const counting = await openCountingEngine(report.dir, report.manifest);
    try {
      const m = metricMethods({
        engine: counting.engine,
        manifest: report.manifest,
        epoch: report.epoch,
        range: report.window,
      });
      const cat = await m.metricCatalog();
      const entry = cat.entries.find((e) => e.name === report.ids.metric);
      if (entry === undefined) throw new Error('no metric');
      await counting.cold();
      await counting.take();
      counting.prepared();
      const r = await m.metricRunQuery({
        entry,
        query: query(report.ids.metric, { by: [] }),
        window: report.window,
        runBy: 'resource.attributes["run.id"]',
        failedWhen: null,
      });
      expect(r.runs.length).toBeGreaterThan(0);
      const touched = new Set([...(await counting.take()).map((e) => e.path), ...counting.prepared().keys()]);
      const answer = new Set(r.runs.map((x) => x.id));
      const files = report.manifest.partitions.flatMap((p) => {
        const points = p.files.points;
        const runs = points?.values['resource:run.id'];
        return points === undefined || runs == null ? [] : [{ path: points.path, runs }];
      });
      const outside = files.filter((f) => !f.runs.some((v) => answer.has(v)));
      expect(outside.length).toBeGreaterThanOrEqual(8);
      expect(outside.filter((f) => touched.has(f.path))).toEqual([]);
      expect(files.filter((f) => f.runs.some((v) => answer.has(v))).every((f) => touched.has(f.path))).toBe(
        true,
      );
    } finally {
      await counting.close();
    }
  });
});
