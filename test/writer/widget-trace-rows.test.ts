import '../../src/writer/parquet-wasm-source.js';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { widgetTraceConditions } from '../../src/config/widget-traces.js';
import { batchFromRows, type ColumnBatch } from '../../src/format/parquet/batch.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { type Context, spanRow } from '../../src/format/parquet/rows.js';
import type { AnyValue } from '../../src/model/anyvalue.js';
import type { RelNanos, SpanId, TraceId, UnixNanos } from '../../src/model/ids.js';
import type {
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
  SpanRecord,
} from '../../src/model/records.js';
import {
  compileWidgetIndex,
  encodeWidgetTraces,
  WIDGET_INDEX_SHARE,
  WidgetTraceSet,
  widgetIndexAllowed,
} from '../../src/writer/widget-trace-rows.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

const EPOCH = 1_700_000_000_000_000_000n as UnixNanos;
const str = (value: string): AnyValue => ({ kind: 'string', value });

function scopeOf(name: string): ScopeRecord {
  return { name, version: '', attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' };
}

function resourceOf(attrs: Record<string, AnyValue>): ResourceRecord {
  return { attributes: new Map(Object.entries(attrs)), droppedAttributesCount: 0, schemaUrl: '' };
}

interface Made {
  trace?: string;
  id?: string;
  parent?: string | null;
  scope?: string;
  resource?: Record<string, AnyValue>;
  attributes?: Record<string, AnyValue>;
  start?: bigint;
  end?: bigint;
}

/** A spans row (absolute times) for a made span. */
function row(m: Made = {}) {
  const resource = resourceOf(m.resource ?? {});
  const scope = scopeOf(m.scope ?? 'otel-html-ci');
  const start = m.start ?? EPOCH + 10n;
  const end = m.end ?? start + 5n;
  const ctx: Context = { epoch: EPOCH, resources: () => resource, scopes: () => scope };
  const span: SpanRecord = {
    traceId: (m.trace ?? 'a'.repeat(32)) as TraceId,
    spanId: (m.id ?? 'b'.repeat(16)) as SpanId,
    parentSpanId: (m.parent === undefined ? null : m.parent) as SpanId | null,
    traceState: '',
    flags: 0,
    name: 'n',
    kind: 1,
    start: Number(start - EPOCH) as RelNanos,
    end: Number(end - EPOCH) as RelNanos,
    attributes: new Map(Object.entries(m.attributes ?? {})),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: 0, message: '' },
    resource: 0 as ResourceRef,
    scope: 0 as ScopeRef,
  };
  return spanRow(span, ctx);
}

const batchOf = (...ms: Made[]): ColumnBatch => batchFromRows('spans', ms.map(row));

const RUN = {
  'cicd.pipeline.name': str('ci'),
  'cicd.pipeline.run.id': str('7'),
  'cicd.pipeline.task.name': str('build'),
};
const job = (result: string, over: Made = {}): Made => ({
  parent: 'p'.repeat(16),
  resource: RUN,
  attributes: { 'cicd.pipeline.task.run.id': str('1'), 'cicd.pipeline.task.run.result': str(result) },
  ...over,
});

async function ciIndex() {
  const fs = createMemoryFileSystem();
  await fs.mkdirp('/c');
  await fs.writeTextAtomic('/c/ci.yaml', await readFile('.github/otel-html-ci.yaml', 'utf8'));
  const { config } = resolveConfig({
    file: await loadConfigFile(fs, '/c/ci.yaml'),
    env: {},
    fileLabel: 'config.yaml',
  });
  const index = compileWidgetIndex(widgetTraceConditions(config.dashboards));
  if (index === null) throw new Error('no index');
  return index;
}

describe('WidgetTraceSet', () => {
  test('a root span of the CI scope gives one row with the run resource values', async () => {
    const set = new WidgetTraceSet(await ciIndex());
    set.add(batchOf({ resource: RUN }));
    expect(set.size).toBe(1);
    expect(set.rows()[0]).toMatchObject({
      trace_id: 'a'.repeat(32),
      'var:cicd.pipeline.name': 'ci',
      'var:cicd.pipeline.run.id': '7',
      'var:cicd.pipeline.task.name': 'build',
    });
  });

  test('a job span gives a row, a skipped job none, and a span of another scope none', async () => {
    const index = await ciIndex();
    const sizeOf = (m: Made): number => {
      const set = new WidgetTraceSet(index);
      set.add(batchOf(m));
      return set.size;
    };
    expect(sizeOf(job('success'))).toBe(1);
    expect(sizeOf(job('skip'))).toBe(0);
    expect(sizeOf(job('success', { scope: 'other' }))).toBe(0);
    expect(sizeOf({ scope: 'other' })).toBe(0);
  });

  test('matching spans of one trace and one resource give one row, a different job name gives two', async () => {
    const index = await ciIndex();
    const same = new WidgetTraceSet(index);
    same.add(batchOf({ resource: RUN }, job('success', { id: 'c'.repeat(16) })));
    expect(same.size).toBe(1);
    const other = new WidgetTraceSet(index);
    other.add(
      batchOf(
        { resource: RUN },
        job('success', { id: 'c'.repeat(16), resource: { ...RUN, 'cicd.pipeline.task.name': str('test') } }),
      ),
    );
    expect(other.size).toBe(2);
  });

  test('an int-valued resource attribute gives null in its column', async () => {
    const set = new WidgetTraceSet(await ciIndex());
    set.add(batchOf({ resource: { ...RUN, 'cicd.pipeline.run.id': { kind: 'int', value: 7n } } }));
    expect(set.rows()[0]?.['var:cicd.pipeline.run.id']).toBeNull();
  });

  test('a condition on the exact absolute start matches only that span', () => {
    const exact = EPOCH + 123_456_789n;
    const index = compileWidgetIndex({
      conditions: [{ id: '0123456789abcdef', source: `start_time_unix_nano == ${exact}` }],
      variables: [],
      notRowLocal: [],
    });
    if (index === null) throw new Error('no index');
    const set = new WidgetTraceSet(index);
    set.add(batchOf({ start: exact }, { trace: 'f'.repeat(32), id: 'd'.repeat(16), start: exact + 1n }));
    expect(set.rows().map((r) => Reflect.get(r, 'trace_id'))).toEqual(['a'.repeat(32)]);
  });

  test('add over two chunks equals add over their concatenation', async () => {
    const index = await ciIndex();
    const a = [
      { resource: RUN },
      job('success', { trace: '1'.repeat(32), id: '1'.repeat(16), start: EPOCH + 1_000_000n }),
    ];
    const b = [
      { resource: RUN, trace: '2'.repeat(32), id: '2'.repeat(16), start: EPOCH + 9_000_000_000_000n },
      job('success', { id: '3'.repeat(16), start: EPOCH + 9_000_000_000_001n }),
    ];
    const split = new WidgetTraceSet(index);
    split.add(batchOf(...a));
    split.add(batchOf(...b));
    const whole = new WidgetTraceSet(index);
    whole.add(batchOf(...a, ...b));
    expect(split.rows()).toEqual(whole.rows());
    expect(split.size).toBeGreaterThan(1);
  });

  test('a chunk spanning more than 2^53 ns is not exact', async () => {
    const index = await ciIndex();
    const near = new WidgetTraceSet(index);
    near.add(
      batchOf({ resource: RUN }, { resource: RUN, id: 'c'.repeat(16), start: EPOCH + 10n + 2n ** 52n }),
    );
    expect(near.exact).toBe(true);
    const far = new WidgetTraceSet(index);
    expect(far.exact).toBe(true);
    far.add(
      batchOf({ resource: RUN }, { resource: RUN, id: 'c'.repeat(16), start: EPOCH + 10n + 2n ** 53n + 10n }),
    );
    expect(far.exact).toBe(false);
  });

  test('compileWidgetIndex is null without a condition and describes the rest', async () => {
    expect(compileWidgetIndex({ conditions: [], variables: ['k'], notRowLocal: [] })).toBeNull();
    const index = await ciIndex();
    expect(index.description.variables).toEqual([
      'cicd.pipeline.name',
      'cicd.pipeline.run.id',
      'cicd.pipeline.task.name',
    ]);
    expect(index.description.conditions).toHaveLength(1);
  });

  test('encodeWidgetTraces round-trips the rows', async () => {
    const index = await ciIndex();
    const set = new WidgetTraceSet(index);
    set.add(batchOf({ resource: RUN }));
    const back = decodeTable('widget_traces', encodeWidgetTraces(set.rows(), index, 1000));
    expect(back).toEqual(set.rows());
  });
});

describe('widgetIndexAllowed', () => {
  test('weighs the table over its empty twin against 5 % of the spans', () => {
    expect(WIDGET_INDEX_SHARE).toBe(0.05);
    expect(widgetIndexAllowed(1_000 + 600, 1_000, 10_000)).toBe(false);
    expect(widgetIndexAllowed(1_000 + 500, 1_000, 10_000)).toBe(true);
  });
});
