import { tableFiles } from '../../src/query/sql/views.js';
import type { ScalingIds } from '../../src/viewer/data/catalogue.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import { costWith } from './cost.js';
import { HARNESS_SMALL_FILE_BYTES, type ReadEvent } from './counting-engine.js';
import type { Live, Measured } from './measure.js';

/**
 * What a statement needs that the ids do not say: the newest partition (the files a time cutoff keeps: it holds
 * well over 200 rows of every table), the cursor after the first page of each list, and the time bound of the trace.
 * `prepareContext` reads them uncounted.
 */
export interface LayoutContext {
  /** The zero-padded partition number of the newest partition, as in `partitions/000172/spans.parquet`. */
  newest: string;
  cursor: Record<'spans' | 'logs' | 'traces', { time: bigint; filename: string; row: number }>;
  trace: { start: bigint; end: bigint };
}

/** A statement of the measurement, and the section 7 path it stands for (`null`: a statement only the 10 % rule judges). */
export interface LayoutStatement {
  id: string;
  /** The section 7 path of the spec this statement stands for. */
  path: 'ci dashboard' | 'traces list' | 'logs list' | 'next page' | 'trace open' | null;
  sql(ids: ScalingIds, ctx: LayoutContext): string;
}

const TIME = {
  spans: 'start_time_unix_nano',
  logs: 'time_unix_nano',
  traces: 'start_time_unix_nano',
} as const;
const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;
// the engine's `filename` is the resolved path of the file (`<dir>/partitions/<n>/<table>.parquet`), so the leading `%/` matches
const inNewest = (ctx: LayoutContext): string => `filename LIKE '%/partitions/${ctx.newest}/%'`;

const first =
  (table: 'spans' | 'logs' | 'traces', extra = ''): ((ids: ScalingIds, ctx: LayoutContext) => string) =>
  (_ids, ctx) =>
    `SELECT * FROM ${table} WHERE ${inNewest(ctx)}${extra} ORDER BY ${TIME[table]} DESC, filename, file_row_number LIMIT 200`;

const next =
  (table: 'spans' | 'logs' | 'traces'): ((ids: ScalingIds, ctx: LayoutContext) => string) =>
  (_ids, ctx) => {
    const c = ctx.cursor[table];
    const t = TIME[table];
    return `SELECT * FROM ${table} WHERE ${inNewest(ctx)} AND (${t} < ${c.time} OR (${t} = ${c.time} AND (filename, file_row_number) > (${lit(c.filename)}, ${c.row}))) ORDER BY ${t} DESC, filename, file_row_number LIMIT 200`;
  };

/** The spec section 6.2 statement shapes, as SQL over the views, for the layout candidates. */
export const LAYOUT_STATEMENTS: readonly LayoutStatement[] = [
  { id: 'spans.newest', path: null, sql: first('spans') },
  { id: 'spans.next', path: 'next page', sql: next('spans') },
  { id: 'logs.newest', path: 'logs list', sql: first('logs') },
  { id: 'logs.next', path: 'next page', sql: next('logs') },
  { id: 'logs.severe', path: 'logs list', sql: first('logs', ' AND severity_number >= 13') },
  { id: 'traces.newest', path: 'traces list', sql: first('traces') },
  { id: 'traces.next', path: 'next page', sql: next('traces') },
  {
    id: 'ci.toplist',
    path: 'ci dashboard',
    sql: () =>
      `SELECT name, count(*) AS n, sum(duration_ns) AS total FROM spans WHERE scope_name = 'otel-html-ci' AND json_extract(CAST(attributes AS JSON), '/github.job.step.number') IS NOT NULL GROUP BY name ORDER BY total DESC, name LIMIT 20`,
  },
  {
    id: 'trace.byId',
    path: 'trace open',
    sql: (ids, ctx) =>
      `SELECT * FROM spans WHERE trace_id = ${lit(ids.traceId)} AND start_time_unix_nano BETWEEN ${ctx.trace.start} AND ${ctx.trace.end} ORDER BY start_time_unix_nano`,
  },
  {
    id: 'traces.slowest',
    path: null,
    sql: () =>
      'SELECT * FROM traces ORDER BY end_time_unix_nano - start_time_unix_nano DESC, trace_id LIMIT 20',
  },
  {
    id: 'spans.perMinute',
    path: null,
    sql: () =>
      'SELECT start_time_unix_nano // 60000000000 AS minute, count(*) AS n FROM spans GROUP BY minute ORDER BY minute',
  },
];

/** A statement as the engine's `query` takes it: the coordinator sends the text of anything it is given. */
const raw = (text: string): Parameters<QueryEngine['query']>[0] =>
  text as unknown as Parameters<QueryEngine['query']>[0];
const get = (row: Record<string, unknown> | undefined, key: string): unknown => row?.[key];

async function rows(live: Live, text: string): Promise<Record<string, unknown>[]> {
  const table = await live.counting.engine.query(raw(text));
  return table.toArray() as Record<string, unknown>[];
}

/** Reads the context of a report, uncounted (each measured statement starts cold). */
export async function prepareContext(live: Live): Promise<LayoutContext> {
  const ids = live.report.ids;
  const newest = String(Math.max(...live.report.manifest.partitions.map((p) => p.n))).padStart(6, '0');
  const partial = { newest } as LayoutContext;
  const cursor = {} as LayoutContext['cursor'];
  for (const table of ['spans', 'logs', 'traces'] as const) {
    const page = await rows(live, first(table)(ids, partial));
    const row = page[199];
    if (row === undefined) throw new Error(`the newest partition holds fewer than 200 ${table}`);
    cursor[table] = {
      time: BigInt(get(row, TIME[table]) as bigint),
      filename: String(get(row, 'filename')),
      row: Number(get(row, 'file_row_number')),
    };
  }
  const [bound] = await rows(
    live,
    `SELECT min(start_time_unix_nano) AS lo, max(end_time_unix_nano) AS hi FROM spans WHERE trace_id = ${lit(ids.traceId)}`,
  );
  return {
    newest,
    cursor,
    trace: { start: BigInt(get(bound, 'lo') as bigint), end: BigInt(get(bound, 'hi') as bigint) },
  };
}

/** The tables of the views a statement reads (`FROM spans`, `JOIN traces`). */
export function tablesOf(text: string): ('spans' | 'logs' | 'traces')[] {
  const found = new Set<'spans' | 'logs' | 'traces'>();
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+(spans|logs|traces)\b/g))
    found.add(m[1] as 'spans' | 'logs' | 'traces');
  return [...found];
}

export interface StatementOptions {
  /**
   * Prepare the files of the statement's tables first, as the data layer's `runPrepared` does: a file at or under the
   * engine's small-file limit is then one whole fetch, not range reads (default true; false is how the first
   * measurement of the layout candidates was taken).
   */
  prepare?: boolean;
}

/** `statement` cold on an open `Live`, as `measureCold` does an entry. */
export function measureStatement(
  live: Live,
  statement: LayoutStatement,
  ctx: LayoutContext,
  options: StatementOptions = {},
): Promise<Measured> {
  const run = live.turn.then(async (): Promise<Measured> => {
    const { counting, sizes, report } = live;
    const text = statement.sql(report.ids, ctx);
    await counting.cold();
    if (options.prepare ?? true) {
      const files = tablesOf(text).flatMap((t) => tableFiles(report.manifest, t, (path) => path));
      await counting.engine.prepare(files);
    }
    await rows(live, text);
    const events = await counting.take();
    const prepared = counting.prepared();
    const small = (e: ReadEvent): boolean =>
      (sizes.get(e.path) ?? Number.POSITIVE_INFINITY) <= HARNESS_SMALL_FILE_BYTES;
    const cost = costWith(events, prepared);
    const serialOf = (keep: (e: ReadEvent) => boolean): number =>
      costWith(events.filter(keep), new Map()).serial;
    return { cost, small: serialOf(small), large: serialOf((e) => !small(e)) };
  });
  live.turn = run.catch(() => undefined);
  return run;
}

/**
 * The one failure a layout measurement leaves out: a catalogue entry with a residual condition gives up past 200,000
 * candidate rows, on every layout alike. Any other failure is a measurement that did not complete.
 */
export const isResidualLimit = (entryId: string, error: unknown): boolean =>
  entryId.includes('.residual.') &&
  error instanceof Error &&
  /on more than \d+ rows; narrow the window/.test(error.message);
