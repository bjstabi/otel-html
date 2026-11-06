import type { ResolvedDashboard } from '../../config/schema.js';
import type { AnyValue, Attributes } from '../../model/anyvalue.js';
import { attributesFromJson } from '../columns.js';
import type { Row } from './rows.js';
import { FIXED_STATISTICS_COLUMNS, TABLE_COLUMNS, type Table, TIME_COLUMN } from './schema.js';

export interface FileStatistics {
  rows: number;
  timeMin: string | null;
  timeMax: string | null;
  values: Record<string, string[] | null>;
}

type Source = { kind: 'column'; name: string } | { kind: 'attr'; json: string; name: string } | null;

function sourceOf(table: Table, key: string): Source {
  if (key.startsWith('attr:')) return { kind: 'attr', json: 'attributes', name: key.slice(5) };
  if (key.startsWith('resource:')) return { kind: 'attr', json: 'resource_attributes', name: key.slice(9) };
  return TABLE_COLUMNS[table].some((c) => c.name === key) ? { kind: 'column', name: key } : null;
}

function scalarText(v: unknown): string | null {
  switch (typeof v) {
    case 'string':
      return v === '' ? null : v;
    case 'bigint':
    case 'number':
    case 'boolean':
      return String(v);
    default:
      return null;
  }
}

function anyValueText(v: AnyValue | undefined): string | null {
  if (v === undefined) return null;
  switch (v.kind) {
    case 'string':
    case 'int':
    case 'double':
    case 'bool':
      return scalarText(v.value);
    default:
      return null;
  }
}

const OBSERVED = 'observed_time_unix_nano';

function effectiveTime(table: Table, row: Row): bigint | null {
  const t = row[TIME_COLUMN[table]] ?? (table === 'logs' ? row[OBSERVED] : undefined);
  return typeof t === 'bigint' ? t : null;
}

/**
 * `keys`: column names and `attr:<key>` / `resource:<key>` paths read from the json columns; a key with more than
 * `cap` distinct values is `null`. A key naming nothing in this table gives `[]` (the same key list serves every
 * table). Times are decimal strings (int64).
 */
export function fileStatistics(
  table: Table,
  rows: readonly Row[],
  keys: readonly string[],
  cap: number,
): FileStatistics {
  const sources = keys.map((k) => sourceOf(table, k));
  const sets: (Set<string> | null)[] = keys.map(() => new Set<string>());
  const parsed = new Map<string, Attributes>();
  const parse = (text: string): Attributes => {
    let a = parsed.get(text);
    if (a === undefined) {
      a = attributesFromJson(text);
      parsed.set(text, a);
    }
    return a;
  };
  let min: bigint | null = null;
  let max: bigint | null = null;
  for (const row of rows) {
    const t = effectiveTime(table, row);
    if (t !== null) {
      if (min === null || t < min) min = t;
      if (max === null || t > max) max = t;
    }
    for (let i = 0; i < keys.length; i++) {
      const set = sets[i];
      const src = sources[i];
      if (set === null || set === undefined || src === null || src === undefined) continue;
      let text: string | null;
      if (src.kind === 'column') text = scalarText(row[src.name]);
      else {
        const json = row[src.json];
        text = typeof json === 'string' && json !== '' ? anyValueText(parse(json).get(src.name)) : null;
      }
      if (text === null) continue;
      set.add(text);
      if (set.size > cap) sets[i] = null;
    }
  }
  const values: Record<string, string[] | null> = Object.create(null) as Record<string, string[] | null>;
  keys.forEach((k, i) => {
    const set = sets[i];
    values[k] = set === null || set === undefined ? null : [...set].sort();
  });
  return {
    rows: rows.length,
    timeMin: min === null ? null : min.toString(),
    timeMax: max === null ? null : max.toString(),
    values,
  };
}

export function statisticsKeysFor(
  table: Table,
  config: { dashboards: readonly ResolvedDashboard[]; writer: { statisticsKeys: readonly string[] } },
): string[] {
  const out = new Set<string>(FIXED_STATISTICS_COLUMNS[table]);
  for (const d of config.dashboards) for (const v of d.dashboard.variables) out.add(`resource:${v.key}`);
  for (const k of config.writer.statisticsKeys) out.add(k);
  return [...out];
}
