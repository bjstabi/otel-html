import '../../src/writer/parquet-wasm-source.js';
import { describe, expect, test } from 'vitest';
import { batchFromRows, type ColumnBatch } from '../../src/format/parquet/batch.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { type Context, spanRow } from '../../src/format/parquet/rows.js';
import type { AnyValue } from '../../src/model/anyvalue.js';
import type { RelNanos, SpanId, TraceId, UnixNanos } from '../../src/model/ids.js';
import type { ResourceRef, ScopeRef, SpanRecord } from '../../src/model/records.js';
import { encodeCicd } from '../../src/writer/cicd-encode.js';
import { CicdRowSet } from '../../src/writer/cicd-rows.js';

const EPOCH = 1_700_000_000_000_000_000n as UnixNanos;
const str = (value: string): AnyValue => ({ kind: 'string', value });
const int = (value: number): AnyValue => ({ kind: 'int', value: BigInt(value) });
const bool = (value: boolean): AnyValue => ({ kind: 'bool', value });
const strs = (...v: string[]): AnyValue => ({ kind: 'array', values: v.map(str) });

interface Made {
  trace?: string;
  id: string;
  parent?: string | null;
  name?: string;
  scope?: string;
  resource?: Record<string, AnyValue>;
  attributes?: Record<string, AnyValue>;
  start?: number;
  end?: number;
  error?: boolean;
}

const SEC = 1_000_000_000;

function row(m: Made) {
  const resource = {
    attributes: new Map(Object.entries(m.resource ?? {})),
    droppedAttributesCount: 0,
    schemaUrl: '',
  };
  const scope = {
    name: m.scope ?? 'otel-html-ci',
    version: '',
    attributes: new Map(),
    droppedAttributesCount: 0,
    schemaUrl: '',
  };
  const ctx: Context = { epoch: EPOCH, resources: () => resource, scopes: () => scope };
  const span: SpanRecord = {
    traceId: (m.trace ?? 'a'.repeat(32)) as TraceId,
    spanId: m.id.padEnd(16, '0') as SpanId,
    parentSpanId: (m.parent === undefined || m.parent === null
      ? null
      : m.parent.padEnd(16, '0')) as SpanId | null,
    traceState: '',
    flags: 0,
    name: m.name ?? 'n',
    kind: 1,
    start: (m.start ?? 0) as RelNanos,
    end: (m.end ?? 10 * SEC) as RelNanos,
    attributes: new Map(Object.entries(m.attributes ?? {})),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: m.error === true ? 2 : 0, message: '' },
    resource: 0 as ResourceRef,
    scope: 0 as ScopeRef,
  };
  return spanRow(span, ctx);
}

const batchOf = (...ms: Made[]): ColumnBatch => batchFromRows('spans', ms.map(row));
const rowsOf = (...batches: ColumnBatch[]) => {
  const set = new CicdRowSet();
  for (const b of batches) set.add(b);
  return set.rows();
};

const RES = {
  'cicd.pipeline.run.id': str('99'),
  'cicd.pipeline.name': str('ci'),
  'vcs.ref.head.name': str('main'),
  'vcs.ref.head.revision': str('abc'),
  'vcs.ref.head.title': str('Fix it'),
  'cicd.pipeline.trigger': str('push'),
};
const jobAttrs = (name: string, extra: Record<string, AnyValue> = {}) => ({
  'cicd.pipeline.task.name': str(name),
  'cicd.pipeline.task.run.id': str(`j-${name}`),
  'cicd.pipeline.task.run.result': str('failure'),
  ...extra,
});

const RUN: Made = {
  id: 'r',
  name: 'ci',
  resource: RES,
  attributes: { 'cicd.pipeline.result': str('failure'), 'github.run_attempt': int(2) },
};
const SPANS: Made[] = [
  RUN,
  {
    id: 'j1',
    parent: 'r',
    name: 'check',
    start: SEC,
    attributes: jobAttrs('check', {
      'cicd.pipeline.task.id': str('check'),
      'cicd.pipeline.task.needs': strs('lint'),
      'cicd.pipeline.task.condition': str('success()'),
    }),
  },
  {
    id: 'q1',
    parent: 'j1',
    name: 'queued',
    start: SEC,
    end: 4 * SEC,
    attributes: { 'cicd.pipeline.task.name': str('check') },
  },
  {
    id: 's2',
    parent: 'j1',
    name: 'Run mise run check',
    error: true,
    attributes: { 'github.job.step.number': int(2), 'cicd.pipeline.task.step.result': str('failure') },
  },
  {
    id: 's1',
    parent: 'j1',
    name: 'Set up',
    attributes: { 'github.job.step.number': int(1), 'cicd.pipeline.task.step.result': str('success') },
  },
  {
    id: 'j2',
    parent: 'r',
    name: 'lint',
    start: 2 * SEC,
    attributes: jobAttrs('lint', { 'cicd.pipeline.task.needs': { kind: 'array', values: [] } }),
  },
];

describe('CicdRowSet', () => {
  test('a run with two jobs', () => {
    const rows = rowsOf(batchOf(...SPANS));
    const run = rows.filter((r) => Reflect.get(r, 'kind') === 'run');
    const jobs = rows.filter((r) => Reflect.get(r, 'kind') === 'job');
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({
      result: 'failure',
      attempt: 2,
      trigger: 'push',
      pipeline: 'ci',
      run_id: '99',
      branch: 'main',
      revision: 'abc',
      title: 'Fix it',
    });
    expect(jobs).toHaveLength(2);
    const check = jobs.find((j) => Reflect.get(j, 'task') === 'check');
    expect(check).toMatchObject({
      queued_ns: BigInt(3 * SEC),
      failed_step: 'Run mise run check',
      needs: '["lint"]',
      condition: 'success()',
      task_id: 'check',
      result: 'failure',
    });
    const lint = jobs.find((j) => Reflect.get(j, 'task') === 'lint');
    expect(Reflect.get(lint ?? {}, 'needs')).toBeNull();
    expect(Reflect.get(lint ?? {}, 'queued_ns')).toBeNull();
    expect(Reflect.get(lint ?? {}, 'failed_step')).toBeNull();
  });

  test('the first error child names the failed step when no step failed', () => {
    const rows = rowsOf(
      batchOf(
        { id: 'j', attributes: jobAttrs('x') },
        { id: 'a', parent: 'j', name: 'boom', error: true, attributes: { 'github.job.step.number': int(3) } },
        {
          id: 'b',
          parent: 'j',
          name: 'earlier',
          error: true,
          attributes: { 'github.job.step.number': int(1) },
        },
      ),
    );
    expect(Reflect.get(rows[0] ?? {}, 'failed_step')).toBe('earlier');
  });

  test('the trigger falls back to github.event', () => {
    const { 'cicd.pipeline.trigger': _t, ...res } = RES;
    const rows = rowsOf(batchOf({ id: 'r', resource: res, attributes: { 'github.event': str('push') } }));
    expect(rows[0]).toMatchObject({ kind: 'run', trigger: 'push' });
  });

  test('mise counts: only spans naming a task count; replayed are skipped=true, the rest ran', () => {
    const mise = (id: string, attributes: Record<string, AnyValue>): Made => ({
      id,
      scope: 'mise.tasks',
      attributes,
    });
    const rows = rowsOf(
      batchOf(
        mise('m1', { 'mise.task.name': str('a'), 'mise.task.skipped': bool(true) }),
        mise('m2', { 'mise.task.name': str('b'), 'mise.task.skipped': bool(true) }),
        mise('m3', { 'mise.task.name': str('c') }),
        mise('m4', { 'mise.task.name': str('d'), 'mise.task.skipped': bool(false) }),
        // wrapper and setup spans carry no task name: not counted
        mise('w1', { 'mise.span_type': str('setup') }),
        mise('w2', { 'mise.task.skipped': bool(true) }),
        { id: 'other', scope: 'vitest' },
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'tasks', tasks_replayed: 2, tasks_run: 2 });
  });

  test('a provisional root and a final root give the final one; provisional spans are left out', () => {
    const rows = rowsOf(
      batchOf(
        { ...RUN, id: 'p', end: 5 * SEC, attributes: { 'otel_html.ci.provisional': bool(true) } },
        { ...RUN, id: 'f', end: 9 * SEC },
        { id: 'pj', parent: 'p', attributes: { ...jobAttrs('x'), 'otel_html.ci.provisional': bool(true) } },
      ),
    );
    expect(rows).toHaveLength(1);
    expect(Reflect.get(rows[0] ?? {}, 'span_id')).toBe('f'.padEnd(16, '0'));
  });

  test('two final roots of one trace keep the latest-ending', () => {
    const rows = rowsOf(batchOf({ ...RUN, id: 'a', end: 5 * SEC }, { ...RUN, id: 'b', end: 9 * SEC }));
    expect(rows.map((r) => Reflect.get(r, 'span_id'))).toEqual(['b'.padEnd(16, '0')]);
  });

  test('chunks equal their concatenation', () => {
    const one = rowsOf(batchOf(...SPANS));
    const two = rowsOf(batchOf(...SPANS.slice(0, 2)), batchOf(...SPANS.slice(2)));
    expect(two).toEqual(one);
  });

  test('a span of another service with none of the keys gives no row', () => {
    const set = new CicdRowSet();
    set.add(batchOf({ id: 'x', parent: 'y', resource: { 'service.name': str('app') } }));
    expect(set.rows()).toEqual([]);
    expect(set.size).toBe(0);
  });

  test('encodeCicd round-trips the rows', () => {
    const rows = rowsOf(batchOf(...SPANS));
    const back = decodeTable('cicd', encodeCicd(rows, 1000));
    expect(back).toHaveLength(rows.length);
    expect(
      back.filter((r) => Reflect.get(r, 'kind') === 'job').map((r) => Reflect.get(r, 'queued_ns')),
    ).toContain(BigInt(3 * SEC));
  });
});
