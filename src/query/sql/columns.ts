import { column, duckDBCodeGenerator, type ExprNode, literal, sql, verbatim } from '@uwdata/mosaic-sql';

/** The two OTTL contexts that run as SQL; datapoint conditions are not translated. */
export type SqlContext = 'span' | 'log_record';
type ColumnKind = 'string' | 'int' | 'bool' | 'json' | 'bigid';
export interface PathColumn {
  readonly column: string;
  readonly kind: ColumnKind;
  /** The OTTL path reads a NULL column as `''` (strings) or `0` (times). */
  readonly nullAsEmpty?: true;
}

const str = (c: string, nullAsEmpty?: true): PathColumn =>
  nullAsEmpty ? { column: c, kind: 'string', nullAsEmpty } : { column: c, kind: 'string' };
const int = (c: string, nullAsEmpty?: true): PathColumn =>
  nullAsEmpty ? { column: c, kind: 'int', nullAsEmpty } : { column: c, kind: 'int' };
const js = (c: string): PathColumn => ({ column: c, kind: 'json' });

const SHARED: readonly (readonly [string, PathColumn])[] = [
  ['resource.attributes', js('resource_attributes')],
  ['resource.schema_url', str('resource_schema_url')],
  ['resource.dropped_attributes_count', int('resource_dropped_attributes_count')],
  ['instrumentation_scope.name', str('scope_name')],
  ['instrumentation_scope.version', str('scope_version')],
  ['instrumentation_scope.attributes', js('scope_attributes')],
  ['instrumentation_scope.schema_url', str('scope_schema_url')],
  ['instrumentation_scope.dropped_attributes_count', int('scope_dropped_attributes_count')],
];

/**
 * Canonical OTTL path (context prefix stripped, as `CONTEXTS[c].paths` keys it) to view column. Ids are VARCHAR hex
 * columns, so `trace_id.string` and friends are plain strings; `bigid` is reserved for a raw id path no context has.
 */
export const PATH_COLUMNS: Readonly<Record<SqlContext, ReadonlyMap<string, PathColumn>>> = {
  span: new Map<string, PathColumn>([
    ['name', str('name')],
    ['kind', int('kind')],
    ['status.code', int('status_code')],
    ['status.message', str('status_message')],
    ['trace_id.string', str('trace_id')],
    ['span_id.string', str('span_id')],
    ['parent_span_id.string', str('parent_span_id', true)],
    ['trace_state', str('trace_state')],
    ['flags', int('flags')],
    ['start_time_unix_nano', int('start_time_unix_nano')],
    ['end_time_unix_nano', int('end_time_unix_nano')],
    ['dropped_attributes_count', int('dropped_attributes_count')],
    ['dropped_events_count', int('dropped_events_count')],
    ['dropped_links_count', int('dropped_links_count')],
    ['attributes', js('attributes')],
    ...SHARED,
  ]),
  log_record: new Map<string, PathColumn>([
    ['time_unix_nano', int('time_unix_nano', true)],
    ['observed_time_unix_nano', int('observed_time_unix_nano', true)],
    ['severity_number', int('severity_number')],
    ['severity_text', str('severity_text')],
    ['event_name', str('event_name')],
    ['body', js('body')],
    ['body.string', { column: 'body', kind: 'json' }],
    ['attributes', js('attributes')],
    ['trace_id.string', str('trace_id', true)],
    ['span_id.string', str('span_id', true)],
    ['flags', int('flags')],
    ['dropped_attributes_count', int('dropped_attributes_count')],
    ...SHARED,
  ]),
};

/** Paths `CONTEXTS` knows that have no column. None today; the test keeps a new OTTL path from going unmapped silently. */
export const UNMAPPED_PATHS: Readonly<Record<SqlContext, ReadonlySet<string>>> = {
  span: new Set<string>(),
  log_record: new Set<string>(),
};

/** `/a~1b` for keys ['a/b']; a numeric key is an array index segment. */
export function jsonPointer(keys: readonly (string | number)[]): string {
  return keys.map((k) => `/${String(k).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/** `json_extract(<col>, '<pointer>')` (JSON typed); no keys is the whole document. */
export function jsonAt(col: string, keys: readonly (string | number)[]): ExprNode {
  if (keys.length === 0) return sql`CAST(${column(col)} AS JSON)`;
  return sql`json_extract(${column(col)}, ${literal(jsonPointer(keys))})`;
}

/** `json_extract_string(<col>, '<pointer>')` (VARCHAR); a JSON null or a missing key is NULL. */
export function jsonStringAt(col: string, keys: readonly (string | number)[]): ExprNode {
  if (keys.length === 0) return sql`json_extract_string(${column(col)}, '$')`;
  return sql`json_extract_string(${column(col)}, ${literal(jsonPointer(keys))})`;
}

/** A JSON value as DOUBLE: plain numbers directly, `{"$i"}` / `{"$d"}` through TRY_CAST of the tag text, else NULL. */
export function jsonNumber(json: ExprNode): ExprNode {
  return sql`CASE json_type(${json})
    WHEN 'BIGINT' THEN TRY_CAST(${json} AS DOUBLE)
    WHEN 'UBIGINT' THEN TRY_CAST(${json} AS DOUBLE)
    WHEN 'DOUBLE' THEN TRY_CAST(${json} AS DOUBLE)
    WHEN 'OBJECT' THEN TRY_CAST(COALESCE(json_extract_string(${json}, '/$i'), json_extract_string(${json}, '/$d')) AS DOUBLE)
    ELSE NULL END`;
}

/**
 * OTTL kind of a JSON value: 'string' | 'int' | 'double' | 'bool' | 'map' | 'list' | 'bytes' | 'nil', as VARCHAR.
 * A SQL NULL input (a missing key) stays NULL; a JSON null is 'nil'.
 */
export function jsonKind(json: ExprNode): ExprNode {
  return sql`CASE json_type(${json})
    WHEN 'VARCHAR' THEN 'string'
    WHEN 'BOOLEAN' THEN 'bool'
    WHEN 'BIGINT' THEN 'int'
    WHEN 'UBIGINT' THEN 'int'
    WHEN 'DOUBLE' THEN 'double'
    WHEN 'ARRAY' THEN 'list'
    WHEN 'NULL' THEN 'nil'
    WHEN 'OBJECT' THEN CASE
      WHEN json_exists(${json}, '/$i') THEN 'int'
      WHEN json_exists(${json}, '/$d') THEN 'double'
      WHEN json_exists(${json}, '/$b') THEN 'bytes'
      ELSE 'map' END
    END`;
}

/** `<col> - <epoch>::BIGINT`. */
export function relTime(col: string, epoch: bigint): ExprNode {
  return sql`${column(col)} - ${verbatim(`${epoch}::BIGINT`)}`;
}

/** `<epoch>::BIGINT + <rel>` for a literal relative time. */
export function absLiteral(rel: number, epoch: bigint): ExprNode {
  return sql`${verbatim(`${epoch}::BIGINT`)} + ${literal(rel)}`;
}

/** DuckDB SQL text of an expression (mosaic-sql's DuckDB code generator), for tests and error hints. */
export function toSql(e: ExprNode): string {
  return duckDBCodeGenerator.toString(e);
}
