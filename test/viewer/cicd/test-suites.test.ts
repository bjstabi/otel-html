import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnyValue, Attributes } from '../../../src/model/anyvalue.js';
import type { RelNanos, SpanId, TraceId } from '../../../src/model/ids.js';
import { type SpanRecord, StatusCode } from '../../../src/model/records.js';
import { testSuites } from '../../../src/viewer/cicd/test-suites.js';
import type { TraceDetail } from '../../../src/viewer/data/data-source.js';
import type { SpanRow } from '../../../src/viewer/data/results.js';
import { buildTraceTree } from '../../../src/viewer/data/trace-tree.js';

type OtlpValue = { stringValue?: string; intValue?: string; boolValue?: boolean; arrayValue?: unknown };
type OtlpAttr = { key: string; value: OtlpValue };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttr[];
};
type Line = {
  resourceSpans?: { resource: { attributes: OtlpAttr[] }; scopeSpans: { spans: OtlpSpan[] }[] }[];
};

const anyValue = (v: OtlpValue): AnyValue =>
  v.stringValue !== undefined
    ? { kind: 'string', value: v.stringValue }
    : v.boolValue !== undefined
      ? { kind: 'bool', value: v.boolValue }
      : v.intValue !== undefined
        ? { kind: 'int', value: BigInt(v.intValue) }
        : { kind: 'empty' };
const attrsOf = (a: OtlpAttr[]): Attributes => new Map(a.map((x) => [x.key, anyValue(x.value)]));

/** The fixture's traces as the viewer holds them: one detail per trace id. */
function fixtureTraces(): Map<string, Pick<TraceDetail, 'spans' | 'tree' | 'resources'>> {
  const lines = readFileSync(resolve(process.cwd(), 'fixtures/ci.otlp.json'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l) as Line);
  const resources: Attributes[] = [];
  const rows = new Map<string, SpanRow[]>();
  for (const l of lines) {
    for (const rs of l.resourceSpans ?? []) {
      const ref = resources.push(attrsOf(rs.resource.attributes)) - 1;
      for (const sc of rs.scopeSpans) {
        for (const s of sc.spans) {
          const start = Number(BigInt(s.startTimeUnixNano) - 1_700_000_000_000_000_000n);
          const end = Number(BigInt(s.endTimeUnixNano) - 1_700_000_000_000_000_000n);
          const span: SpanRecord = {
            traceId: s.traceId as TraceId,
            spanId: s.spanId as SpanId,
            parentSpanId: (s.parentSpanId ?? null) as SpanId | null,
            traceState: '',
            flags: 0,
            name: s.name,
            kind: 1,
            start: start as RelNanos,
            end: end as RelNanos,
            attributes: attrsOf(s.attributes),
            droppedAttributesCount: 0,
            events: [],
            droppedEventsCount: 0,
            links: [],
            droppedLinksCount: 0,
            status: { code: StatusCode.UNSET, message: '' },
            resource: ref as never,
            scope: 0 as never,
          };
          const list = rows.get(s.traceId) ?? [];
          rows.set(s.traceId, list);
          list.push({ span, service: '', resource: '', durationNs: end - start });
        }
      }
    }
  }
  const out = new Map<string, Pick<TraceDetail, 'spans' | 'tree' | 'resources'>>();
  for (const [id, spans] of rows)
    out.set(id, {
      spans,
      tree: buildTraceTree(spans),
      resources: (r) => ({
        attributes: resources[r as unknown as number] ?? new Map(),
        droppedAttributesCount: 0,
        schemaUrl: '',
      }),
    });
  return out;
}

describe('testSuites on the ci fixture', () => {
  const withTests = [...fixtureTraces().values()]
    .map((t) => ({ t, suites: testSuites(t) }))
    .filter((x) => x.suites.length > 0);

  it('finds the vitest and Playwright suites of a run, by walking ancestors', () => {
    expect(withTests.length).toBeGreaterThan(0);
    const { suites } = withTests.filter((x) => x.suites.length === 2).at(-1) ?? { suites: [] };
    expect(suites.map((s) => s.id)).toEqual(['check › test:unit:main', 'e2e (chromium) › test:e2e']);
    const [vitest, playwright] = suites;
    expect(vitest?.framework).toBe('vitest');
    expect(playwright?.framework).toBe('playwright');
    expect(vitest?.total).toBe(20);
    expect(playwright?.total).toBe(12);
  });

  it('counts 3 skipped in all (vitest skip and todo, one Playwright skipped)', () => {
    for (const { suites } of withTests)
      for (const x of suites) expect(x.skipped).toBe(x.framework === 'vitest' ? 2 : 1);
    const both = withTests.filter((x) => x.suites.length === 2);
    expect(both.length).toBeGreaterThan(0);
    for (const { suites } of both) expect(suites.reduce((n, x) => n + x.skipped, 0)).toBe(3);
  });

  it('sorts files by test time, longest first, and keeps the project of a Playwright test', () => {
    const { suites } = withTests.filter((x) => x.suites.length === 2).at(0) ?? { suites: [] };
    for (const s of suites) {
      const ms = s.files.map((f) => f.ms);
      expect(ms).toEqual([...ms].sort((a, b) => b - a));
    }
    expect(suites[1]?.files[0]?.tests[0]?.project).toBe('chromium');
  });
});

describe('testSuites on a trace without tests', () => {
  it('is empty', () => {
    const t = [...fixtureTraces().values()].find((x) => testSuites(x).length === 0);
    expect(t).toBeDefined();
  });
});

describe('testSuites on hand-made spans', () => {
  type Spec = {
    id: string;
    parent: string | null;
    name: string;
    attrs: Record<string, string | number>;
    ms?: number;
  };
  const detail = (specs: Spec[]): Pick<TraceDetail, 'spans' | 'tree' | 'resources'> => {
    const spans: SpanRow[] = specs.map((s) => {
      const ms = s.ms ?? 0;
      const span: SpanRecord = {
        traceId: 't' as TraceId,
        spanId: s.id as SpanId,
        parentSpanId: s.parent as SpanId | null,
        traceState: '',
        flags: 0,
        name: s.name,
        kind: 1,
        start: 0 as RelNanos,
        end: (ms * 1e6) as RelNanos,
        attributes: new Map(
          Object.entries(s.attrs).map(([k, v]): [string, AnyValue] =>
            typeof v === 'number'
              ? [k, { kind: 'int', value: BigInt(v) }]
              : [k, { kind: 'string', value: v }],
          ),
        ),
        droppedAttributesCount: 0,
        events: [],
        droppedEventsCount: 0,
        links: [],
        droppedLinksCount: 0,
        status: { code: StatusCode.UNSET, message: '' },
        resource: 0 as never,
        scope: 0 as never,
      };
      return { span, service: '', resource: '', durationNs: ms * 1e6 };
    });
    return {
      spans,
      tree: buildTraceTree(spans),
      resources: () => ({ attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' }),
    };
  };
  const base: Spec[] = [
    { id: 'j', parent: null, name: 'check', attrs: { 'cicd.pipeline.task.name': 'check' } },
    { id: 'k', parent: 'j', name: 'task', attrs: { 'mise.task.name': 'task' } },
  ];
  const pw = (id: string, retry: number, status: string, ms: number): Spec => ({
    id,
    parent: 'k',
    name: 'same',
    ms,
    attrs: {
      'test.suite.name': 'e2e/a.spec.ts',
      'test.case.name': 'same',
      'test.case.result.status': status,
      'otel_html.test.retry': retry,
    },
  });

  it('keeps two vitest tests that share a name in one file as two tests', () => {
    const v = (id: string): Spec => ({
      id,
      parent: 'k',
      name: 'dup',
      ms: 5,
      attrs: { 'test.suite.name': 'a.test.ts', 'vitest.test.name': 'dup', 'vitest.test.mode': 'run' },
    });
    const [s] = testSuites(detail([...base, v('v1'), v('v2')]));
    expect(s?.total).toBe(2);
  });

  it('counts a retried Playwright test once, sums its time and takes the last attempt', () => {
    const [s] = testSuites(detail([...base, pw('p0', 0, 'fail', 10), pw('p1', 1, 'skipped', 20)]));
    expect(s?.total).toBe(1);
    expect(s?.files[0]?.ms).toBe(30);
    expect(s?.skipped).toBe(1);
  });

  it('counts a vitest todo as skipped', () => {
    const [s] = testSuites(
      detail([
        ...base,
        {
          id: 'v',
          parent: 'k',
          name: 'x',
          attrs: { 'test.suite.name': 'a.test.ts', 'vitest.test.mode': 'todo' },
        },
      ]),
    );
    expect(s?.skipped).toBe(1);
  });

  it('leaves out a test span with no mise task ancestor', () => {
    const loose: Spec = {
      id: 'l',
      parent: 'j',
      name: 'x',
      attrs: { 'test.suite.name': 'a.test.ts', 'vitest.test.mode': 'run' },
    };
    expect(testSuites(detail([base[0] as Spec, loose]))).toEqual([]);
  });
});
