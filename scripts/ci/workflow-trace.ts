import type { ApiJob, ApiStep } from './context.js';
import { jobSpanIdOf, runKey, runSpanIdOf, stepSpanIdOf, traceIdOf } from './ids.js';

/** The subset of the Actions run API that the CI scripts read. */
export type ApiRun = {
  id: number;
  run_attempt: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string | null;
  updated_at: string;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  repository: { full_name: string; html_url: string };
};

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

const RESULTS: Readonly<Record<string, string>> = {
  success: 'success',
  failure: 'failure',
  cancelled: 'cancellation',
  timed_out: 'timeout',
  skipped: 'skip',
};

const resultOf = (conclusion: string): string => RESULTS[conclusion] ?? 'error';

type AttrValue = string | number | boolean;
type Attr = { key: string; value: { stringValue: string } | { intValue: string } | { boolValue: boolean } };
type Status = { code: number; message: string };

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_SERVER = 2;
const STATUS_ERROR = 2;

function attrs(values: Record<string, AttrValue | null | undefined>): Attr[] {
  const out: Attr[] = [];
  for (const [key, v] of Object.entries(values)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') out.push({ key, value: { stringValue: v } });
    else if (typeof v === 'boolean') out.push({ key, value: { boolValue: v } });
    else out.push({ key, value: { intValue: String(v) } });
  }
  return out;
}

/** Epoch milliseconds of an API timestamp; unparsable values count as absent. */
function ms(s: string | null | undefined): number | undefined {
  if (s === null || s === undefined) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

const ns = (t: number): string => (BigInt(t) * 1_000_000n).toString();

/** A conclusion other than success/skip is an error status carrying the conclusion; an unfinished one has none. */
function statusOf(conclusion: string | null): Status | undefined {
  if (conclusion === null || conclusion === 'success' || conclusion === 'skipped') return undefined;
  return { code: STATUS_ERROR, message: conclusion };
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

export function workflowTraceRequest(run: ApiRun, jobs: ApiJob[], approximate: ReadonlySet<number>): object {
  const key = runKey({ repository: run.repository.full_name, runId: run.id, runAttempt: run.run_attempt });
  const traceId = traceIdOf(key);
  const runSpanId = runSpanIdOf(key);

  const runStart = ms(run.run_started_at) ?? ms(run.created_at) ?? 0;
  const runEnd = Math.max(runStart, ms(run.updated_at) ?? runStart);
  const spans: SpanInput[] = [];
  const runResult = run.conclusion === null ? undefined : resultOf(run.conclusion);

  spans.push({
    name: run.name,
    spanId: runSpanId,
    kind: SPAN_KIND_SERVER,
    start: runStart,
    end: runEnd,
    attributes: attrs({
      'cicd.pipeline.name': run.name,
      'cicd.pipeline.run.id': String(run.id),
      'cicd.pipeline.result': runResult,
      'cicd.pipeline.run.url.full': run.html_url,
      'github.run_id': run.id,
      'github.run_attempt': run.run_attempt,
      'github.event': run.event,
      'github.html_url': run.html_url,
    }),
    status: statusOf(run.conclusion),
  });

  for (const job of jobs) {
    const isApprox = approximate.has(job.id);
    const jobKeyId = isApprox ? `name:${job.name}` : job.id;
    const jobSpanId = jobSpanIdOf(key, jobKeyId);
    const jobStart = ms(job.started_at) ?? runStart;
    const jobEndFallback = ms(job.completed_at) ?? runEnd;
    const jobEnd = Math.max(jobStart, jobEndFallback);

    spans.push({
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
      }),
      status: statusOf(job.conclusion),
    });

    const queuedStart = ms(job.created_at);
    const queuedEnd = ms(job.started_at);
    if (queuedStart !== undefined && queuedEnd !== undefined) {
      spans.push({
        name: 'queued',
        spanId: jobSpanIdOf(key, `${jobKeyId}#queued`),
        parentSpanId: jobSpanId,
        kind: SPAN_KIND_INTERNAL,
        start: queuedStart,
        end: Math.max(queuedStart, queuedEnd),
        attributes: attrs({ 'cicd.pipeline.task.name': 'queued' }),
      });
    }

    for (const step of job.steps) {
      spans.push(stepSpan(key, jobKeyId, jobSpanId, step, jobStart, jobEndFallback));
    }
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: attrs(ciResource(run)) },
        scopeSpans: [
          {
            scope: { name: 'otel-html-ci' },
            spans: spans.map((s) => ({
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
      },
    ],
  };
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
    attributes: attrs({ 'cicd.pipeline.task.name': step.name, 'github.job.step.number': step.number }),
    status: statusOf(step.conclusion),
  };
}
