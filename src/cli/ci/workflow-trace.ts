import type { ApiJob, ApiRun, ApiStep } from './github-api.js';
import { type JobId, jobSpanIdOf, runSpanIdOf, stepSpanIdOf, traceIdOf } from './ids.js';
import { type Attr, attrs, ms, ns, resultOf } from './otlp.js';
import { jobIdFor } from './publish.js';

/** The resource attributes every CI record carries, plus the service identity of the workflow run. */
export function ciResource(run: ApiRun): Record<string, string> {
  return {
    'cicd.pipeline.name': run.name,
    'cicd.pipeline.run.id': String(run.id),
    'cicd.pipeline.run.url.full': run.html_url,
    ...(run.head_branch === null ? {} : { 'vcs.ref.head.name': run.head_branch }),
    'vcs.ref.head.revision': run.head_sha,
    'vcs.repository.url.full': run.repository.html_url,
    'service.name': run.name,
    'service.namespace': run.repository.full_name,
    'service.instance.id': `${run.id}/${run.run_attempt}`,
  };
}

/** The run's resource plus the job's name: the resource every record scoped to one job carries. */
export function jobResource(run: ApiRun, job: ApiJob): Record<string, string> {
  return { ...ciResource(run), 'cicd.pipeline.task.name': job.name };
}

type Status = { code: number; message: string };

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_SERVER = 2;
const STATUS_ERROR = 2;

/** A conclusion other than success/skip is an error status carrying the conclusion; an unfinished one has none. */
function statusOf(conclusion: string | null): Status | undefined {
  if (conclusion === null || conclusion === 'success' || conclusion === 'skipped') return undefined;
  return { code: STATUS_ERROR, message: resultOf(conclusion) };
}

type SpanInput = {
  name: string;
  spanId: string;
  parentSpanId?: string;
  kind: number;
  start: number;
  end: number;
  attributes: Attr[];
  status?: Status | undefined;
};

/** `key` is the run key (`runKey`) every record of the run, logs included, derives its ids from. */
export function workflowTraceRequest(
  key: string,
  run: ApiRun,
  jobs: ApiJob[],
  approximate: ReadonlyMap<number, JobId>,
): object {
  const traceId = traceIdOf(key);
  const runSpanId = runSpanIdOf(key);

  const runStart = runStartOf(run);
  const runEnd = Math.max(runStart, ms(run.updated_at) ?? runStart);
  const spans: SpanInput[] = [];
  // Each job's spans sit under that job's own resource, so a `cicd.pipeline.task.name` variable selects them.
  const jobGroups: { job: ApiJob; spans: SpanInput[] }[] = [];

  spans.push(rootSpan(run, runSpanId, runStart, runEnd, false));

  for (const job of jobs) {
    const jobSpans = jobSpansOf(key, job, runSpanId, runStart, runEnd, approximate, undefined);
    jobGroups.push({ job, spans: jobSpans });
  }

  return {
    resourceSpans: [
      toGroup(traceId, ciResource(run), spans),
      ...jobGroups.map((g) => toGroup(traceId, jobResource(run, g.job), g.spans)),
    ],
  };
}

/** Marks a root or job span that was built while its run or job was still going (§5.5); the final trace replaces it. */
export const PROVISIONAL_ATTR = 'otel_html.ci.provisional';

/**
 * §5.5: the provisional workflow root (start = the run's start, end = `now`, `otel_html.ci.provisional: true`), this
 * job's span (start known, end = `now`, provisional) with its `queued` span and the steps that have `completed_at`
 * (final), under the same resources, ids and attributes as `workflowTraceRequest`.
 */
export function jobTraceRequest(
  key: string,
  run: ApiRun,
  job: ApiJob,
  now: number,
  approximate: ReadonlyMap<number, JobId>,
): object {
  const traceId = traceIdOf(key);
  const runSpanId = runSpanIdOf(key);
  const runStart = runStartOf(run);
  const end = Math.max(runStart, now);
  return {
    resourceSpans: [
      toGroup(traceId, ciResource(run), [rootSpan(run, runSpanId, runStart, end, true)]),
      toGroup(
        traceId,
        jobResource(run, job),
        jobSpansOf(key, job, runSpanId, runStart, end, approximate, end),
      ),
    ],
  };
}

function runStartOf(run: ApiRun): number {
  const start = ms(run.run_started_at) ?? ms(run.created_at);
  if (start === undefined)
    throw new Error(`workflow run ${run.id} has no parsable run_started_at or created_at`);
  return start;
}

function toGroup(traceId: string, resource: Record<string, string>, group: SpanInput[]): object {
  return {
    resource: { attributes: attrs(resource) },
    scopeSpans: [
      {
        scope: { name: 'otel-html-ci' },
        spans: group.map((s) => ({
          traceId,
          spanId: s.spanId,
          ...(s.parentSpanId === undefined ? {} : { parentSpanId: s.parentSpanId }),
          name: s.name,
          kind: s.kind,
          startTimeUnixNano: ns(s.start),
          endTimeUnixNano: ns(s.end),
          attributes: s.attributes,
          ...(s.status === undefined ? {} : { status: s.status }),
        })),
      },
    ],
  };
}

function rootSpan(run: ApiRun, spanId: string, start: number, end: number, provisional: boolean): SpanInput {
  return {
    name: run.name,
    spanId,
    kind: SPAN_KIND_SERVER,
    start,
    end,
    attributes: attrs({
      'cicd.pipeline.name': run.name,
      'cicd.pipeline.run.id': String(run.id),
      'cicd.pipeline.result': run.conclusion === null ? undefined : resultOf(run.conclusion),
      'cicd.pipeline.run.url.full': run.html_url,
      'github.run_id': run.id,
      'github.run_attempt': run.run_attempt,
      'github.event': run.event,
      'github.html_url': run.html_url,
      [PROVISIONAL_ATTR]: provisional ? true : undefined,
    }),
    status: statusOf(run.conclusion),
  };
}

/**
 * One job's spans: the job, its `queued` span and its steps. With `provisionalEnd` the job ends there, is marked
 * provisional, and only steps with `completed_at` are emitted.
 */
function jobSpansOf(
  key: string,
  job: ApiJob,
  runSpanId: string,
  runStart: number,
  runEnd: number,
  approximate: ReadonlyMap<number, JobId>,
  provisionalEnd: number | undefined,
): SpanInput[] {
  const jobSpans: SpanInput[] = [];
  const isApprox = approximate.has(job.id);
  const jobKeyId = jobIdFor(job, approximate);
  const jobSpanId = jobSpanIdOf(key, jobKeyId);
  const jobStart = ms(job.started_at) ?? runStart;
  const jobEndFallback = provisionalEnd ?? ms(job.completed_at) ?? runEnd;
  const jobEnd = Math.max(jobStart, jobEndFallback);

  jobSpans.push({
    name: job.name,
    spanId: jobSpanId,
    parentSpanId: runSpanId,
    kind: SPAN_KIND_INTERNAL,
    start: jobStart,
    end: jobEnd,
    attributes: attrs({
      'cicd.pipeline.task.name': job.name,
      'cicd.pipeline.task.run.id': String(job.id),
      'cicd.pipeline.task.run.result': job.conclusion === null ? undefined : resultOf(job.conclusion),
      'cicd.pipeline.task.run.url.full': job.html_url,
      'cicd.worker.name': job.runner_name,
      'github.job.id': job.id,
      'github.html_url': job.html_url,
      'otel_html.ci.parent_approximate': isApprox ? true : undefined,
      [PROVISIONAL_ATTR]: provisionalEnd === undefined ? undefined : true,
    }),
    status: statusOf(job.conclusion),
  });

  const queuedStart = ms(job.created_at);
  const queuedEnd = ms(job.started_at);
  if (queuedStart !== undefined && queuedEnd !== undefined) {
    jobSpans.push({
      name: 'queued',
      spanId: jobSpanIdOf(key, `${jobKeyId}#queued`),
      parentSpanId: jobSpanId,
      kind: SPAN_KIND_INTERNAL,
      start: queuedStart,
      end: Math.max(queuedStart, queuedEnd),
      attributes: attrs({ 'cicd.pipeline.task.name': job.name }),
    });
  }

  for (const step of job.steps) {
    if (provisionalEnd !== undefined && step.completed_at === null) continue;
    jobSpans.push(stepSpan(key, jobKeyId, jobSpanId, step, jobStart, jobEndFallback));
  }
  return jobSpans;
}

function stepSpan(
  key: string,
  jobKeyId: number | string,
  jobSpanId: string,
  step: ApiStep,
  jobStart: number,
  jobEnd: number,
): SpanInput {
  const start = ms(step.started_at) ?? jobStart;
  return {
    name: step.name,
    spanId: stepSpanIdOf(key, jobKeyId, step.number),
    parentSpanId: jobSpanId,
    kind: SPAN_KIND_INTERNAL,
    start,
    end: Math.max(start, ms(step.completed_at) ?? jobEnd),
    attributes: attrs({ 'github.job.step.name': step.name, 'github.job.step.number': step.number }),
    status: statusOf(step.conclusion),
  };
}
