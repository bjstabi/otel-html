import type { ApiJob } from './context.js';
import { type Attr, attrs, ms, ns, resultOf } from './otlp.js';
import { type ApiRun, jobResource } from './workflow-trace.js';

const BOUNDS = [1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600];
const DELTA = 1;

type HistogramPoint = { attributes: Attr[]; seconds: number };

function histogram(name: string, description: string, time: string, points: HistogramPoint[]): object[] {
  if (points.length === 0) return [];
  return [
    {
      name,
      description,
      unit: 's',
      histogram: {
        aggregationTemporality: DELTA,
        dataPoints: points.map((p) => {
          const bucketCounts = new Array<number>(BOUNDS.length + 1).fill(0);
          // Upper bounds are inclusive; anything past the last bound goes in the overflow bucket.
          const at = BOUNDS.findIndex((b) => p.seconds <= b);
          bucketCounts[at === -1 ? BOUNDS.length : at] = 1;
          return {
            startTimeUnixNano: time,
            timeUnixNano: time,
            count: '1',
            sum: p.seconds,
            min: p.seconds,
            max: p.seconds,
            bucketCounts: bucketCounts.map(String),
            explicitBounds: BOUNDS,
            attributes: p.attributes,
          };
        }),
      },
    },
  ];
}

/** Seconds between two API timestamps; undefined when either is absent or unparsable, never negative. */
function seconds(from: string | null, to: string | null): number | undefined {
  const a = ms(from);
  const b = ms(to);
  return a === undefined || b === undefined ? undefined : Math.max(0, b - a) / 1000;
}

export function ciMetricsRequest(run: ApiRun, jobs: ApiJob[], resource: Record<string, string>): object {
  const time = ns(ms(run.updated_at) ?? 0);
  const metrics: object[] = [];

  const runSeconds = seconds(run.run_started_at ?? run.created_at, run.updated_at);
  if (runSeconds !== undefined) {
    metrics.push(
      ...histogram('cicd.pipeline.run.duration', 'Duration of a workflow run', time, [
        {
          seconds: runSeconds,
          attributes: attrs({
            'cicd.pipeline.name': run.name,
            'cicd.pipeline.result': run.conclusion === null ? undefined : resultOf(run.conclusion),
          }),
        },
      ]),
    );
  }

  // Per-job points sit under that job's own resource, so a `cicd.pipeline.task.name` variable selects them.
  const jobMetrics: { job: ApiJob; metrics: object[] }[] = [];
  for (const job of jobs) {
    const took = seconds(job.started_at, job.completed_at);
    const taskPoints: HistogramPoint[] =
      took === undefined
        ? []
        : [
            {
              seconds: took,
              attributes: attrs({
                'cicd.pipeline.task.name': job.name,
                'cicd.pipeline.task.run.result':
                  job.conclusion === null ? undefined : resultOf(job.conclusion),
              }),
            },
          ];
    const queued = seconds(job.created_at, job.started_at);
    const queuePoints: HistogramPoint[] =
      queued === undefined
        ? []
        : [{ seconds: queued, attributes: attrs({ 'cicd.pipeline.task.name': job.name }) }];
    jobMetrics.push({
      job,
      metrics: [
        ...histogram('cicd.pipeline.task.run.duration', 'Duration of a job', time, taskPoints),
        ...histogram(
          'cicd.pipeline.task.run.queue.duration',
          'Time a job waited for a runner',
          time,
          queuePoints,
        ),
      ],
    });
  }

  // A skipped job is not an error; a job without a conclusion has not finished.
  const failed = jobs.filter(
    (j) => j.conclusion !== null && j.conclusion !== 'success' && j.conclusion !== 'skipped',
  );
  if (failed.length > 0) {
    metrics.push({
      name: 'cicd.pipeline.run.errors',
      description: 'Jobs that ended in an error',
      unit: '{error}',
      sum: {
        aggregationTemporality: DELTA,
        isMonotonic: true,
        dataPoints: failed.map((j) => ({
          startTimeUnixNano: time,
          timeUnixNano: time,
          asInt: '1',
          attributes: attrs({ 'cicd.pipeline.name': run.name, 'error.type': j.conclusion }),
        })),
      },
    });
  }

  const scoped = (r: Record<string, string>, m: object[]): object => ({
    resource: { attributes: attrs(r) },
    scopeMetrics: [{ scope: { name: 'otel-html-ci' }, metrics: m }],
  });
  return {
    resourceMetrics: [
      scoped(resource, metrics),
      ...jobMetrics
        .filter((g) => g.metrics.length > 0)
        .map((g) => scoped(jobResource(run, g.job), g.metrics)),
    ],
  };
}
