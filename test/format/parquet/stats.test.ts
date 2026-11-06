import { describe, expect, test } from 'vitest';
import type { ResolvedDashboard } from '../../../src/config/schema.js';
import { attributesToJson } from '../../../src/format/columns.js';
import type { Row } from '../../../src/format/parquet/rows.js';
import { fileStatistics, statisticsKeysFor } from '../../../src/format/parquet/stats.js';
import type { AnyValue } from '../../../src/model/anyvalue.js';

const attrs = (o: Record<string, AnyValue>): string => attributesToJson(new Map(Object.entries(o)));
const NAME = 'name';
const s = (value: string): AnyValue => ({ kind: 'string', value });

describe('fileStatistics', () => {
  test('empty rows give zero rows, null times and empty value lists', () => {
    expect(fileStatistics('spans', [], ['service_name'], 10)).toEqual({
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
    const st = fileStatistics('spans', rows, [], 10);
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
    const st = fileStatistics('logs', rows, [], 10);
    expect(st.timeMin).toBe('0');
    expect(st.timeMax).toBe('50');
  });

  test('distinct column values are sorted strings; numbers become decimal strings', () => {
    const rows: Row[] = [{ severity_number: 17 }, { severity_number: 9 }, { severity_number: 17 }, {}];
    expect(fileStatistics('logs', rows, ['severity_number'], 10).values).toEqual({
      severity_number: ['17', '9'],
    });
    const named: Row[] = [{ name: 'b' }, { name: 'a' }, { name: 'b' }];
    expect(fileStatistics('spans', named, ['name'], 10).values[NAME]).toEqual(['a', 'b']);
  });

  test('more distinct values than the cap is null; exactly the cap is kept', () => {
    const rows: Row[] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(fileStatistics('spans', rows, ['name'], 3).values[NAME]).toEqual(['a', 'b', 'c']);
    expect(fileStatistics('spans', rows, ['name'], 2).values[NAME]).toBeNull();
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
    const st = fileStatistics('spans', rows, ['resource:cicd.pipeline.run.id', 'attr:k'], 10);
    expect(st.values['resource:cicd.pipeline.run.id']).toEqual(['r1', 'r2']);
    expect(st.values['attr:k']).toEqual(['1.5', '7', 'true']);
  });

  test('keys that name nothing in the table give an empty list', () => {
    const st = fileStatistics('traces', [{ trace_id: 'a' }], ['severity_number', 'bogus:x'], 10);
    expect(st.values).toEqual({ severity_number: [], 'bogus:x': [] });
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
});
