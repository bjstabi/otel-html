import { createReportWith } from '../src/api/report.js';
import { jobSpanIdOf, runKey, runSpanIdOf, traceIdOf } from '../src/cli/ci/ids.js';
import type { WriterDeps } from '../src/writer/session.js';
import { gauge, type JsonObject, logRecord, metricsRequest } from './otlp-builders.js';

const attr = (key: string, value: string | number): JsonObject => ({
  key,
  value: typeof value === 'string' ? { stringValue: value } : { intValue: String(value) },
});

/**
 * A closed `site` report of one CI run, as the deployer writes it plus what a test run adds: a workflow root, a job,
 * its `queued` span (scope `otel-html-ci`), a `vitest` test span, a `mise.tasks` span, one log record and one gauge point.
 */
export async function writeCiRunReport(
  deps: WriterDeps,
  out: string,
  o: { repository: string; runId: number; attempt: number; branch?: string; startMs: number },
): Promise<void> {
  const key = runKey({ repository: o.repository, runId: o.runId, runAttempt: o.attempt });
  const traceId = traceIdOf(key);
  const rootId = runSpanIdOf(key);
  const jobId = jobSpanIdOf(key, 7);
  const ns = (ms: number): string => String((BigInt(o.startMs) + BigInt(ms)) * 1_000_000n);
  const at = (start: number, end: number): JsonObject => ({
    startTimeUnixNano: ns(start),
    endTimeUnixNano: ns(end),
  });
  const resource = [
    attr('cicd.pipeline.run.id', String(o.runId)),
    attr('cicd.pipeline.name', 'ci'),
    attr('vcs.ref.head.name', o.branch ?? 'main'),
    attr('cicd.pipeline.trigger', 'push'),
  ];
  const span = (id: string, parent: string | null, name: string, times: JsonObject, attrs: JsonObject[]) => ({
    traceId,
    spanId: id,
    ...(parent === null ? {} : { parentSpanId: parent }),
    name,
    kind: 1,
    ...times,
    attributes: attrs,
  });
  const report = await createReportWith({ out, format: 'site', assetsBase: 'assets/', replace: true }, deps);
  await report.addSpans({
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [
          {
            scope: { name: 'otel-html-ci' },
            spans: [
              span(rootId, null, 'ci', at(0, 5000), [
                attr('github.run_attempt', o.attempt),
                attr('cicd.pipeline.result', 'success'),
              ]),
              span(jobId, rootId, 'check', at(1000, 4000), [
                attr('cicd.pipeline.task.run.id', '7'),
                attr('cicd.pipeline.task.name', 'check'),
                attr('cicd.pipeline.task.run.result', 'success'),
              ]),
              span('a1b2c3d4e5f60718', jobId, 'queued', at(0, 1000), [
                attr('cicd.pipeline.task.name', 'check'),
              ]),
            ],
          },
          {
            scope: { name: 'vitest' },
            spans: [span('b1b2c3d4e5f60718', jobId, 'a test', at(1500, 2500), [])],
          },
          {
            scope: { name: 'mise.tasks' },
            spans: [
              span('c1b2c3d4e5f60718', jobId, 'lint', at(1200, 1800), [attr('mise.task.name', 'lint')]),
            ],
          },
        ],
      },
    ],
  });
  await report.addLogs({
    resourceLogs: [
      {
        resource: { attributes: resource },
        scopeLogs: [
          {
            scope: { name: 'test-scope' },
            logRecords: [logRecord({ timeUnixNano: ns(2000), observedTimeUnixNano: ns(2000) })],
          },
        ],
      },
    ],
  });
  await report.addMetrics(
    metricsRequest([gauge('ci.gauge', [{ timeUnixNano: ns(2000), asDouble: 1 }])], resource),
  );
  await report.close();
}
