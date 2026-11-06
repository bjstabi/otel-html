import type { DataType } from 'apache-arrow';
import { Bool, Dictionary, Field, Float64, Int32, Int64, List, Schema, Utf8 } from 'apache-arrow';

export const TABLES = ['spans', 'logs', 'points', 'traces', 'patterns'] as const;
export type Table = (typeof TABLES)[number];

export type ColumnType =
  | 'utf8'
  | 'json'
  | 'int32'
  | 'int64'
  | 'float64'
  | 'bool'
  | 'list_float64'
  | 'list_int64';

// OTLP uint32 fields (flags, dropped counts) are stored as int64, so every value they can hold fits.
export interface ColumnDef {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
  readonly dictionary: boolean;
}

const DICTIONARY_COLUMNS: ReadonlySet<string> = new Set([
  'scope_name',
  'service_name',
  'resource_name',
  'host_name',
  'name',
  'metric_name',
  'point_type',
  'trace_id',
  'span_id',
  'parent_span_id',
  'status_message',
  'severity_text',
  'event_name',
  'scope_version',
  'template',
]);

/** A column: nullable by default, dictionary-encoded when named above or json. */
function col(name: string, type: ColumnType, nullable = true): ColumnDef {
  return { name, type, nullable, dictionary: type === 'json' || DICTIONARY_COLUMNS.has(name) };
}

const required = (name: string, type: ColumnType): ColumnDef => col(name, type, false);

const resourceAndScope = (): ColumnDef[] => [
  col('resource_attributes', 'json'),
  col('resource_schema_url', 'utf8'),
  col('resource_dropped_attributes_count', 'int64'),
  col('scope_name', 'utf8'),
  col('scope_version', 'utf8'),
  col('scope_attributes', 'json'),
  col('scope_schema_url', 'utf8'),
  col('scope_dropped_attributes_count', 'int64'),
];

const SPANS: readonly ColumnDef[] = [
  required('trace_id', 'utf8'),
  required('span_id', 'utf8'),
  col('parent_span_id', 'utf8'),
  col('trace_state', 'utf8'),
  col('flags', 'int64'),
  required('name', 'utf8'),
  col('kind', 'int32'),
  required('start_time_unix_nano', 'int64'),
  required('end_time_unix_nano', 'int64'),
  required('duration_ns', 'int64'),
  col('status_code', 'int32'),
  col('status_message', 'utf8'),
  col('dropped_attributes_count', 'int64'),
  col('dropped_events_count', 'int64'),
  col('dropped_links_count', 'int64'),
  col('attributes', 'json'),
  col('events', 'json'),
  col('links', 'json'),
  ...resourceAndScope(),
  col('service_name', 'utf8'),
  col('resource_name', 'utf8'),
];

const LOGS: readonly ColumnDef[] = [
  col('time_unix_nano', 'int64'),
  col('observed_time_unix_nano', 'int64'),
  col('severity_number', 'int32'),
  col('severity_text', 'utf8'),
  col('event_name', 'utf8'),
  col('body', 'json'),
  col('attributes', 'json'),
  col('dropped_attributes_count', 'int64'),
  col('flags', 'int64'),
  col('trace_id', 'utf8'),
  col('span_id', 'utf8'),
  ...resourceAndScope(),
  col('service_name', 'utf8'),
  col('host_name', 'utf8'),
];

const POINTS: readonly ColumnDef[] = [
  required('metric_name', 'utf8'),
  col('metric_description', 'utf8'),
  col('metric_unit', 'utf8'),
  required('point_type', 'utf8'),
  col('aggregation_temporality', 'int32'),
  col('is_monotonic', 'bool'),
  col('start_time_unix_nano', 'int64'),
  required('time_unix_nano', 'int64'),
  col('attributes', 'json'),
  required('series_id', 'utf8'),
  ...resourceAndScope(),
  col('service_name', 'utf8'),
  col('value_double', 'float64'),
  col('count', 'int64'),
  col('sum', 'float64'),
  col('min', 'float64'),
  col('max', 'float64'),
  col('explicit_bounds', 'list_float64'),
  col('bucket_counts', 'list_int64'),
  col('scale', 'int32'),
  col('zero_count', 'int64'),
  col('zero_threshold', 'float64'),
  col('positive_offset', 'int32'),
  col('positive_counts', 'list_int64'),
  col('negative_offset', 'int32'),
  col('negative_counts', 'list_int64'),
  col('quantiles', 'json'),
  col('exemplars', 'json'),
  col('flags', 'int32'),
  col('delta_value', 'float64'),
  col('delta_count', 'int64'),
  col('reset', 'bool'),
  col('out_of_order', 'bool'),
];

const TRACES: readonly ColumnDef[] = [
  required('trace_id', 'utf8'),
  col('start_time_unix_nano', 'int64'),
  col('end_time_unix_nano', 'int64'),
  required('span_count', 'int32'),
  required('error_count', 'int32'),
  col('root_service', 'utf8'),
  col('root_name', 'utf8'),
  col('root_resource', 'utf8'),
  col('log_count', 'int32'),
];

const PATTERNS: readonly ColumnDef[] = [
  required('cluster_id', 'int64'),
  required('template', 'utf8'),
  required('count', 'int64'),
  col('first_time_unix_nano', 'int64'),
  col('last_time_unix_nano', 'int64'),
  col('severity_counts', 'json'),
  col('sample', 'utf8'),
];

export const TABLE_COLUMNS: Readonly<Record<Table, readonly ColumnDef[]>> = {
  spans: SPANS,
  logs: LOGS,
  points: POINTS,
  traces: TRACES,
  patterns: PATTERNS,
};

/** The columns a table's rows are sorted by, in order: scope_name, service_name, then its time column. */
export const SORT_COLUMNS: Readonly<Record<Table, readonly string[]>> = {
  spans: ['scope_name', 'service_name', 'start_time_unix_nano'],
  logs: ['scope_name', 'service_name', 'time_unix_nano'],
  points: ['scope_name', 'service_name', 'metric_name', 'time_unix_nano'],
  traces: ['start_time_unix_nano'],
  patterns: ['cluster_id'],
};

export const TIME_COLUMN: Readonly<Record<Table, string>> = {
  spans: 'start_time_unix_nano',
  logs: 'time_unix_nano',
  points: 'time_unix_nano',
  traces: 'start_time_unix_nano',
  patterns: 'first_time_unix_nano',
};

export const FIXED_STATISTICS_COLUMNS: Readonly<Record<Table, readonly string[]>> = {
  spans: ['scope_name', 'service_name', 'name'],
  logs: ['scope_name', 'service_name', 'severity_number'],
  points: ['scope_name', 'service_name', 'metric_name'],
  traces: [],
  patterns: [],
};

function arrowType(def: ColumnDef): DataType {
  switch (def.type) {
    case 'utf8':
    case 'json':
      return def.dictionary ? new Dictionary(new Utf8(), new Int32()) : new Utf8();
    case 'int32':
      return new Int32();
    case 'int64':
      return new Int64();
    case 'float64':
      return new Float64();
    case 'bool':
      return new Bool();
    case 'list_float64':
      return new List(new Field('item', new Float64(), true));
    case 'list_int64':
      return new List(new Field('item', new Int64(), true));
  }
}

export function arrowSchema(table: Table): Schema {
  return new Schema(TABLE_COLUMNS[table].map((c) => new Field(c.name, arrowType(c), c.nullable)));
}
