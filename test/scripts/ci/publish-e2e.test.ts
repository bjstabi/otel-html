import { expect, test } from 'vitest';
import type { ApiJob, ApiRun } from '../../../scripts/ci/github-api.js';
import { runKey } from '../../../scripts/ci/ids.js';
import { jobLogRecordsRequest } from '../../../scripts/ci/job-logs.js';
import { ciMetricsRequest } from '../../../scripts/ci/metrics.js';
import { ciResource, jobResource, workflowTraceRequest } from '../../../scripts/ci/workflow-trace.js';
import { merge } from '../../../src/api/convert.js';
import { Report } from '../../../src/api/report.js';
import { createTestWriter } from '../../../test-support/writer-deps.js';
import { manifestOf } from '../../writer/helpers.js';

const run: ApiRun = {
  id: 42,
  run_attempt: 1,
  name: 'ci',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-01-01T00:00:00Z',
  run_started_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:01:00Z',
  html_url: 'https://github.com/o/r/actions/runs/42',
  head_branch: 'main',
  head_sha: 'abc',
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
};
const job: ApiJob = {
  id: 7,
  name: 'build',
  status: 'completed',
  runner_name: 'r1',
  conclusion: 'success',
  created_at: '2026-01-01T00:00:00Z',
  started_at: '2026-01-01T00:00:10Z',
  completed_at: '2026-01-01T00:00:40Z',
  html_url: null,
  steps: [
    {
      number: 1,
      name: 'test',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-01-01T00:00:10Z',
      completed_at: '2026-01-01T00:00:30Z',
    },
  ],
};

test('the workflow-trace report merges with a job report and keeps spans, logs and metrics', async () => {
  const w = createTestWriter();
  const key = runKey({ repository: 'o/r', runId: 42, runAttempt: 1 });
  const resource = ciResource(run);

  const trace = await Report.create({ out: 'trace', replace: true }, w.deps);
  await trace.addSpans(workflowTraceRequest(key, run, [job], new Set()));
  const text = '2026-01-01T00:00:11.0000000Z ##[group]Run tests\n2026-01-01T00:00:12.0000000Z hello\n';
  await trace.addLogs(jobLogRecordsRequest({ key, jobId: 7, job, text, resource: jobResource(run, job) }));
  await trace.addMetrics(ciMetricsRequest(run, [job], resource));
  await trace.close();

  const jobReport = await Report.create({ out: 'job', replace: true }, w.deps);
  await jobReport.addLogs({
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            logRecords: [
              { timeUnixNano: '1767225615000000000', severityNumber: 9, body: { stringValue: 'from job' } },
            ],
          },
        ],
      },
    ],
  });
  await jobReport.close();

  const summary = await merge({ inputs: ['trace', 'job'], out: 'merged', replace: true }, w.deps);
  expect(summary.totals.spans).toBe(4); // run, job, step and the job's queued span
  expect(summary.totals.logs).toBe(2); // the one log line (the group marker is not a record) plus the job report's
  expect(summary.totals.metrics).toBeGreaterThan(0);
  expect(manifestOf(w, 'merged').complete).toBe(true);
});
