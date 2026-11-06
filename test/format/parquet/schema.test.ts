import { describe, expect, test } from 'vitest';
import {
  arrowSchema,
  type ColumnType,
  FIXED_STATISTICS_COLUMNS,
  SORT_COLUMNS,
  TABLE_COLUMNS,
  TABLES,
  TIME_COLUMN,
} from '../../../src/format/parquet/schema.js';

describe('parquet table schemas', () => {
  test('every table has its sort and time columns and no duplicate names', () => {
    for (const t of TABLES) {
      const names = TABLE_COLUMNS[t].map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const s of SORT_COLUMNS[t]) expect(names).toContain(s);
      for (const s of FIXED_STATISTICS_COLUMNS[t]) expect(names).toContain(s);
      expect(names).toContain(TIME_COLUMN[t]);
      expect(arrowSchema(t).fields.map((f) => f.name)).toEqual(names);
    }
  });

  test('spans carry the OTel Arrow time names and json attributes', () => {
    const spans = TABLE_COLUMNS.spans;
    expect(spans.find((c) => c.name === 'start_time_unix_nano')?.type).toBe('int64');
    expect(spans.find((c) => c.name === 'attributes')).toMatchObject({ type: 'json', dictionary: true });
  });

  test('dictionary columns are strings or json, and json columns are always dictionaries', () => {
    const stringLike: readonly ColumnType[] = ['utf8', 'json'];
    for (const t of TABLES) {
      for (const c of TABLE_COLUMNS[t]) {
        if (c.dictionary) expect(stringLike).toContain(c.type);
        if (c.type === 'json') expect(c.dictionary).toBe(true);
      }
    }
  });

  test('logs may have no time and carry an event_name dictionary column', () => {
    const logs = TABLE_COLUMNS.logs;
    expect(logs.find((c) => c.name === 'time_unix_nano')).toMatchObject({ type: 'int64', nullable: true });
    expect(logs.find((c) => c.name === 'event_name')).toMatchObject({
      type: 'utf8',
      nullable: true,
      dictionary: true,
    });
    const names = logs.map((c) => c.name);
    expect(names.indexOf('event_name')).toBe(names.indexOf('severity_text') + 1);
  });

  test('arrow types follow the column types', () => {
    const points = arrowSchema('points');
    expect(String(points.fields.find((f) => f.name === 'explicit_bounds')?.type)).toBe('List<Float64>');
    expect(String(points.fields.find((f) => f.name === 'bucket_counts')?.type)).toBe('List<Int64>');
    expect(String(points.fields.find((f) => f.name === 'time_unix_nano')?.type)).toBe('Int64');
    expect(String(points.fields.find((f) => f.name === 'metric_name')?.type)).toBe('Dictionary<Int32, Utf8>');
    expect(String(points.fields.find((f) => f.name === 'reset')?.type)).toBe('Bool');
  });
});
