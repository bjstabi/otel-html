import type { ApiJob } from './github-api.js';
import { type JobId, jobSpanIdOf, stepSpanIdOf, traceIdOf } from './ids.js';
import { type Attr, attrs, ms, ns } from './otlp.js';

const SEVERITY_ERROR = 17;
const SEVERITY_WARN = 13;
const SEVERITY_INFO = 9;
const SEVERITY_DEBUG = 5;

const SEVERITIES: Readonly<Record<string, { number: number; text: string }>> = {
  error: { number: SEVERITY_ERROR, text: 'ERROR' },
  warning: { number: SEVERITY_WARN, text: 'WARN' },
  debug: { number: SEVERITY_DEBUG, text: 'DEBUG' },
};

const INFO = { number: SEVERITY_INFO, text: 'INFO' };
const TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z /;
const MARKER = /^##\[(error|warning|debug|group|endgroup|command)\]/;

/** Nanoseconds of a log timestamp, keeping every fractional digit (no float milliseconds). */
function nanosOf(whole: string, fraction: string | undefined): bigint | undefined {
  const sec = Date.parse(`${whole}Z`);
  if (Number.isNaN(sec)) return undefined;
  return BigInt(sec) * 1_000_000n + BigInt((fraction ?? '').padEnd(9, '0'));
}

/** API times are truncated to whole seconds, so a step's end covers the rest of that second. */
const SECOND_ROUNDING = 999_999_999n;

type Window = { start: bigint; end: bigint; number: number };

/** Step windows in nanoseconds; a step lacking `completed_at` extends to the job end (or without bound). */
function stepWindows(job: ApiJob): Window[] {
  const jobEnd = ms(job.completed_at);
  const out: Window[] = [];
  for (const step of job.steps) {
    const start = ms(step.started_at);
    if (start === undefined) continue;
    const end = ms(step.completed_at) ?? jobEnd;
    out.push({
      start: BigInt(ns(start)),
      end:
        end === undefined
          ? BigInt(Number.MAX_SAFE_INTEGER) * 1_000_000_000n
          : BigInt(ns(end)) + SECOND_ROUNDING,
      number: step.number,
    });
  }
  return out;
}

type Draft = {
  time: bigint;
  severity: { number: number; text: string };
  body: string;
  group: string | undefined;
};

export function jobLogRecordsRequest(i: {
  key: string;
  jobId: JobId;
  job: ApiJob;
  text: string;
  resource: Record<string, string>;
}): object {
  const traceId = traceIdOf(i.key);
  const jobSpanId = jobSpanIdOf(i.key, i.jobId);
  const windows = stepWindows(i.job);
  const jobStart = BigInt(ns(ms(i.job.started_at) ?? ms(i.job.created_at) ?? 0));

  const lines = i.text.replace(/^\uFEFF/, '').split(/\r\n|\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const drafts: Draft[] = [];
  let group: string | undefined;
  let last: Draft | undefined;

  for (const line of lines) {
    const m = TIMESTAMP.exec(line);
    const time = m === null ? undefined : nanosOf(m[1] ?? '', m[2]);
    if (m === null || time === undefined) {
      // Continuation of a multi-line message: join the previous record, or open one at the job start.
      if (last !== undefined) {
        last.body += `\n${line}`;
      } else {
        last = { time: jobStart, severity: INFO, body: line, group };
        drafts.push(last);
      }
      continue;
    }
    const rest = line.slice(m[0].length);
    const marker = MARKER.exec(rest)?.[1];
    if (marker === 'group') {
      group = rest.slice('##[group]'.length);
      continue;
    }
    if (marker === 'endgroup') {
      group = undefined;
      continue;
    }
    const body = rest;
    last = { time, severity: SEVERITIES[marker ?? ''] ?? INFO, body, group };
    drafts.push(last);
  }

  const logRecords = drafts.map((d) => {
    let step: Window | undefined;
    for (const w of windows) {
      // Among overlapping windows the step that began most recently owns the line.
      if (d.time >= w.start && d.time <= w.end && (step === undefined || w.start >= step.start)) step = w;
    }
    const attributes: Attr[] = attrs({
      'log.group': d.group,
      'cicd.pipeline.task.run.id': step?.number === undefined ? undefined : String(step.number),
    });
    return {
      timeUnixNano: d.time.toString(),
      severityNumber: d.severity.number,
      severityText: d.severity.text,
      body: { stringValue: d.body },
      attributes,
      traceId,
      spanId: step === undefined ? jobSpanId : stepSpanIdOf(i.key, i.jobId, step.number),
    };
  });

  return {
    resourceLogs: [
      {
        resource: { attributes: attrs(i.resource) },
        scopeLogs: [{ scope: { name: 'otel-html-ci' }, logRecords }],
      },
    ],
  };
}
