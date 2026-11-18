import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  buildCi,
  CANCELLED_JOB,
  CI_RUNS,
  DOCS_ONLY_RUN,
  FAILING_JOB,
  TIMING_OUT_JOB,
} from '../../scripts/ci-fixture.js';

type Attr = { key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } };
type Span = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status?: { code: number };
};
type Line = {
  resourceSpans?: {
    resource: { attributes: Attr[] };
    scopeSpans: { scope?: { name: string }; spans: Span[] }[];
  }[];
  resourceLogs?: { scopeLogs: { logRecords: { severityNumber: number; spanId?: string }[] }[] }[];
  resourceMetrics?: { scopeMetrics: { metrics: { name: string }[] }[] }[];
};

const lines = (text: string): Line[] =>
  text
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Line);
const value = (attrs: Attr[], key: string) => {
  const v = attrs.find((a) => a.key === key)?.value;
  return v?.stringValue ?? v?.intValue;
};

const committed = lines(readFileSync(new URL('../../fixtures/ci.otlp.json', import.meta.url), 'utf8'));
const spans = committed.flatMap((l) =>
  (l.resourceSpans ?? []).flatMap((r) =>
    r.scopeSpans.flatMap((s) =>
      s.spans.map((span) => ({
        span,
        resource: r.resource.attributes,
        attrs: span.attributes,
        scope: s.scope?.name,
      })),
    ),
  ),
);

describe('fixtures/ci.otlp.json', () => {
  test('holds every run of the ci workflow', () => {
    const runs = new Set(
      spans.map((s) => value(s.resource, 'cicd.pipeline.run.id')).filter((r) => r !== undefined),
    );
    expect(runs.size).toBe(CI_RUNS);
    expect(CI_RUNS).toBe(40);
    expect(new Set(spans.map((s) => value(s.resource, 'cicd.pipeline.name')))).toEqual(
      new Set(['ci', undefined]),
    );
  });

  test('runs cover push, pull_request, schedule and workflow_dispatch over 10 days', () => {
    const roots = spans.filter((s) => value(s.attrs, 'github.event') !== undefined);
    expect(new Set(roots.map((s) => value(s.attrs, 'github.event')))).toEqual(
      new Set(['push', 'pull_request', 'schedule', 'workflow_dispatch']),
    );
    const starts = roots.map((s) => Number(BigInt(s.span.startTimeUnixNano) / 1_000_000_000n));
    const days = (Math.max(...starts) - Math.min(...starts)) / 86_400;
    expect(days).toBeGreaterThan(9);
    expect(days).toBeLessThan(10);
  });

  test('one run has two attempts and one root is provisional', () => {
    const roots = spans.filter((s) => value(s.attrs, 'github.run_attempt') !== undefined);
    const attempts = roots.filter((s) => value(s.attrs, 'github.run_attempt') === '2');
    expect(attempts).toHaveLength(1);
    const id = value(attempts[0]?.attrs ?? [], 'cicd.pipeline.run.id');
    expect(
      roots.filter((s) => value(s.attrs, 'cicd.pipeline.run.id') === id).map((s) => s.span.traceId),
    ).toHaveLength(2);
    const provisional = spans.filter((s) => s.attrs.some((a) => a.key === 'otel_html.ci.provisional'));
    expect(provisional.filter((s) => s.span.parentSpanId === undefined)).toHaveLength(1);
  });

  test('jobs carry the workflow-file attributes, labels in two pools, and steps their results', () => {
    const jobs = spans.filter((s) => value(s.attrs, 'cicd.pipeline.task.run.result') !== undefined);
    const e2e = jobs.find((s) => s.span.name === 'e2e (chromium)');
    expect(value(e2e?.attrs ?? [], 'cicd.pipeline.task.id')).toBe('e2e');
    expect(value(e2e?.attrs ?? [], 'cicd.pipeline.task.condition')).toContain('docs_only');
    expect(e2e?.attrs.find((a) => a.key === 'cicd.pipeline.task.needs')).toBeDefined();
    expect(new Set(jobs.map((s) => value(s.resource, 'cicd.worker.labels')))).toEqual(
      new Set(['ubuntu-latest', 'windows-latest']),
    );
    const results = new Set(
      spans.map((s) => value(s.attrs, 'cicd.pipeline.task.step.result')).filter((r) => r !== undefined),
    );
    expect(results).toContain('failure');
    expect(results).toContain('success');
    expect(spans.some((s) => value(s.resource, 'vcs.ref.head.title') !== undefined)).toBe(true);
    expect(spans.some((s) => value(s.resource, 'cicd.pipeline.trigger') === 'schedule')).toBe(true);
  });

  test('a cancelled run, and a docs-only run whose dependent jobs are skipped', () => {
    const jobs = spans.filter((s) => value(s.attrs, 'cicd.pipeline.task.run.result') !== undefined);
    expect(
      jobs.filter((s) => value(s.attrs, 'cicd.pipeline.task.run.result') === 'cancellation'),
    ).toHaveLength(1);
    expect(
      jobs.find((s) => value(s.attrs, 'cicd.pipeline.task.run.result') === 'cancellation')?.span.name,
    ).toBe(CANCELLED_JOB);
    const root = spans.find((s) => value(s.attrs, 'cicd.pipeline.result') === 'cancellation');
    expect(root).toBeDefined();
    const docs = spans.find(
      (s) => value(s.resource, 'vcs.ref.head.title') === 'docs: fix a typo in the README',
    );
    const docsRun = value(docs?.resource ?? [], 'cicd.pipeline.run.id');
    expect(DOCS_ONLY_RUN).toBeGreaterThan(0);
    const skippedHere = jobs.filter(
      (s) =>
        value(s.resource, 'cicd.pipeline.run.id') === docsRun &&
        value(s.attrs, 'cicd.pipeline.task.run.result') === 'skip',
    );
    expect(skippedHere.length).toBeGreaterThan(1);
  });

  test('mise tasks: skipped only as true, never on schedule runs; tests share the trace, with 3 skipped and a retry', () => {
    const mise = spans.filter((s) => s.scope === 'mise.tasks');
    expect(mise.length).toBeGreaterThan(0);
    for (const s of mise) {
      const skipped = s.attrs.find((a) => a.key === 'mise.task.skipped');
      if (skipped !== undefined) expect(skipped.value.boolValue).toBe(true);
      expect(value(s.resource, 'cicd.pipeline.run.id')).toBeDefined();
      expect(value(s.resource, 'cicd.pipeline.task.name')).toBeDefined();
    }
    const schedule = new Set(
      spans
        .filter((s) => value(s.attrs, 'github.event') === 'schedule')
        .map((s) => value(s.attrs, 'cicd.pipeline.run.id')),
    );
    expect(schedule.size).toBeGreaterThan(0);
    for (const s of mise.filter((m) => schedule.has(value(m.resource, 'cicd.pipeline.run.id'))))
      expect(s.attrs.some((a) => a.key === 'mise.task.skipped')).toBe(false);
    expect(mise.some((s) => s.attrs.some((a) => a.key === 'mise.task.skipped'))).toBe(true);
    expect(mise.some((s) => !s.attrs.some((a) => a.key === 'mise.task.skipped'))).toBe(true);

    // The latest run holding tests: every test span is in the trace of a mise span, the test resource has no cicd.*.
    const tests = spans.filter((s) => s.scope === 'vitest' || s.scope === 'otel-html-tests');
    for (const t of tests) {
      expect(t.resource.some((a) => a.key.startsWith('cicd.'))).toBe(false);
      expect(value(t.resource, 'service.name')).toBe('otel-html-tests');
    }
    const traces = new Set(mise.map((s) => s.span.traceId));
    expect(tests.every((t) => traces.has(t.span.traceId))).toBe(true);
    const lastTrace = tests.at(-1)?.span.traceId;
    const last = tests.filter((t) => t.span.traceId === lastTrace);
    const skippedTests = last.filter(
      (t) =>
        ['skip', 'todo'].includes(value(t.attrs, 'vitest.test.mode') ?? '') ||
        value(t.attrs, 'test.case.result.status') === 'skipped',
    );
    expect(skippedTests).toHaveLength(3);
    expect(last.filter((t) => value(t.attrs, 'otel_html.test.retry') === '1')).toHaveLength(1);
    expect(new Set(last.map((t) => value(t.resource, 'test.framework')))).toEqual(
      new Set(['vitest', 'playwright']),
    );
  });

  test('one job fails and one times out; coverage skips off push and docs-only skips the dependent jobs; the rest succeed', () => {
    const jobs = spans.flatMap((s) => {
      const result = value(s.attrs, 'cicd.pipeline.task.run.result');
      return result === undefined ? [] : [{ name: s.span.name, result }];
    });
    expect(jobs.filter((j) => j.result === 'failure')).toEqual([{ name: FAILING_JOB, result: 'failure' }]);
    expect(jobs.filter((j) => j.result === 'timeout')).toEqual([{ name: TIMING_OUT_JOB, result: 'timeout' }]);
    const skipped = jobs.filter((j) => j.result === 'skip');
    expect(skipped.length).toBeGreaterThan(0);
    expect(new Set(skipped.map((j) => j.name))).toContain('coverage');
    expect(new Set(jobs.map((j) => j.result))).toEqual(
      new Set(['success', 'failure', 'timeout', 'skip', 'cancellation']),
    );
  });

  test('past the timeout only the collect and post steps run', () => {
    const job = spans.find((s) => value(s.attrs, 'cicd.pipeline.task.run.result') === 'timeout')?.span;
    const steps = spans.filter((s) => s.span.parentSpanId === job?.spanId && s.span.name !== 'queued');
    const cancelled = steps.findIndex((s) => s.span.status?.code === 2);
    expect(cancelled).toBeGreaterThan(0);
    const ran = steps
      .slice(cancelled + 1)
      .filter((s) => BigInt(s.span.endTimeUnixNano) > BigInt(s.span.startTimeUnixNano))
      .map((s) => s.span.name);
    expect(ran.length).toBeGreaterThan(0);
    for (const name of ran) expect(name).toMatch(/^Post |otel-html-collect/);
  });

  test('every error line belongs to the step that failed', () => {
    const errorSteps = new Set(
      spans
        .filter((s) => value(s.attrs, 'github.job.step.number') !== undefined && s.span.status?.code === 2)
        .map((s) => s.span.spanId),
    );
    const errors = committed.flatMap((l) =>
      (l.resourceLogs ?? []).flatMap((r) =>
        r.scopeLogs.flatMap((s) => s.logRecords.filter((x) => x.severityNumber >= 17)),
      ),
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(errorSteps).toContain(e.spanId);
  });

  test("this repo's job names, with numbered step spans", () => {
    const jobs = new Set(
      spans.map((s) => value(s.attrs, 'cicd.pipeline.task.name')).filter((n) => n !== undefined),
    );
    expect(jobs).toContain('check');
    expect(jobs).toContain('e2e (webkit)');
    expect(jobs).toContain('unit-os (windows-latest)');
    expect(jobs.size).toBe(12);
    expect(spans.some((s) => value(s.attrs, 'github.job.step.number') !== undefined)).toBe(true);
  });

  test('carries warnings and errors, and the job duration and queue metrics', () => {
    const severities = committed.flatMap((l) =>
      (l.resourceLogs ?? []).flatMap((r) =>
        r.scopeLogs.flatMap((s) => s.logRecords.map((x) => x.severityNumber)),
      ),
    );
    expect(severities.some((n) => n >= 17)).toBe(true);
    expect(severities.some((n) => n >= 13 && n < 17)).toBe(true);
    const metrics = new Set(
      committed.flatMap((l) =>
        (l.resourceMetrics ?? []).flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics.map((m) => m.name))),
      ),
    );
    expect(metrics).toContain('cicd.pipeline.task.run.duration');
    expect(metrics).toContain('cicd.pipeline.task.run.queue.duration');
  });

  test('the generator is deterministic for a seed', () => {
    const seeded = () => {
      let n = 0;
      return () => {
        n = (n * 9301 + 49297) % 233280;
        return n / 233280;
      };
    };
    expect(buildCi(seeded(), 1_700_000_000)).toBe(buildCi(seeded(), 1_700_000_000));
  });
});
