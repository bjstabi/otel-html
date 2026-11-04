import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildCi, CI_RUNS, FAILING_JOB, TIMING_OUT_JOB } from '../../scripts/ci-fixture.js';

type Attr = { key: string; value: { stringValue?: string; intValue?: string } };
type Span = {
  name: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status?: { code: number };
};
type Line = {
  resourceSpans?: { resource: { attributes: Attr[] }; scopeSpans: { spans: Span[] }[] }[];
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
      s.spans.map((span) => ({ span, resource: r.resource.attributes, attrs: span.attributes })),
    ),
  ),
);

describe('fixtures/ci.otlp.json', () => {
  test('holds every run of the ci workflow', () => {
    const runs = new Set(spans.map((s) => value(s.resource, 'cicd.pipeline.run.id')));
    expect(runs.size).toBe(CI_RUNS);
    expect(new Set(spans.map((s) => value(s.resource, 'cicd.pipeline.name')))).toEqual(new Set(['ci']));
  });

  test('one job fails and one times out; coverage skips off push; the rest succeed', () => {
    const jobs = spans.flatMap((s) => {
      const result = value(s.attrs, 'cicd.pipeline.task.run.result');
      return result === undefined ? [] : [{ name: s.span.name, result }];
    });
    expect(jobs.filter((j) => j.result === 'failure')).toEqual([{ name: FAILING_JOB, result: 'failure' }]);
    expect(jobs.filter((j) => j.result === 'timeout')).toEqual([{ name: TIMING_OUT_JOB, result: 'timeout' }]);
    const skipped = jobs.filter((j) => j.result === 'skip');
    expect(skipped.length).toBeGreaterThan(0);
    expect(new Set(skipped.map((j) => j.name))).toEqual(new Set(['coverage']));
    expect(new Set(jobs.map((j) => j.result))).toEqual(new Set(['success', 'failure', 'timeout', 'skip']));
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
