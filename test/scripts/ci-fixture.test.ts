import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildCi, CI_RUNS } from '../../scripts/ci-fixture.js';

type Attr = { key: string; value: { stringValue?: string; intValue?: string } };
type Line = {
  resourceSpans?: { resource: { attributes: Attr[] }; scopeSpans: { spans: { attributes: Attr[] }[] }[] }[];
  resourceLogs?: { scopeLogs: { logRecords: { severityNumber: number }[] }[] }[];
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
      s.spans.map((span) => ({ resource: r.resource.attributes, attrs: span.attributes })),
    ),
  ),
);

describe('fixtures/ci.otlp.json', () => {
  test('holds every run of the ci workflow', () => {
    const runs = new Set(spans.map((s) => value(s.resource, 'cicd.pipeline.run.id')));
    expect(runs.size).toBe(CI_RUNS);
    expect(new Set(spans.map((s) => value(s.resource, 'cicd.pipeline.name')))).toEqual(new Set(['ci']));
  });

  test('one job fails and one times out; the rest succeed', () => {
    const results = spans
      .map((s) => value(s.attrs, 'cicd.pipeline.task.run.result'))
      .filter((r) => r !== undefined);
    expect(results.filter((r) => r === 'failure')).toHaveLength(1);
    expect(results.filter((r) => r === 'timeout')).toHaveLength(1);
    expect(new Set(results)).toEqual(new Set(['success', 'failure', 'timeout']));
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
