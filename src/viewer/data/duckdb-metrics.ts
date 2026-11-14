import { tableFromArrays } from '@uwdata/flechette';
import { and, type ExprNode, type Query } from '@uwdata/mosaic-sql';
import type { ManifestV4 } from '../../format/manifest.js';
import { OtelHtmlError } from '../../model/errors.js';
import { compileCondition } from '../../ottl/compile.js';
import { parseCondition } from '../../ottl/parse.js';
import { canonical, pathsOf, rejectPerPointPaths } from '../../query/metric-paths.js';
import { buildFilter, whereOf } from '../../query/sql/filter.js';
import {
  type ByExpr,
  byExpr,
  exemplarsQuery,
  idTableSeriesQuery,
  type MetricIdentity,
  metricCellsQuery,
  metricDefsQuery,
  metricIdentitiesQuery,
  metricSparkQuery,
  pointIntervalQuery,
  runsQuery,
  SPARK_BUCKETS,
  seriesIdsQuery,
  seriesQuery,
  seriesServicesQuery,
  summaryQuantilesQuery,
} from '../../query/sql/points.js';
import { absWindow, type Pruned, type RelWindow } from '../../query/sql/prune.js';
import { bucketSpec } from '../../query/sql/time.js';
import { resourceKey } from './metric-catalog.js';
import {
  chartFrom,
  exemplarsFrom,
  runsFrom,
  seriesLabel,
  seriesRowsFrom,
  seriesTarget,
  serviceOfRow,
  servicesFrom,
} from './metric-mappers.js';
import {
  type CatalogRows,
  type CatalogSeries,
  catalogFrom,
  chartWidthNs,
  type MetricMethods,
  type MetricQueryRequest,
  type MetricQueryResult,
  type MetricRunQueryRequest,
  pickWidthNs,
  upperMedian,
} from './metric-results.js';
import { checkShow, kindOf, NOTES, SHOW_BY_KIND } from './metric-tables.js';
import { filesFor, runPrepared, throwIfAborted } from './query-common.js';
import type { QueryEngine } from './query-engine.js';
import { dropResidualTable, idTable, servedResidual } from './residual.js';
import { leftOutOf, runStatisticsKey, runsInWindow, runValues } from './run-files.js';
import { cell, rowsOf, toNumber } from './span-results.js';

export interface MetricContext {
  engine: QueryEngine;
  manifest: ManifestV4;
  epoch: bigint;
  /** The report's time range relative to the epoch. */
  range: RelWindow | null;
  /** Where a failed cleanup of the D5 temp table is reported; silent without one. */
  logger?: Pick<Console, 'warn'>;
}

/** D22: series a `where` evaluated in the browser reads (D5), and the rows an exemplars query returns (D27). */
const RESIDUAL_SERIES_CAP = 200_000;
const EXEMPLAR_ROWS_CAP = 5_000;

/** A lower bound no point lies below, for the baseline of a counter's running total. */
const BEFORE_EVERYTHING = Number.MIN_SAFE_INTEGER;

/** Later than any point: the end of a window that has none (2^62 ns plus the epoch stays below 2^63). */
const NO_END = 2 ** 62;

const usage = (path: string, expected: string, actual: string): OtelHtmlError =>
  new OtelHtmlError('usage', { path, expected, actual });

const tooManySeries = (): OtelHtmlError =>
  new OtelHtmlError('usage', {
    message: `the condition needs the browser to evaluate part of it on more than ${RESIDUAL_SERIES_CAP} rows; narrow the window or the rest of the condition`,
  });

/** The series of one metric definition under a condition, ready to join the points of the pruned files (D22). */
interface Scope {
  /** The series query with the given `by` values (`g0..gN`). */
  seriesFor(by: readonly ByExpr[]): Query;
  files: Pruned;
  residual: string | null;
}

/** The metric data layer over `points` (D20, D30). */
export function metricMethods(ctx: MetricContext): MetricMethods {
  const { engine, epoch, range, manifest } = ctx;
  let catalog: Promise<CatalogRows> | null = null;
  /** Runs `q` after the engine prepared the points files it reads: `files`, or every one. */
  const read = (files: Pruned | undefined, q: Query, signal?: AbortSignal) =>
    runPrepared(engine, q, filesFor(manifest, ['points'], files), signal);

  const load = async (): Promise<CatalogRows> => {
    const spec = bucketSpec(null, range, SPARK_BUCKETS);
    const [defs, identities, spark, quantiles] = await Promise.all([
      read(undefined, metricDefsQuery()),
      read(undefined, metricIdentitiesQuery()),
      read(undefined, metricSparkQuery(spec, epoch)),
      read(undefined, summaryQuantilesQuery()),
    ]);
    return catalogFrom(defs, identities, spark, spec, quantiles);
  };
  const metricCatalog = (): Promise<CatalogRows> => {
    if (catalog === null) {
      const pending = load();
      catalog = pending;
      // a rejection clears the memo so the next call retries
      pending.catch(() => {
        if (catalog === pending) catalog = null;
      });
    }
    return catalog;
  };

  const identityOf = (cat: CatalogRows, entryId: number): MetricIdentity => {
    const identity = cat.identities[entryId];
    if (identity === undefined) throw usage('metric entry', 'an entry of the catalog', String(entryId));
    return identity;
  };

  /**
   * Builds the filter (the `where` translated, files pruned) and, for a residual term, the survivors' temp table of
   * series ids (D22, D5); `use` runs while the table exists.
   */
  async function scoped<T>(
    o: {
      entry: Parameters<typeof seriesTarget>[0];
      identity: MetricIdentity;
      condition: string | null;
      window: RelWindow | null;
      /** The lower time bound with no upper bound (report-relative ns): files that end before it are not read. */
      from?: number | null;
      /** A statistics key and the values a file must hold one of to be read (`runStatisticsKey`'s key). */
      runs?: { key: string; values: ReadonlySet<string> } | null;
      resourceTexts: readonly string[] | null;
      seriesIds: Query | null;
    },
    signal: AbortSignal | undefined,
    use: (s: Scope) => Promise<T>,
  ): Promise<T> {
    const { filter, residual } = buildFilter({
      manifest,
      table: 'points',
      condition: o.condition,
      text: '',
      window: o.from == null ? o.window : { start: o.from, end: NO_END },
      // `points` keeps `metric_name` statistics: a partition without the metric is not read.
      hints: new Map([
        ['metric_name', new Set([o.identity.name])],
        ...(o.runs == null ? [] : ([[o.runs.key, o.runs.values]] as const)),
      ]),
    });
    // seriesQuery adds the files term itself: the rest (translated condition, window) is the series' where.
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

    if (!engine.tempTables) throw servedResidual(residual); // D43: before the probe
    const compiled = compileCondition(residual, 'datapoint');
    const probe = await read(
      filter.files,
      base(o.seriesIds, [])
        .clone()
        .limit(RESIDUAL_SERIES_CAP + 1),
      signal,
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
      await dropResidualTable(engine, table).catch((error: unknown) => {
        ctx.logger?.warn(`could not clean up the temp table ${table}`, error);
      });
    }
  }

  /** The series rows for labels; more than `RESIDUAL_SERIES_CAP` is the D5 error rather than silent missing labels. */
  async function seriesRowsTable(series: Query, files: Pruned, signal: AbortSignal | undefined) {
    const t = await read(files, series.clone().limit(RESIDUAL_SERIES_CAP + 1), signal);
    if (t.numRows > RESIDUAL_SERIES_CAP) throw tooManySeries();
    return t;
  }

  /** `where` may not read per-point paths: a metric filter selects whole series. */
  const checkWhere = (where: string | null): void => {
    if (where !== null && where.trim() !== '') rejectPerPointPaths(pathsOf(parseCondition(where)));
  };

  const resourceTextsOf = (cat: CatalogRows, resources: readonly number[] | undefined): string[] | null =>
    resources === undefined ? null : [...new Set(resources.flatMap((i) => cat.resourceTexts[i] ?? []))];

  /** Notes known before any cell is read. */
  const notesOf = (entry: MetricQueryRequest['entry'], residual: string | null): string[] => [
    ...(entry.conflicting ? [NOTES.conflicting(entry)] : []),
    ...(entry.noValue > 0 ? [NOTES.noValue(entry.noValue)] : []),
    ...(residual === null ? [] : [NOTES.residual(residual)]),
  ];

  async function metricQuery(req: MetricQueryRequest, signal?: AbortSignal): Promise<MetricQueryResult> {
    throwIfAborted(signal);
    const { entry, query: q } = req;
    const kind = kindOf(entry);
    checkShow(kind, q.show);
    checkWhere(q.where);
    const by = q.by.map(byExpr);
    const cat = await metricCatalog();
    const identity = identityOf(cat, entry.id);
    const abs = absWindow(req.window, epoch);
    // A counter's running total needs the deltas before the window: neither the files nor the points are cut at its start.
    const baseline = kind === 'counter' && q.show === 'sum';
    const texts = resourceTextsOf(cat, req.resources);
    const scopeOf = (window: RelWindow) => ({
      entry,
      identity,
      condition: q.where,
      window,
      resourceTexts: texts,
      seriesIds: null,
    });

    // The bucket width comes from the points' interval over the requested window; the cells then read whole buckets.
    const width =
      req.widthNs ??
      (await scoped(scopeOf(req.window), signal, async (scope) => {
        const pick = pickWidthNs(req.window, req.maxPoints);
        if (scope.files.files.length === 0) return pick;
        const gaps = await read(
          scope.files,
          pointIntervalQuery(identity, scope.seriesFor(by), scope.files, abs),
          signal,
        );
        return chartWidthNs(pick, upperMedian(rowsOf(gaps).map((r) => toNumber(cell(r, 'gap'), 'gap'))));
      }));
    throwIfAborted(signal);
    // Whole buckets (ruling 7): from the start of the first bucket to the end of the last; a baseline keeps its open start.
    const whole: RelWindow = {
      start: Math.floor(req.window.start / width) * width,
      end: (Math.floor(req.window.end / width) + 1) * width - 1,
    };
    const readAbs = absWindow(whole, epoch);

    return scoped(
      scopeOf(baseline ? { start: BEFORE_EVERYTHING, end: whole.end } : whole),
      signal,
      async (scope) => {
        const empty = (widthNs: number): MetricQueryResult => ({
          queryId: q.id,
          widthNs,
          series: [],
          exemplars: [],
          heat: null,
          distribution: null,
          notes: notesOf(entry, scope.residual),
        });
        if (scope.files.files.length === 0) return empty(width);
        const series = scope.seriesFor(by);
        const summary = kind === 'summary';
        const [cells, exemplarTable, groupInfo] = await Promise.all([
          read(
            scope.files,
            metricCellsQuery({
              identity,
              kind,
              show: q.show,
              series,
              files: scope.files,
              window: readAbs,
              cell: { kind: 'time', widthNs: width, baseline },
              epoch,
              byCount: by.length,
            }),
            signal,
          ),
          req.exemplars
            ? read(
                scope.files,
                exemplarsQuery(
                  identity,
                  series,
                  scope.files,
                  readAbs,
                  epoch,
                  EXEMPLAR_ROWS_CAP + 1,
                  by.length,
                ),
                signal,
              )
            : null,
          // The chart colours by service; a summary draws a line per series, so it reads the series themselves.
          summary
            ? seriesRowsTable(series, scope.files, signal)
            : read(scope.files, seriesServicesQuery(series, by), signal),
        ]);
        const srcs = by.map((b) => b.src);
        const exemplarPoints =
          exemplarTable === null ? null : exemplarsFrom(exemplarTable, srcs, epoch, EXEMPLAR_ROWS_CAP);
        const capped = exemplarTable !== null && exemplarTable.numRows > EXEMPLAR_ROWS_CAP;
        const rows = summary ? seriesRowsFrom(groupInfo, by.length) : [];
        const byService = summary ? null : servicesFrom(groupInfo, srcs);
        const seriesLabels = new Map(rows.map((r) => [r.seriesId, seriesLabel(r, entry)]));
        const serviceOfSeries = new Map(rows.map((r) => [r.seriesId, serviceOfRow(r)]));
        return chartFrom({
          query: q,
          entry,
          kind,
          cells,
          exemplars: exemplarPoints,
          exemplarsCapped: capped,
          widthNs: width,
          window: req.window,
          notes: notesOf(entry, scope.residual),
          ctx: {
            baseLabel: entry.name,
            seriesLabels,
            serviceOf: (g) =>
              g.seriesId === null
                ? (byService?.get(g.byKey) ?? null)
                : (serviceOfSeries.get(g.seriesId) ?? null),
          },
        });
      },
    );
  }

  async function metricRunQuery(req: MetricRunQueryRequest, signal?: AbortSignal) {
    throwIfAborted(signal);
    const { entry, query: q } = req;
    const kind = kindOf(entry);
    checkShow(kind, q.show);
    checkWhere(q.where);
    checkWhere(req.failedWhen);
    const by = q.by.map(byExpr);
    const runBy = byExpr(req.runBy);
    const cat = await metricCatalog();
    const identity = identityOf(cat, entry.id);
    const texts = resourceTextsOf(cat, req.resources);
    const failedWhen = req.failedWhen !== null && req.failedWhen.trim() !== '' ? req.failedWhen : null;
    const input = (notes: string[]) => ({
      query: q,
      entry,
      kind,
      window: req.window,
      runBy: req.runBy,
      notes,
    });
    const labelsOf = (rows: ReturnType<typeof seriesRowsFrom>) => ({
      baseLabel: entry.name,
      seriesLabels: new Map(rows.map((r) => [r.seriesId, seriesLabel(r, entry)])),
    });

    /** Step 2 (or the whole read): the runs' rows, cells, failed cells and summary labels over the files `runs` keeps. */
    const readRuns = (
      runs: { key: string; values: ReadonlySet<string> } | null,
      leftOut: number | null,
      only: readonly string[] | null,
    ) =>
      scoped(
        {
          entry,
          identity,
          condition: q.where,
          window: null,
          runs,
          resourceTexts: texts,
          seriesIds: null,
        },
        signal,
        async (scope) => {
          const notes = notesOf(entry, scope.residual);
          if (scope.files.files.length === 0)
            return { runs: [], lines: [], leftOut: 0, queryId: q.id, window: req.window, notes };
          const series = scope.seriesFor(by);
          const summary = kind === 'summary';
          const [runTable, cells, failed, labelRows] = await Promise.all([
            read(
              scope.files,
              runsQuery(identity, scope.seriesFor([runBy]), scope.files, epoch, { leftOut, only }),
              signal,
            ),
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
            // The failing series are among the query's: the same cells over those alone.
            failedWhen === null
              ? null
              : scoped(
                  {
                    entry,
                    identity,
                    condition: failedWhen,
                    window: null,
                    runs,
                    resourceTexts: texts,
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
          return runsFrom(runTable, cells, failed, { ...input(notes), ctx: labelsOf(rows) });
        },
      );

    // The two steps need the run to name a statistics key the points files hold, and the catalogue to count the
    // series left out; otherwise every file is read at once, as it always was.
    const key = runStatisticsKey(req.runBy);
    const leftOut =
      key !== null && manifest.statisticsKeys.points.includes(key) ? catalogLeftOut(cat, req, runBy) : null;
    if (key === null || leftOut === null) return readRuns(null, null, null);

    // Step 1: which runs. The files that can hold a point at or after the window's start give each run's latest point.
    const from = Number.isFinite(req.window.start) ? req.window.start : null;
    const first = await scoped(
      {
        entry,
        identity,
        condition: q.where,
        window: null,
        from,
        resourceTexts: texts,
        seriesIds: null,
      },
      signal,
      async (scope) => ({
        notes: notesOf(entry, scope.residual),
        table:
          scope.files.files.length === 0
            ? null
            : await read(
                scope.files,
                runsQuery(identity, scope.seriesFor([runBy]), scope.files, epoch, { leftOut }),
                signal,
              ),
      }),
    );
    // No file can hold a run of the window, or no run is in it: no line, only the series left out, which the same mapper words.
    const chosen = first.table === null ? [] : runsInWindow(first.table, req.window);
    if (chosen.length === 0) {
      const empty = tableFromArrays({});
      const left = tableFromArrays({
        run: [null],
        t: [null],
        revision: [null],
        n_series: [0],
        left_out: [leftOut],
      });
      return runsFrom(first.table ?? left, empty, failedWhen === null ? null : empty, {
        ...input(first.notes),
        ctx: labelsOf([]),
      });
    }
    // Step 2: their points, from the files that hold them (the whole run, wherever it began).
    const values = runValues(chosen);
    return readRuns(values === null ? null : { key, values }, leftOut, chosen);
  }

  /**
   * The series with no run value among the catalogue's series of `req.entry` that pass the query's condition and
   * resources, or null when the catalogue cannot say (a condition on the description, which its rows do not read, or
   * one that does not compile, or a run expression other than a plain resource attribute).
   */
  function catalogLeftOut(cat: CatalogRows, req: MetricRunQueryRequest, runBy: ByExpr): number | null {
    const { entry, query: q } = req;
    let passes: (row: CatalogSeries) => boolean = () => true;
    if (q.where !== null && q.where.trim() !== '') {
      if (pathsOf(parseCondition(q.where)).some((p) => canonical(p).join('.') === 'metric.description'))
        return null;
      let compiled: ReturnType<typeof compileCondition<'datapoint'>>;
      try {
        compiled = compileCondition(q.where, 'datapoint');
      } catch {
        return null;
      }
      passes = (row) => compiled.test(seriesTarget(entry, row));
    }
    const texts = resourceTextsOf(cat, req.resources);
    const allowed = texts === null ? null : new Set(texts);
    return leftOutOf(
      cat.seriesOf(entry.id),
      (row) =>
        (allowed === null || allowed.has((row as CatalogSeries).resourceText)) &&
        passes(row as CatalogSeries),
      runBy,
    );
  }

  // Show options do not depend on the window: a summary's quantiles came with the catalogue.
  async function showOptionsOf(entryId: number): Promise<readonly string[]> {
    const cat = await metricCatalog();
    const entry = cat.entries[entryId];
    if (entry === undefined) throw usage('metric entry', 'an entry of the catalog', String(entryId));
    const kind = kindOf(entry);
    if (kind !== 'summary') return SHOW_BY_KIND[kind];
    return cat.quantiles.get(entryId) ?? SHOW_BY_KIND.summary;
  }

  return {
    metricCatalog,
    metricShowOptions: showOptionsOf,
    metricQuery,
    metricRunQuery,
    async metricsForResources(resources) {
      const cat = await metricCatalog();
      const keys = new Set(resources.map(resourceKey));
      return cat.entries.filter((e) =>
        e.resources.some((i) => {
          const r = cat.resources[i];
          return r !== undefined && keys.has(resourceKey(r));
        }),
      );
    },
  };
}
