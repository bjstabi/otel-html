import '../../../src/writer/parquet-wasm-source.js';
import { describe, expect, test } from 'vitest';
import type { ResolvedDashboard } from '../../../src/config/schema.js';
import { attributesToJson } from '../../../src/format/columns.js';
import type { PartitionFile } from '../../../src/format/manifest.js';
import { batchFromRows } from '../../../src/format/parquet/batch.js';
import { encodeTable } from '../../../src/format/parquet/codec.js';
import type { Table } from '../../../src/format/parquet/columns.js';
import type { Row } from '../../../src/format/parquet/rows.js';
import { completeStatistics, fileStatistics, statisticsKeysFor } from '../../../src/format/parquet/stats.js';
import type { AnyValue } from '../../../src/model/anyvalue.js';

const attrs = (o: Record<string, AnyValue>): string => attributesToJson(new Map(Object.entries(o)));
const NAME = 'name';
const stats = (table: Table, rows: readonly Row[], keys: readonly string[], cap: number) =>
  fileStatistics(table, batchFromRows(table, rows), keys, cap);
const s = (value: string): AnyValue => ({ kind: 'string', value });

describe('fileStatistics', () => {
  test('empty rows give zero rows, null times and empty value lists', () => {
    expect(stats('spans', [], ['service_name'], 10)).toEqual({
      rows: 0,
      timeMin: null,
      timeMax: null,
      values: { service_name: [] },
    });
  });

  test('time bounds come from the table time column as decimal strings', () => {
    const rows: Row[] = [
      { start_time_unix_nano: 1_700_000_000_000_000_002n },
      { start_time_unix_nano: 1_700_000_000_000_000_001n },
      { start_time_unix_nano: 1_700_000_000_000_000_009n },
      {},
    ];
    const st = stats('spans', rows, [], 10);
    expect(st.rows).toBe(4);
    expect(st.timeMin).toBe('1700000000000000001');
    expect(st.timeMax).toBe('1700000000000000009');
  });

  test('logs use the observed time when the time is absent', () => {
    const rows: Row[] = [
      { time_unix_nano: 50n },
      { observed_time_unix_nano: 10n },
      { time_unix_nano: 0n, observed_time_unix_nano: 99n },
    ];
    const st = stats('logs', rows, [], 10);
    expect(st.timeMin).toBe('0');
    expect(st.timeMax).toBe('50');
  });

  test('distinct column values are sorted strings; numbers become decimal strings', () => {
    const rows: Row[] = [{ severity_number: 17 }, { severity_number: 9 }, { severity_number: 17 }, {}];
    expect(stats('logs', rows, ['severity_number'], 10).values).toEqual({
      severity_number: ['17', '9'],
    });
    const named: Row[] = [{ name: 'b' }, { name: 'a' }, { name: 'b' }];
    expect(stats('spans', named, ['name'], 10).values[NAME]).toEqual(['a', 'b']);
  });

  test('more distinct values than the cap is null; exactly the cap is kept', () => {
    const rows: Row[] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(stats('spans', rows, ['name'], 3).values[NAME]).toEqual(['a', 'b', 'c']);
    expect(stats('spans', rows, ['name'], 2).values[NAME]).toBeNull();
  });

  test('resource: reads resource_attributes, attr: reads attributes', () => {
    const rows: Row[] = [
      {
        resource_attributes: attrs({ 'cicd.pipeline.run.id': s('r2') }),
        attributes: attrs({ k: { kind: 'int', value: 7n } }),
      },
      {
        resource_attributes: attrs({ 'cicd.pipeline.run.id': s('r1') }),
        attributes: attrs({ k: { kind: 'bool', value: true } }),
      },
      {
        resource_attributes: attrs({ 'cicd.pipeline.run.id': s('r1') }),
        attributes: attrs({ k: { kind: 'double', value: 1.5 } }),
      },
      {
        resource_attributes: attrs({ other: s('x') }),
        attributes: attrs({ k: { kind: 'array', values: [] } }),
      },
      {
        resource_attributes: attrs({ 'cicd.pipeline.run.id': s('') }),
        attributes: attrs({ k: { kind: 'empty' } }),
      },
      {},
    ];
    const st = stats('spans', rows, ['resource:cicd.pipeline.run.id', 'attr:k'], 10);
    expect(st.values['resource:cicd.pipeline.run.id']).toEqual(['', 'r1', 'r2']);
    expect(st.values['attr:k']).toEqual(['1.5', '7', 'true']);
  });

  test('keys a table cannot answer give null, never an empty list', () => {
    const st = stats(
      'traces',
      [{ trace_id: 'a', resource_attributes: '{"a":1}' }],
      ['severity_number', 'bogus:x', 'attributes', 'attr:k', 'resource:k'],
      10,
    );
    expect(st.values).toEqual({
      severity_number: null,
      'bogus:x': null,
      attributes: null,
      'attr:k': null,
      'resource:k': null,
    });
    expect(stats('spans', [{ attributes: '{"a":1}' }], ['attributes', 'unknown'], 10).values).toEqual({
      attributes: null,
      unknown: null,
    });
  });

  test('an empty string is a value; -0 is written as "-0"', () => {
    const rows: Row[] = [{ scope_name: '' }, { scope_name: 'x' }, { scope_name: null }, {}];
    expect(stats('spans', rows, ['scope_name'], 10).values).toEqual({ scope_name: ['', 'x'] });
    const d: Row[] = [{ attributes: attrs({ k: { kind: 'double', value: -0 } }) }];
    expect(stats('spans', d, ['attr:k'], 10).values['attr:k']).toEqual(['-0']);
    const m: Row[] = [{ value_double: -0 }];
    expect(stats('points', m, ['value_double'], 10).values).toEqual({ value_double: ['-0'] });
  });
});

describe('statisticsKeysFor', () => {
  const dashboard = (keys: string[]): ResolvedDashboard =>
    ({
      source: 't',
      dashboard: {
        id: 'd',
        title: 'D',
        description: '',
        widgets: [],
        variables: keys.map((key) => ({ key })),
      },
    }) as unknown as ResolvedDashboard;

  test('fixed columns, then dashboard variables, then config keys, deduplicated', () => {
    const keys = statisticsKeysFor('spans', {
      dashboards: [dashboard(['service.name', 'host.name']), dashboard(['host.name'])],
      writer: { statisticsKeys: ['attr:x', 'resource:host.name', 'name'] },
    });
    expect(keys).toEqual([
      'scope_name',
      'service_name',
      'name',
      'resource:service.name',
      'resource:host.name',
      'attr:x',
    ]);
  });

  test('tables drop keys they cannot answer', () => {
    const config = {
      dashboards: [dashboard(['cicd.pipeline.run.id'])],
      writer: { statisticsKeys: ['attr:x', 'attributes', 'bogus', 'name'] },
    };
    expect(statisticsKeysFor('traces', config)).not.toContainEqual(
      expect.stringMatching(/^(resource|attr):/),
    );
    expect(statisticsKeysFor('patterns', config)).not.toContainEqual(
      expect.stringMatching(/^(resource|attr):/),
    );
    const spans = statisticsKeysFor('spans', config);
    expect(spans).toContain('resource:cicd.pipeline.run.id');
    expect(spans).toContain('attr:x');
    expect(spans).not.toContain('attributes');
    expect(spans).not.toContain('bogus');
  });
});

describe('completeStatistics', () => {
  const rows: Row[] = ['a', 'b', 'a', 'c'].map((v, i) => ({
    time_unix_nano: BigInt(i),
    observed_time_unix_nano: BigInt(i),
    body: '"b"',
    resource_attributes: attrs({ run: s(v) }),
  }));
  const bytes = encodeTable('logs', rows, { rowGroupRows: 2 });
  const entry = (values: PartitionFile['values']): PartitionFile => ({
    path: 'f.parquet',
    bytes: bytes.length,
    rows: 4,
    timeMin: null,
    timeMax: null,
    values,
  });

  test('computes a missing key from the file and keeps recorded ones', async () => {
    let reads = 0;
    const read = async () => {
      reads++;
      return bytes;
    };
    const out = await completeStatistics(
      'logs',
      entry({ severity_text: ['kept'], 'resource:run': null }),
      ['severity_text', 'resource:run'],
      10,
      read,
    );
    expect(out.values).toEqual({ severity_text: ['kept'], 'resource:run': ['a', 'b', 'c'] });
    expect(reads).toBe(1);
    const same = await completeStatistics(
      'logs',
      entry({ severity_text: ['x'] }),
      ['severity_text'],
      10,
      read,
    );
    expect(same.values).toEqual({ severity_text: ['x'] });
    expect(reads).toBe(1); // nothing missing: the file is not read
  });

  test('leaves a key null when its values exceed the cap', async () => {
    const out = await completeStatistics('logs', entry({}), ['resource:run'], 2, async () => bytes);
    expect(out.values['resource:run']).toBeNull();
  });
});
