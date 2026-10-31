import { describe, expect, test } from 'vitest';
import type { ApiJob, ApiStep } from '../../../src/cli/ci/github-api.js';
import { jobSpanIdOf, runKey, stepSpanIdOf, traceIdOf } from '../../../src/cli/ci/ids.js';
import { jobLogRecordsRequest } from '../../../src/cli/ci/job-logs.js';
import { parseOtlpObject } from '../../../src/model/otlp-json.js';

const key = runKey({ repository: 'o/r', runId: 42, runAttempt: 1 });
const job: ApiJob = {
  id: 7,
  name: 'build',
  status: 'completed',
  runner_name: 'r1',
  conclusion: 'failure',
  created_at: '2026-01-01T00:00:00Z',
  started_at: '2026-01-01T00:00:10Z',
  completed_at: '2026-01-01T00:00:40Z',
  html_url: null,
  steps: [
    {
      number: 1,
      name: 'setup',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-01-01T00:00:10Z',
      completed_at: '2026-01-01T00:00:20Z',
    },
    {
      number: 2,
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-01-01T00:00:21Z',
      completed_at: null,
    },
  ],
};
const resource = { 'cicd.pipeline.name': 'ci' };

const LOG = [
  '2026-01-01T00:00:11.1234567Z ##[group]Run setup',
  '2026-01-01T00:00:12.0000001Z first info',
  '2026-01-01T00:00:13.5000000Z second info',
  '2026-01-01T00:00:14.0000000Z ##[warning]careful',
  'continued warning text',
  '2026-01-01T00:00:15.0000000Z ##[endgroup]',
  '2026-01-01T00:00:22.0000000Z ##[error]boom',
  '2026-01-01T00:00:23.0000000Z after the group',
  '',
].join('\n');

type Rec = {
  timeUnixNano: string;
  severityNumber: number;
  body: { stringValue: string };
  traceId: string;
  spanId: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
};

function records(text: string, j: ApiJob = job, jobId: number | string = 7): Rec[] {
  const req = jobLogRecordsRequest({ key, jobId, job: j, text, resource }) as {
    resourceLogs: { scopeLogs: { scope: { name: string }; logRecords: Rec[] }[] }[];
  };
  const [scope] = req.resourceLogs[0]?.scopeLogs ?? [];
  expect(scope?.scope.name).toBe('otel-html-ci');
  return scope?.logRecords ?? [];
}
const attr = (r: Rec, k: string) => r.attributes.find((a) => a.key === k)?.value;

describe('jobLogRecordsRequest', () => {
  test('counts records, drops markers and the trailing empty line', () => {
    expect(records(LOG).map((r) => r.body.stringValue)).toEqual([
      'first info',
      'second info',
      '##[warning]careful\ncontinued warning text',
      '##[error]boom',
      'after the group',
    ]);
  });

  test('maps severities', () => {
    expect(records(LOG).map((r) => r.severityNumber)).toEqual([9, 9, 13, 17, 9]);
    const dbg = records('2026-01-01T00:00:11.0000000Z ##[debug]d\n2026-01-01T00:00:12.0000000Z ##[command]c');
    expect(dbg.map((r) => r.severityNumber)).toEqual([5, 9]);
  });

  test('log.group spans group to endgroup', () => {
    expect(records(LOG).map((r) => attr(r, 'log.group')?.stringValue)).toEqual([
      'Run setup',
      'Run setup',
      'Run setup',
      undefined,
      undefined,
    ]);
  });

  test('keeps 100 ns precision', () => {
    const [r] = records(LOG);
    expect(r?.timeUnixNano).toBe('1767225612000000100');
  });

  test('attributes records to the step window, else the job span', () => {
    const rs = records(LOG);
    const step1 = stepSpanIdOf(key, 7, 1);
    const step2 = stepSpanIdOf(key, 7, 2);
    expect(rs.map((r) => r.spanId)).toEqual([step1, step1, step1, step2, step2]);
    expect(rs.map((r) => attr(r, 'cicd.pipeline.task.run.id')?.stringValue)).toEqual([
      '1',
      '1',
      '1',
      '2',
      '2',
    ]);
    expect(rs.every((r) => r.traceId === traceIdOf(key))).toBe(true);

    const gap = records('2026-01-01T00:00:09.5000000Z between');
    expect(gap[0]?.spanId).toBe(jobSpanIdOf(key, 7));
    expect(attr(gap[0] as Rec, 'cicd.pipeline.task.run.id')).toBeUndefined();
  });

  test("a step's last second belongs to the step, and the latest-starting step wins an overlap", () => {
    expect(records('2026-01-01T00:00:20.9000000Z ##[error]late')[0]?.spanId).toBe(stepSpanIdOf(key, 7, 1));
    const touching: ApiJob = {
      ...job,
      steps: [
        { ...(job.steps[0] as ApiStep), completed_at: '2026-01-01T00:00:20Z' },
        { ...(job.steps[1] as ApiStep), started_at: '2026-01-01T00:00:20Z' },
      ],
    };
    const rs = records('2026-01-01T00:00:19.9000000Z a\n2026-01-01T00:00:20.5000000Z b', touching);
    expect(rs.map((r) => r.spanId)).toEqual([stepSpanIdOf(key, 7, 1), stepSpanIdOf(key, 7, 2)]);
  });

  test('a step without completed_at extends to the job end', () => {
    expect(records('2026-01-01T00:00:39.0000000Z late')[0]?.spanId).toBe(stepSpanIdOf(key, 7, 2));
    expect(records('2026-01-01T00:00:41.0000000Z later')[0]?.spanId).toBe(jobSpanIdOf(key, 7));
  });

  test('approximate job ids hash by name', () => {
    const rs = records('2026-01-01T00:00:12.0000000Z x', job, 'name:build');
    expect(rs[0]?.spanId).toBe(stepSpanIdOf(key, 'name:build', 1));
  });

  test('a leading continuation becomes a record at the job start', () => {
    const rs = records('orphan\nmore\n2026-01-01T00:00:12.0000000Z real');
    expect(rs.map((r) => r.body.stringValue)).toEqual(['orphan\nmore', 'real']);
    expect(rs[0]?.timeUnixNano).toBe('1767225610000000000');
  });

  test('handles CRLF and a UTF-8 BOM', () => {
    const rs = records('\uFEFF2026-01-01T00:00:12.0000000Z a\r\nb\r\n2026-01-01T00:00:13.0000000Z c\r\n');
    expect(rs.map((r) => r.body.stringValue)).toEqual(['a\nb', 'c']);
  });

  test('empty text yields no records', () => {
    expect(records('')).toEqual([]);
  });

  test('the library accepts the output', () => {
    const [req] = parseOtlpObject(jobLogRecordsRequest({ key, jobId: 7, job, text: LOG, resource }), 'test');
    expect(req?.signal).toBe('logs');
  });
});
