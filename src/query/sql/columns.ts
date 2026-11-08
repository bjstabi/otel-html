import { column, duckDBCodeGenerator, type ExprNode, literal, sql, verbatim } from '@uwdata/mosaic-sql';

/** The OTTL contexts that run as SQL; a datapoint condition runs over the `points` columns (one row per point). */
export type SqlContext = 'span' | 'log_record' | 'datapoint';
type ColumnKind = 'string' | 'int' | 'bool' | 'json';
export interface PathColumn {
  readonly column: string;
  readonly kind: ColumnKind;
  /**
   * The OTTL path reads a NULL column as `''` (strings) or `0` (times). The coalesce applies to the absolute column,
   * before any epoch subtraction (for the log time paths OTTL reads absolute 0n).
   */
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
 * columns, so `trace_id.string` and friends are plain strings.
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
    ['event_name', str('event_name', true)],
    ['body', js('body')],
    ['body.string', { column: 'body', kind: 'json' }],
    ['attributes', js('attributes')],
    ['trace_id.string', str('trace_id', true)],
    ['span_id.string', str('span_id', true)],
    ['flags', int('flags')],
    ['dropped_attributes_count', int('dropped_attributes_count')],
    ...SHARED,
  ]),
  datapoint: new Map<string, PathColumn>([
    ['metric.name', str('metric_name')],
    ['metric.description', str('metric_description', true)],
    ['metric.unit', str('metric_unit', true)],
    ['attributes', js('attributes')],
    ...SHARED,
  ]),
};

/**
 * Paths `CONTEXTS` knows that have no column. The datapoint time and flags paths are per point, not per series: the
 * dashboard schema rejects them before translation (`rejectPerPointPaths`). The test keeps a new OTTL path from going
 * unmapped silently.
 */
export const UNMAPPED_PATHS: Readonly<Record<SqlContext, ReadonlySet<string>>> = {
  span: new Set<string>(),
  log_record: new Set<string>(),
  datapoint: new Set<string>(['start_time_unix_nano', 'time_unix_nano', 'flags']),
};

/** `/a~1b` for keys ['a/b']; a numeric key is an array index segment. */
export function jsonPointer(keys: readonly (string | number)[]): string {
  return keys.map((k) => `/${String(k).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/**
 * Binds `value` once to the lambda parameter `name` and builds `body` over it, so an operand is written a single time
 * however often the body reads it (SQL size stays linear in the number of keys).
 */
export function bindOnce(value: ExprNode, name: string, body: (ref: ExprNode) => ExprNode): ExprNode {
  return sql`list_extract(list_transform([${value}], (${verbatim(name)}) -> ${body(verbatim(name))}), 1)`;
}

/**
 * One step into a JSON value. An object that holds a `$`-prefixed or `__proto__` key is stored as the pairs form
 * `{"$m": [[key, value], ...]}` (format 4), so a string key is looked up in the object and, failing that, in the pairs.
 * A numeric key reads arrays only (OTTL gives nil for a numeric key on a map). A missing key is SQL NULL, a JSON null
 * stays JSON null. A duplicate key never reaches the pairs: the normalizer keeps the last occurrence (a `Map`), as the
 * browser evaluator sees it, so the first matching pair is the only one.
 */
function jsonStep(base: ExprNode, key: string | number, depth: number): ExprNode {
  return bindOnce(base, `b${depth}`, (b) => {
    const ptr = literal(jsonPointer([key]));
    if (typeof key !== 'string')
      return sql`CASE WHEN json_type(${b}) = 'ARRAY' THEN json_extract(${b}, ${ptr}) END`;
    const pairs = sql`list_extract(list_transform(list_filter(from_json(json_extract(${b}, '/$m'), '["JSON"]'), (x) -> json_extract_string(x, '/0') = ${literal(key)}), (x) -> json_extract(x, '/1')), 1)`;
    return sql`coalesce(json_extract(${b}, ${ptr}), ${pairs})`;
  });
}

/** The JSON value at `keys` (JSON typed, reading the `$m` pairs form at every level); no keys is the whole document. */
export function jsonAt(col: string, keys: readonly (string | number)[]): ExprNode {
  let node: ExprNode = sql`CAST(${column(col)} AS JSON)`;
  keys.forEach((k, i) => {
    node = jsonStep(node, k, i);
  });
  return node;
}

/** `json_extract_string` of the same value (VARCHAR); a JSON null or a missing key is NULL. */
export function jsonStringAt(col: string, keys: readonly (string | number)[]): ExprNode {
  return sql`json_extract_string(${jsonAt(col, keys)}, '$')`;
}

/** A JSON value as DOUBLE: plain numbers directly, `{"$i"}` / `{"$d"}` through TRY_CAST of the tag text, else NULL. */
export function jsonNumber(json: ExprNode): ExprNode {
  return bindOnce(
    json,
    'n',
    (j) => sql`CASE json_type(${j})
    WHEN 'BIGINT' THEN TRY_CAST(${j} AS DOUBLE)
    WHEN 'UBIGINT' THEN TRY_CAST(${j} AS DOUBLE)
    WHEN 'DOUBLE' THEN TRY_CAST(${j} AS DOUBLE)
    WHEN 'OBJECT' THEN TRY_CAST(COALESCE(json_extract_string(${j}, '/$i'), json_extract_string(${j}, '/$d')) AS DOUBLE)
    ELSE NULL END`,
  );
}

/**
 * OTTL kind of a JSON value: 'string' | 'int' | 'double' | 'bool' | 'map' | 'list' | 'bytes' | 'nil', as VARCHAR.
 * A SQL NULL input (a missing key) stays NULL; a JSON null is 'nil'.
 */
export function jsonKind(json: ExprNode): ExprNode {
  return bindOnce(
    json,
    'k',
    (j) => sql`CASE json_type(${j})
    WHEN 'VARCHAR' THEN 'string'
    WHEN 'BOOLEAN' THEN 'bool'
    WHEN 'BIGINT' THEN 'int'
    WHEN 'UBIGINT' THEN 'int'
    WHEN 'DOUBLE' THEN 'double'
    WHEN 'ARRAY' THEN 'list'
    WHEN 'NULL' THEN 'nil'
    WHEN 'OBJECT' THEN CASE
      WHEN json_exists(${j}, '/$i') THEN 'int'
      WHEN json_exists(${j}, '/$d') THEN 'double'
      WHEN json_exists(${j}, '/$b') THEN 'bytes'
      ELSE 'map' END
    END`,
  );
}

/** `(<col> - <epoch>::BIGINT)`, parenthesised so a caller can put any operator next to it. */
export function relTime(col: string, epoch: bigint): ExprNode {
  return sql`(${column(col)} - ${verbatim(`${epoch}::BIGINT`)})`;
}

/** `(<epoch>::BIGINT + <rel>)` for a literal relative time. */
export function absLiteral(rel: number, epoch: bigint): ExprNode {
  return sql`(${verbatim(`${epoch}::BIGINT`)} + ${literal(rel)})`;
}

/** DuckDB SQL text of an expression (mosaic-sql's DuckDB code generator), for tests and error hints. */
export function toSql(e: ExprNode): string {
  return duckDBCodeGenerator.toString(e);
}
