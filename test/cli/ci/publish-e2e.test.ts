import { expect, test } from 'vitest';
import { mergeWith } from '../../../src/api/convert.js';
import { createReportWith } from '../../../src/api/report.js';
import type { ApiJob, ApiRun } from '../../../src/cli/ci/github-api.js';
import { runKey } from '../../../src/cli/ci/ids.js';
import { jobLogRecordsRequest } from '../../../src/cli/ci/job-logs.js';
import { ciMetricsRequest } from '../../../src/cli/ci/metrics.js';
import { mergeSkippingBad } from '../../../src/cli/ci/publish-io.js';
import { ciResource, jobResource, workflowTraceRequest } from '../../../src/cli/ci/workflow-trace.js';
import { wrapDataFile } from '../../../src/format/data-file.js';
import { MANIFEST_KEY } from '../../../src/format/paths.js';
import { oldFormatMessage } from '../../../src/format/version.js';
import { span, traceRequest } from '../../../test-support/otlp-builders.js';
import { createTestWriter } from '../../../test-support/writer-deps.js';
import { manifestOf, tableRowsOf } from '../../writer/helpers.js';

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
  path: '.github/workflows/ci.yml',
  actor: { type: 'User' },
  head_branch: 'main',
  head_sha: 'abc',
  repository: { full_name: 'o/r', html_url: 'https://github.com/o/r' },
  head_repository: { full_name: 'o/r' },
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

  const trace = await createReportWith({ out: 'trace', replace: true }, w.deps);
  await trace.addSpans(workflowTraceRequest(key, run, [job], new Map()));
  const text = '2026-01-01T00:00:11.0000000Z ##[group]Run tests\n2026-01-01T00:00:12.0000000Z hello\n';
  await trace.addLogs(jobLogRecordsRequest({ key, jobId: 7, job, text, resource: jobResource(run, job) }));
  await trace.addMetrics(ciMetricsRequest(run, [job], resource));
  await trace.close();

  const jobReport = await createReportWith({ out: 'job', replace: true }, w.deps);
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

  const summary = await mergeWith({ inputs: ['trace', 'job'], out: 'merged', replace: true }, w.deps);
  expect(summary.totals.spans).toBe(4); // run, job, step and the job's queued span
  expect(summary.totals.logs).toBe(2); // the one log line (the group marker is not a record) plus the job report's
  expect(summary.totals.metrics).toBeGreaterThan(0);
  expect(manifestOf(w, 'merged').complete).toBe(true);
});

test('the rolling merge skips a format-4 run report with a warning and writes the format-5 one', async () => {
  const w = createTestWriter();
  const make = async (out: string, spanId: string) => {
    const r = await createReportWith({ out, replace: true }, w.deps);
    await r.addSpans(
      traceRequest([span({ spanId })], [{ key: 'service.name', value: { stringValue: 's' } }]),
    );
    await r.close();
  };
  await make('four', '0000000000000001');
  await make('five', '0000000000000002');
  // Turn "four" into what a format-4 writer left: its manifest says format 4, which this otel-html no longer reads.
  const m = manifestOf(w, 'four');
  await w.fs.writeTextAtomic('four/data/manifest.js', wrapDataFile(MANIFEST_KEY, { ...m, formatVersion: 4 }));
  expect(manifestOf(w, 'five').formatVersion).toBe(5);

  // The deployer's rolling merge: the format-4 run report is skipped with a warning, the format-5 one is written.
  const warnings: string[] = [];
  const { inputs } = await mergeSkippingBad({
    merge: (ins, out) => mergeWith({ inputs: ins, out, replace: true }, w.deps),
    required: ['five'],
    optional: ['four'],
    out: 'both',
    probeOut: (n) => `probe${n}`,
    warn: (message) => warnings.push(message),
  });
  expect(inputs).toEqual(['five']);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('skipping four: ');
  expect(warnings[0]).toContain(oldFormatMessage(4));
  const merged = manifestOf(w, 'both');
  expect(merged.formatVersion).toBe(5);
  expect(merged.totals.spans).toBe(1);
  expect(tableRowsOf(w, 'both', 'spans')).toHaveLength(1);
});
