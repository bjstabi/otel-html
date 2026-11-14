import type { Query } from '@uwdata/mosaic-sql';
import { and, type ExprNode } from '@uwdata/mosaic-sql';
import { OtelHtmlError } from '../../src/model/errors.js';
import { compileCondition } from '../../src/ottl/compile.js';
import { parseCondition } from '../../src/ottl/parse.js';
import { pathsOf, rejectPerPointPaths } from '../../src/query/metric-paths.js';
import { buildFilter, whereOf } from '../../src/query/sql/filter.js';
import {
  type ByExpr,
  byExpr,
  idTableSeriesQuery,
  type MetricIdentity,
  metricCellsQuery,
  runsQuery,
  seriesIdsQuery,
  seriesQuery,
} from '../../src/query/sql/points.js';
import type { Pruned } from '../../src/query/sql/prune.js';
import type { MetricContext } from '../../src/viewer/data/duckdb-metrics.js';
import { metricMethods } from '../../src/viewer/data/duckdb-metrics.js';
import { runsFrom, seriesLabel, seriesRowsFrom, seriesTarget } from '../../src/viewer/data/metric-mappers.js';
import type {
  CatalogRows,
  MetricRunQueryRequest,
  RunQueryResult,
} from '../../src/viewer/data/metric-results.js';
import { checkShow, kindOf, NOTES } from '../../src/viewer/data/metric-tables.js';
import { filesFor, runPrepared, throwIfAborted } from '../../src/viewer/data/query-common.js';
import { dropResidualTable, idTable, servedResidual } from '../../src/viewer/data/residual.js';

/**
 * `metricRunQuery` as it was before the run queries selected their files by run: every statement reads all the files
 * the metric and the condition keep. Copied from `duckdb-metrics.ts` (`scoped`, `seriesRowsTable`, `notesOf` and the
 * body of `metricRunQuery`) so the equivalence test compares the two-step answer with it.
 */
export async function metricRunQueryWhole(
  ctx: MetricContext,
  req: MetricRunQueryRequest,
  signal?: AbortSignal,
): Promise<RunQueryResult> {
  const { engine, epoch, manifest } = ctx;
  const RESIDUAL_SERIES_CAP = 200_000;
  const usage = (path: string, expected: string, actual: string): OtelHtmlError =>
    new OtelHtmlError('usage', { path, expected, actual });
  const tooManySeries = (): OtelHtmlError =>
    new OtelHtmlError('usage', {
      message: `the condition needs the browser to evaluate part of it on more than ${RESIDUAL_SERIES_CAP} rows; narrow the window or the rest of the condition`,
    });
  const read = (files: Pruned | undefined, q: Query, s?: AbortSignal) =>
    runPrepared(engine, q, filesFor(manifest, ['points'], files), s);
  const cat: CatalogRows = (await metricMethods(ctx).metricCatalog()) as CatalogRows;
  const identityOf = (c: CatalogRows, entryId: number): MetricIdentity => {
    const identity = c.identities[entryId];
    if (identity === undefined) throw usage('metric entry', 'an entry of the catalog', String(entryId));
    return identity;
  };

  interface Scope {
    seriesFor(by: readonly ByExpr[]): Query;
    files: Pruned;
    residual: string | null;
  }
  async function scoped<T>(
    o: {
      entry: Parameters<typeof seriesTarget>[0];
      identity: MetricIdentity;
      condition: string | null;
      window: null;
      resourceTexts: readonly string[] | null;
      seriesIds: Query | null;
    },
    s: AbortSignal | undefined,
    use: (s: Scope) => Promise<T>,
  ): Promise<T> {
    const { filter, residual } = buildFilter({
      manifest,
      table: 'points',
      condition: o.condition,
      text: '',
      window: o.window,
      hints: new Map([['metric_name', new Set([o.identity.name])]]),
    });
    const terms: ExprNode[] = whereOf({ ...filter, files: { ...filter.files, all: true } }, 'points');
    const where = terms.length === 0 || filter.files.files.length === 0 ? null : and(...terms);
    const base = (seriesIds: Query | null, by: readonly ByExpr[]): Query =>
      seriesQuery({
        identity: o.identity,
        files: filter.files,
        where,
        resourceTexts: o.resourceTexts,
        seriesIds,
        by,
      });
    const scope = (seriesIds: Query | null): Scope => ({
      seriesFor: (by) => base(seriesIds, by),
      files: filter.files,
      residual,
    });
    if (residual === null || filter.files.files.length === 0) return use(scope(o.seriesIds));

    if (!engine.tempTables) throw servedResidual(residual);
    const compiled = compileCondition(residual, 'datapoint');
    const probe = await read(
      filter.files,
      base(o.seriesIds, [])
        .clone()
        .limit(RESIDUAL_SERIES_CAP + 1),
      s,
    );
    if (probe.numRows > RESIDUAL_SERIES_CAP) throw tooManySeries();
    const candidates = seriesRowsFrom(probe, 0);
    const survivors = candidates.filter((row) => compiled.test(seriesTarget(o.entry, row)));
    const table = await idTable(
      engine,
      ['series_id'],
      survivors.map((r) => [r.seriesId]),
    );
    try {
      return await use(scope(idTableSeriesQuery(table)));
    } finally {
      await dropResidualTable(engine, table).catch(() => undefined);
    }
  }

  async function seriesRowsTable(series: Query, files: Pruned, s: AbortSignal | undefined) {
    const t = await read(files, series.clone().limit(RESIDUAL_SERIES_CAP + 1), s);
    if (t.numRows > RESIDUAL_SERIES_CAP) throw tooManySeries();
    return t;
  }
  const checkWhere = (where: string | null): void => {
    if (where !== null && where.trim() !== '') rejectPerPointPaths(pathsOf(parseCondition(where)));
  };
  const resourceTextsOf = (c: CatalogRows, resources: readonly number[] | undefined): string[] | null =>
    resources === undefined ? null : [...new Set(resources.flatMap((i) => c.resourceTexts[i] ?? []))];
  const notesOf = (entry: MetricRunQueryRequest['entry'], residual: string | null): string[] => [
    ...(entry.conflicting ? [NOTES.conflicting(entry)] : []),
    ...(entry.noValue > 0 ? [NOTES.noValue(entry.noValue)] : []),
    ...(residual === null ? [] : [NOTES.residual(residual)]),
  ];

  // ---- the body of the pre-change metricRunQuery ----
  throwIfAborted(signal);
  const { entry, query: q } = req;
  const kind = kindOf(entry);
  checkShow(kind, q.show);
  checkWhere(q.where);
  checkWhere(req.failedWhen);
  const by = q.by.map(byExpr);
  const runBy = byExpr(req.runBy);
  const identity = identityOf(cat, entry.id);

  return scoped(
    {
      entry,
      identity,
      condition: q.where,
      window: null,
      resourceTexts: resourceTextsOf(cat, req.resources),
      seriesIds: null,
    },
    signal,
    async (scope) => {
      const input = {
        query: q,
        entry,
        kind,
        window: req.window,
        runBy: req.runBy,
        notes: notesOf(entry, scope.residual),
      };
      const none = {
        runs: [],
        lines: [],
        leftOut: 0,
        queryId: q.id,
        window: req.window,
        notes: input.notes,
      };
      if (scope.files.files.length === 0) return none;
      const series = scope.seriesFor(by);
      const summary = kind === 'summary';
      const failedWhen = req.failedWhen !== null && req.failedWhen.trim() !== '' ? req.failedWhen : null;
      const [runs, cells, failed, labelRows] = await Promise.all([
        read(scope.files, runsQuery(identity, scope.seriesFor([runBy]), scope.files, epoch), signal),
        read(
          scope.files,
          metricCellsQuery({
            identity,
            kind,
            show: q.show,
            series,
            files: scope.files,
            window: null,
            cell: { kind: 'run', run: runBy },
            epoch,
            byCount: by.length,
          }),
          signal,
        ),
        failedWhen === null
          ? null
          : scoped(
              {
                entry,
                identity,
                condition: failedWhen,
                window: null,
                resourceTexts: resourceTextsOf(cat, req.resources),
                seriesIds: seriesIdsQuery(series),
              },
              signal,
              (failedScope) =>
                read(
                  failedScope.files,
                  metricCellsQuery({
                    identity,
                    kind,
                    show: q.show,
                    series: failedScope.seriesFor(by),
                    files: failedScope.files,
                    window: null,
                    cell: { kind: 'run', run: runBy },
                    epoch,
                    byCount: by.length,
                  }),
                  signal,
                ),
            ),
        summary ? seriesRowsTable(series, scope.files, signal) : null,
      ]);
      const rows = labelRows === null ? [] : seriesRowsFrom(labelRows, by.length);
      return runsFrom(runs, cells, failed, {
        ...input,
        ctx: {
          baseLabel: entry.name,
          seriesLabels: new Map(rows.map((r) => [r.seriesId, seriesLabel(r, entry)])),
        },
      });
    },
  );
}
