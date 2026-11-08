import type { Table } from '@uwdata/flechette';
import { anyValueFromJson, attributesFromJson } from '../../format/columns.js';
import { anyValueToDisplay } from '../../model/anyvalue.js';
import type { UnixNanos } from '../../model/ids.js';
import type {
  MetricPointRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
} from '../../model/records.js';
import type { DatapointTarget } from '../../ottl/contexts.js';
import type { MetricQuery } from '../../query/metric-query.js';
import {
  downscaleExp,
  type ExpAgg,
  type ExpSide,
  type HistAgg,
  MIN_EXP_SCALE,
  mergeAgg,
  quantileOf,
} from '../../rollups/metric-agg.js';
import type { MetricEntry } from './metric-catalog.js';
import { applyFns } from './metric-fn.js';
import { histogramViews } from './metric-heat.js';
import type {
  MetricQueryResult,
  RunInfo,
  RunLine,
  RunQueryResult,
  SeriesPoints,
  SeriesRow,
} from './metric-results.js';
import { type MetricKind, NOTES, PERCENTILES, SUMMARY_TOP_QUANTILE } from './metric-tables.js';
import { cell, rowsOf, toNumber } from './span-results.js';
import type { TimeWindow } from './time-window.js';

// The mappers of the points-based metric queries: SQL result tables to the viewer's result shapes (D25, D26).

/** Most buckets one side of an exponential aggregate keeps (the old engine's `mergeAgg` bound). */
const MAX_EXP_BUCKETS = 160;
/** At most this many exemplars stay in one (series, bucket) (D27). */
const EXEMPLARS_PER_BUCKET = 4;

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/** A SQL number (bigint, decimal as number, DOUBLE) as a JS number; null and non-numbers are null. */
function dbl(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isNaN(n) && v !== 'NaN' ? null : n;
  }
  return null;
}

const dbl0 = (v: unknown): number => dbl(v) ?? 0;

/** A double of a point's JSON: a plain number, `{"$d": "text"}`, `{"$i": "text"}` or a string such as "NaN". */
function jsonDouble(v: unknown): number | null {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const { $d, $i } = v as Record<string, unknown>;
    return dbl($d ?? $i);
  }
  return dbl(v);
}

const list = (v: unknown): unknown[] =>
  v === null || v === undefined ? [] : Array.from(v as ArrayLike<unknown>);

/** The display of a `by` value stored as JSON text (D23); `(none)` for SQL NULL. */
function shownOf(text: unknown, memo: Map<string, string>): string {
  if (typeof text !== 'string') return '(none)';
  let shown = memo.get(text);
  if (shown === undefined) {
    shown = anyValueToDisplay(anyValueFromJson(text));
    memo.set(text, shown);
  }
  return shown;
}

// ---------------------------------------------------------------------------------------------
// Groups of cells
// ---------------------------------------------------------------------------------------------

type CellAgg =
  | { k: 'counter'; delta: number | null; resets: number }
  | { k: 'number'; value: number | null }
  | { k: 'agg'; agg: HistAgg | ExpAgg }
  | {
      k: 'summary';
      count: number | null;
      sum: number | null;
      quantiles: { q: number; v: number }[];
      points: number;
    };

/** One `by` group (and, for hist, bounds set; for a summary, series) with its cells. */
interface CellGroup {
  /** What tells groups apart inside one result (the key before bounds split it); the same for the cells and failed results. */
  id: string;
  /** The key of the drawn series. */
  key: string;
  /** The `by` group alone: the key of its values. */
  byKey: string;
  /** JSON of the explicit bounds, '' for the other kinds. */
  boundsKey: string;
  bounds: readonly number[] | null;
  label: string;
  group: Record<string, string>;
  seriesId: string | null;
  cells: Map<string | number, CellAgg>;
}

interface GroupContext {
  /** The label of a group without `by` (the alias or the metric name). */
  baseLabel: string;
  /** A summary series' label by `series_id`. */
  seriesLabels?: ReadonlyMap<string, string>;
  /** The service of a group: all of its series' one service, else null. */
  serviceOf?: (g: { byKey: string; seriesId: string | null }) => string | null;
}

function sideOf(v: unknown): ExpSide {
  const entries = list(v) as { idx: unknown; cnt: unknown }[];
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) return { offset: 0, counts: [] };
  const offset = dbl0(first.idx);
  const counts = new Array<number>(dbl0(last.idx) - offset + 1).fill(0);
  for (const e of entries) counts[dbl0(e.idx) - offset] = dbl0(e.cnt);
  return { offset, counts };
}

/** Downscales until each side holds at most `MAX_EXP_BUCKETS` buckets. */
function fitExp(a: ExpAgg): ExpAgg {
  let e = a;
  while (
    (e.positive.counts.length > MAX_EXP_BUCKETS || e.negative.counts.length > MAX_EXP_BUCKETS) &&
    e.scale > MIN_EXP_SCALE
  )
    e = downscaleExp(e, e.scale - 1);
  return e;
}

function quantilesOf(text: unknown): { q: number; v: number }[] {
  if (typeof text !== 'string') return [];
  const out: { q: number; v: number }[] = [];
  for (const e of JSON.parse(text) as { quantile?: unknown; value?: unknown }[]) {
    const q = jsonDouble(e.quantile);
    const v = jsonDouble(e.value);
    if (q !== null && v !== null) out.push({ q, v });
  }
  return out;
}

function cellAggOf(
  kind: MetricKind,
  row: Record<string, unknown>,
  bounds: readonly number[] | null,
): CellAgg {
  switch (kind) {
    case 'counter':
      return { k: 'counter', delta: dbl(cell(row, 'delta')), resets: dbl0(cell(row, 'resets')) };
    case 'number':
      return { k: 'number', value: dbl(cell(row, 'value')) };
    case 'hist': {
      const b = bounds ?? [];
      const counts = list(cell(row, 'counts')).map(dbl0);
      // A point without per-bucket counts contributes its total as one bucket: pad to the bounds' layout.
      while (counts.length < b.length + 1) counts.push(0);
      return {
        k: 'agg',
        agg: {
          k: 'hist',
          count: dbl0(cell(row, 'count')),
          sum: dbl0(cell(row, 'sum')),
          min: dbl(cell(row, 'min')),
          max: dbl(cell(row, 'max')),
          bounds: [...b],
          counts,
        },
      };
    }
    case 'exp':
      return {
        k: 'agg',
        agg: fitExp({
          k: 'exp',
          count: dbl0(cell(row, 'count')),
          sum: dbl0(cell(row, 'sum')),
          min: dbl(cell(row, 'min')),
          max: dbl(cell(row, 'max')),
          scale: dbl(cell(row, 'scale')) ?? 0,
          zeroCount: dbl0(cell(row, 'zero_count')),
          zeroThreshold: dbl0(cell(row, 'zero_threshold')),
          positive: sideOf(cell(row, 'positive')),
          negative: sideOf(cell(row, 'negative')),
        }),
      };
    case 'summary':
      return {
        k: 'summary',
        count: dbl(cell(row, 'count')),
        sum: dbl(cell(row, 'sum')),
        quantiles: quantilesOf(cell(row, 'quantiles')),
        points: dbl0(cell(row, 'points')),
      };
  }
}

/** The shown `by` values of a result row and their group key (D23: JSON texts, so int 1 and string "1" differ). */
function byOf(
  by: readonly string[],
  row: Record<string, unknown>,
  memo: Map<string, string>,
): { byKey: string; shown: string[] } {
  const texts = by.map((_, i) => row[`g${i}`] ?? null);
  return {
    byKey: JSON.stringify(by.map((src, i) => [src, texts[i]])),
    shown: texts.map((t) => shownOf(t, memo)),
  };
}

/**
 * Splits a cells result into groups: per `by` values, per bounds set (hist) or per series (summary). `cellOf` reads a
 * row's cell (null drops the row).
 */
function groupsFrom(
  kind: MetricKind,
  cells: Table,
  by: readonly string[],
  cellOf: (raw: unknown) => string | number | null,
  ctx: GroupContext,
): CellGroup[] {
  const groups = new Map<string, CellGroup>();
  const memo = new Map<string, string>();
  for (const row of rowsOf(cells)) {
    const at = cellOf(cell(row, 'cell'));
    if (at === null) continue;
    const { byKey, shown } = byOf(by, row, memo);
    const bounds = kind === 'hist' ? list(cell(row, 'bounds')).map(dbl0) : null;
    const boundsKey = bounds === null ? '' : JSON.stringify(bounds);
    const seriesId = kind === 'summary' ? String(cell(row, 'series_id')) : null;
    const id = `${byKey}|${boundsKey}|${seriesId ?? ''}`;
    let g = groups.get(id);
    if (g === undefined) {
      let key = byKey;
      let label = by.length > 0 ? shown.join(', ') : ctx.baseLabel;
      if (seriesId !== null) {
        key += `#${seriesId}`;
        const own = ctx.seriesLabels?.get(seriesId) ?? seriesId;
        label = by.length > 0 ? `${label} · ${own}` : own;
      }
      g = {
        id,
        key,
        byKey,
        boundsKey,
        bounds,
        label,
        group: Object.fromEntries(by.map((b, i) => [b, shown[i] ?? ''])),
        seriesId,
        cells: new Map(),
      };
      groups.set(id, g);
    }
    g.cells.set(at, cellAggOf(kind, row, bounds));
  }
  return [...groups.values()];
}

/** Lines of one by-group with different bounds sets keep their own line, keyed and labelled by bounds. Returns whether any split. */
function splitBounds(groups: readonly CellGroup[]): boolean {
  const perBy = new Map<string, CellGroup[]>();
  for (const g of groups) perBy.set(g.byKey, [...(perBy.get(g.byKey) ?? []), g]);
  let split = false;
  for (const gs of perBy.values())
    if (gs.length > 1) {
      split = true;
      for (const g of gs) {
        g.key = `${g.key}|${g.boundsKey}`;
        g.label = `${g.label} · bounds [${g.bounds?.join(', ') ?? ''}]`;
      }
    }
  return split;
}

// ---------------------------------------------------------------------------------------------
// Values per show
// ---------------------------------------------------------------------------------------------

function distributionShow(a: HistAgg | ExpAgg, show: string): number {
  const p = PERCENTILES[show];
  if (p !== undefined) return quantileOf(a, p) ?? Number.NaN;
  if (show === 'count') return a.count;
  if (show === 'sum') return a.sum;
  return a.count === 0 ? Number.NaN : a.sum / a.count;
}

const topQuantile = (groups: readonly CellGroup[]): number | null => {
  let top: number | null = null;
  for (const g of groups)
    for (const c of g.cells.values())
      if (c.k === 'summary') for (const q of c.quantiles) if (top === null || q.q > top) top = q.q;
  return top;
};

/** The quantile a summary `show` reads, or null for `count` and `sum`. */
function quantileFor(kind: MetricKind, show: string, groups: readonly CellGroup[]): number | null {
  if (kind !== 'summary' || show === 'count' || show === 'sum') return null;
  return show === SUMMARY_TOP_QUANTILE ? topQuantile(groups) : Number(show.slice(1));
}

/** One cell's value for `show` (no running total or rate scaling: those need the frame). */
function showValue(c: CellAgg, show: string, quantile: number | null): number {
  switch (c.k) {
    case 'counter':
      return c.delta ?? Number.NaN;
    case 'number':
      return c.value ?? Number.NaN;
    case 'agg':
      return distributionShow(c.agg, show);
    case 'summary':
      if (show === 'count') return c.count ?? Number.NaN;
      if (show === 'sum') return c.sum ?? Number.NaN;
      return c.quantiles.find((x) => x.q === quantile)?.v ?? Number.NaN;
  }
}

/** The unit of the charted values: `<unit>/s` for a counter's rate, `{count}` for a count, else the entry's. */
function unitOf(e: Pick<MetricEntry, 'unit'>, kind: MetricKind, show: string): string {
  if (kind === 'counter' && show === 'rate') return `${e.unit === '' ? '1' : e.unit}/s`;
  return show === 'count' ? '{count}' : e.unit;
}

// ---------------------------------------------------------------------------------------------
// The time-bucketed chart
// ---------------------------------------------------------------------------------------------

interface SeriesBuild {
  series: SeriesPoints[];
  /** The groups by the key of their series. */
  groups: ReadonlyMap<string, CellGroup>;
  /** The dense frame: the first cell's bucket index, the bucket count and the width. */
  frame: { b0: number; n: number; widthNs: number };
  /** Counter resets inside the window's cells. */
  resets: number;
  notes: string[];
}

/**
 * The dense series of a cells result: one point per bucket from the first to the last cell of any group (a gap where a
 * group has none). A counter's `sum` is the running total, which starts at the group's cell -1 (the deltas before the
 * window); `rate` divides by the width. Groups with no cell inside the window are not drawn.
 */
function seriesFrom(
  kind: MetricKind,
  show: string,
  cells: Table,
  frame: { widthNs: number },
  by: readonly string[],
  unit: string,
  ctx: GroupContext = { baseLabel: '' },
): SeriesBuild {
  const { widthNs } = frame;
  const all = groupsFrom(kind, cells, by, (raw) => toNumber(raw, 'cell'), ctx);
  const drawn = all.filter((g) => [...g.cells.keys()].some((c) => (c as number) >= 0));
  const notes: string[] = [];
  if (kind === 'hist' && splitBounds(drawn)) notes.push(NOTES.boundsDiffer);
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const g of drawn)
    for (const c of g.cells.keys()) {
      if ((c as number) < 0) continue;
      lo = Math.min(lo, c as number);
      hi = Math.max(hi, c as number);
    }
  if (drawn.length === 0)
    return { series: [], groups: new Map(), frame: { b0: 0, n: 0, widthNs }, resets: 0, notes };
  const b0 = Math.round(lo / widthNs);
  const n = Math.round(hi / widthNs) - b0 + 1;
  const quantile = quantileFor(kind, show, drawn);

  let resets = 0;
  let coarse = false;
  const series: SeriesPoints[] = [];
  for (const g of drawn) {
    const col = new Float64Array(n).fill(Number.NaN);
    let baseline = 0;
    for (const [at, c] of g.cells) {
      if (c.k === 'counter' && at === -1) baseline = c.delta ?? 0;
      if ((at as number) < 0) continue;
      if (c.k === 'counter') resets += c.resets;
      if (c.k === 'summary' && c.points > 1 && quantile !== null) coarse = true;
      col[Math.round((at as number) / widthNs) - b0] = showValue(c, show, quantile);
    }
    if (kind === 'counter' && show === 'rate') {
      const perSec = 1e9 / widthNs;
      for (let j = 0; j < n; j++) col[j] = (col[j] ?? 0) * perSec;
    } else if (kind === 'counter' && show === 'sum') {
      let total = baseline;
      for (let j = 0; j < n; j++) {
        const v = col[j] ?? Number.NaN;
        if (Number.isNaN(v)) continue;
        total += v;
        col[j] = total;
      }
    }
    const points: [number, number | null][] = new Array(n);
    for (let j = 0; j < n; j++) {
      const v = col[j] ?? Number.NaN;
      points[j] = [(b0 + j) * widthNs, Number.isFinite(v) ? v : null];
    }
    series.push({
      key: g.key,
      label: g.label,
      group: g.group,
      unit,
      points,
      resourceService: ctx.serviceOf?.(g) ?? null,
    });
  }
  series.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  if (kind === 'summary') {
    if (coarse) notes.push(NOTES.summaryCoarse);
    if (new Set(drawn.map((g) => g.byKey)).size < drawn.length) notes.push(NOTES.summariesNotCombined);
  }
  return {
    series,
    groups: new Map(drawn.map((g) => [g.key, g])),
    frame: { b0, n, widthNs },
    resets,
    notes,
  };
}

/** The histogram merged over the kept groups per time bucket, for the heatmap and distribution. */
function mergedPerBucket(
  groups: readonly CellGroup[],
  f: { b0: number; n: number; widthNs: number },
): (HistAgg | ExpAgg | undefined)[] {
  const merged = new Array<HistAgg | ExpAgg | undefined>(f.n);
  for (const g of groups)
    for (const [at, c] of g.cells) {
      if (c.k !== 'agg' || (at as number) < 0) continue;
      const j = Math.round((at as number) / f.widthNs) - f.b0;
      const cur = merged[j];
      if (cur === undefined) merged[j] = c.agg;
      else {
        const next = mergeAgg(cur, c.agg, `bucket ${j}`);
        if (next.k === 'hist' || next.k === 'exp') merged[j] = next;
      }
    }
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Exemplars
// ---------------------------------------------------------------------------------------------

export interface ExemplarPoint {
  /** The `by` group's key, as `CellGroup.byKey`. */
  byKey: string;
  time: number;
  value: number;
  traceId: string | null;
  spanId: string | null;
}

const stringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The exemplars of an `exemplarsQuery` result, oldest point first. `epoch` makes an exemplar's own time relative. */
export function exemplarsFrom(
  t: Table,
  by: readonly string[],
  epoch: bigint,
  rowLimit = Number.POSITIVE_INFINITY,
): ExemplarPoint[] {
  const out: ExemplarPoint[] = [];
  for (const row of rowsOf(t).slice(0, rowLimit)) {
    const { byKey } = byOf(by, row, new Map());
    const pointTime = toNumber(cell(row, 'time_ns'), 'time_ns');
    const text = cell(row, 'exemplars');
    if (typeof text !== 'string') continue;
    for (const e of JSON.parse(text) as Record<string, unknown>[]) {
      const value =
        cell(e, 'asDouble') !== undefined ? jsonDouble(cell(e, 'asDouble')) : dbl(cell(e, 'asInt'));
      if (value === null || !Number.isFinite(value)) continue;
      const at = cell(e, 'timeUnixNano');
      const own = typeof at === 'string' ? Number(BigInt(at) - epoch) : pointTime;
      out.push({
        byKey,
        time: own,
        value,
        traceId: stringOrNull(cell(e, 'traceId')),
        spanId: stringOrNull(cell(e, 'spanId')),
      });
    }
  }
  return out;
}

/** At most 4 exemplars per (series, bucket): those with a trace id first, then the largest absolute value. */
function capExemplars(xs: MetricQueryResult['exemplars'], widthNs: number): MetricQueryResult['exemplars'] {
  const per = new Map<string, MetricQueryResult['exemplars']>();
  for (const x of xs) {
    const id = `${x.seriesKey}\u0000${Math.floor(x.time / widthNs)}`;
    per.set(id, [...(per.get(id) ?? []), x]);
  }
  const kept: MetricQueryResult['exemplars'] = [];
  for (const group of per.values()) {
    const ranked = [...group].sort(
      (a, b) =>
        Number(b.traceId !== null) - Number(a.traceId !== null) || Math.abs(b.value) - Math.abs(a.value),
    );
    kept.push(...ranked.slice(0, EXEMPLARS_PER_BUCKET));
  }
  return kept.sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------------------------
// The whole chart result
// ---------------------------------------------------------------------------------------------

export interface ChartInput {
  query: MetricQuery;
  entry: MetricEntry;
  kind: MetricKind;
  cells: Table;
  /** Null when exemplars were not asked for. */
  exemplars: ExemplarPoint[] | null;
  exemplarsCapped: boolean;
  widthNs: number;
  window: TimeWindow;
  /** Notes known before the cells are read (conflicting, no value, residual). */
  notes: readonly string[];
  ctx: GroupContext;
}

/**
 * The chart of a cells result: the series (D25), `applyFns` (D26), the exemplars of the kept series, and the heatmap and
 * distribution of a histogram whose kept series share one layout.
 */
export function chartFrom(a: ChartInput): MetricQueryResult {
  const { query: q, entry: e, kind } = a;
  const notes = [...a.notes];
  const note = (n: string): void => {
    if (!notes.includes(n)) notes.push(n);
  };
  const result = (series: SeriesPoints[], extra: Partial<MetricQueryResult> = {}): MetricQueryResult => ({
    queryId: q.id,
    widthNs: a.widthNs,
    series,
    exemplars: [],
    heat: null,
    distribution: null,
    notes,
    ...extra,
  });
  const built = seriesFrom(kind, q.show, a.cells, { widthNs: a.widthNs }, q.by, unitOf(e, kind, q.show), {
    ...a.ctx,
    baseLabel: q.alias ?? e.name,
  });
  for (const n of built.notes) note(n);
  if (built.resets > 0) note(NOTES.resets(built.resets));
  if (a.exemplarsCapped) note(NOTES.exemplarsCapped);
  if (built.series.length === 0) return result([]);

  const fns = applyFns(built.series, a.widthNs, q.fn);
  const kept = new Set(fns.series.map((s) => s.key));
  // What `top`/`bottom` dropped is out of the exemplars, the heatmap and the distribution alike.
  const keptGroups = [...built.groups.values()].filter((g) => kept.has(g.key));
  const seriesOfBy = new Map<string, string>();
  for (const g of keptGroups) if (!seriesOfBy.has(g.byKey)) seriesOfBy.set(g.byKey, g.key);
  const exemplars = capExemplars(
    (a.exemplars ?? []).flatMap((x) => {
      const seriesKey = seriesOfBy.get(x.byKey);
      if (seriesKey === undefined || x.time < a.window.start || x.time > a.window.end) return [];
      return [{ time: x.time, value: x.value, traceId: x.traceId, spanId: x.spanId, seriesKey }];
    }),
    a.widthNs,
  );
  // Heatmap and distribution need one bucket layout across every series charted.
  const oneLayout = new Set(keptGroups.map((g) => g.boundsKey)).size === 1;
  if (kind === 'hist' && !oneLayout) note(NOTES.heatBoundsDiffer);
  const views =
    (kind === 'hist' || kind === 'exp') && oneLayout
      ? histogramViews(mergedPerBucket(keptGroups, built.frame), built.frame.b0, a.widthNs)
      : { heat: null, distribution: null };
  return { ...result(fns.series, { exemplars, ...views }), widthNs: fns.widthNs };
}

// ---------------------------------------------------------------------------------------------
// Run charts
// ---------------------------------------------------------------------------------------------

const leftOutNote = (n: number, runBy: string): string =>
  `${n} series ${n === 1 ? 'has' : 'have'} no value for ${runBy} and ${n === 1 ? 'is' : 'are'} left out`;

export interface RunsInput {
  query: MetricQuery;
  entry: MetricEntry;
  kind: MetricKind;
  window: TimeWindow;
  runBy: string;
  notes: readonly string[];
  ctx: GroupContext;
}

/**
 * The runs of a `runsQuery` result whose latest point lies in the window, ordered by time then id (D28), and one line
 * per group with a value per run from the run cells; a point is `failed` where the `failed` cells hold the line's run.
 * A counter's `rate` is its increase per second since the report's epoch (a run has no window of its own).
 */
export function runsFrom(runs: Table, cells: Table, failed: Table | null, a: RunsInput): RunQueryResult {
  const { query: q, entry: e, kind } = a;
  const memo = new Map<string, string>();
  const info: (RunInfo & { text: string })[] = [];
  let leftOut = 0;
  for (const row of rowsOf(runs)) {
    const text = cell(row, 'run');
    if (typeof text !== 'string') {
      leftOut += toNumber(cell(row, 'left_out') ?? 0n, 'left_out');
      continue;
    }
    const time = toNumber(cell(row, 't'), 't');
    if (time < a.window.start || time > a.window.end) continue;
    const revision = cell(row, 'revision');
    info.push({
      text,
      id: shownOf(text, memo),
      time,
      revision: typeof revision === 'string' && revision !== '' ? revision : null,
    });
  }
  info.sort((x, y) => x.time - y.time || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const runIndex = new Map(info.map((r, i) => [r.text, i]));

  const notes = [...a.notes];
  const note = (n: string): void => {
    if (!notes.includes(n)) notes.push(n);
  };
  const unit = unitOf(e, kind, q.show);
  const groups = groupsFrom(kind, cells, q.by, (raw) => (typeof raw === 'string' ? raw : null), {
    ...a.ctx,
    baseLabel: q.alias ?? e.name,
  });
  const live = groups.filter((g) => [...g.cells.keys()].some((c) => runIndex.has(c as string)));
  if (kind === 'hist' && splitBounds(live)) note(NOTES.boundsDiffer);
  const quantile = quantileFor(kind, q.show, live);
  let resets = 0;
  let coarse = false;
  const lines: RunLine[] = [];
  for (const g of live) {
    const points: RunLine['points'] = info.map(() => null);
    for (const [at, c] of g.cells) {
      const i = runIndex.get(at as string);
      if (i === undefined) continue;
      if (c.k === 'counter') resets += c.resets;
      if (c.k === 'summary' && c.points > 1 && quantile !== null) coarse = true;
      let value = showValue(c, q.show, quantile);
      if (kind === 'counter' && q.show === 'rate') value /= Math.max(1, (info[i]?.time ?? 0) / 1e9);
      if (Number.isFinite(value)) points[i] = { value, failed: false };
    }
    lines.push({ key: g.key, label: g.label, unit, points });
  }
  if (failed !== null) {
    const lineOf = new Map(live.map((g, i) => [g.id, lines[i]]));
    const markers = groupsFrom(kind, failed, q.by, (raw) => (typeof raw === 'string' ? raw : null), {
      ...a.ctx,
      baseLabel: q.alias ?? e.name,
    });
    for (const g of markers) {
      const target = lineOf.get(g.id);
      if (target === undefined) continue;
      for (const at of g.cells.keys()) {
        const i = runIndex.get(at as string);
        const p = i === undefined ? undefined : target.points[i];
        if (p !== undefined && p !== null) p.failed = true;
      }
    }
  }
  if (kind === 'counter' && resets > 0) note(NOTES.resets(resets));
  if (coarse) note(NOTES.summaryCoarse);
  if (kind === 'summary' && new Set(live.map((g) => g.byKey)).size < live.length)
    note(NOTES.summariesNotCombined);
  if (leftOut > 0) note(leftOutNote(leftOut, a.runBy));
  return {
    queryId: q.id,
    runs: info.map(({ id, time, revision }) => ({ id, time, revision })),
    lines: lines.sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0)),
    leftOut,
    window: a.window,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Series rows (the residual path, summary labels, services)
// ---------------------------------------------------------------------------------------------

/** The decoded rows of a `seriesQuery` result (`byCount` groups). Resource and scope texts are decoded once each. */
export function seriesRowsFrom(t: Table, byCount: number): SeriesRow[] {
  const resources = new Map<string, ResourceRecord>();
  const scopes = new Map<string, ScopeRecord>();
  return rowsOf(t).map((row) => {
    const text = String(cell(row, 'resource_attributes'));
    const rKey = JSON.stringify([
      text,
      cell(row, 'resource_schema_url'),
      String(cell(row, 'resource_dropped_attributes_count')),
    ]);
    let resource = resources.get(rKey);
    if (resource === undefined) {
      resource = {
        attributes: attributesFromJson(text),
        droppedAttributesCount: toNumber(cell(row, 'resource_dropped_attributes_count'), 'resource dropped'),
        schemaUrl: String(cell(row, 'resource_schema_url') ?? ''),
      };
      resources.set(rKey, resource);
    }
    const sKey = JSON.stringify([
      cell(row, 'scope_name'),
      cell(row, 'scope_version'),
      cell(row, 'scope_attributes'),
      cell(row, 'scope_schema_url'),
      String(cell(row, 'scope_dropped_attributes_count')),
    ]);
    let scope = scopes.get(sKey);
    if (scope === undefined) {
      scope = {
        name: String(cell(row, 'scope_name') ?? ''),
        version: String(cell(row, 'scope_version') ?? ''),
        attributes: attributesFromJson(String(cell(row, 'scope_attributes'))),
        droppedAttributesCount: toNumber(cell(row, 'scope_dropped_attributes_count'), 'scope dropped'),
        schemaUrl: String(cell(row, 'scope_schema_url') ?? ''),
      };
      scopes.set(sKey, scope);
    }
    const bounds = cell(row, 'explicit_bounds');
    return {
      seriesId: String(cell(row, 'series_id')),
      attributes: attributesFromJson(String(cell(row, 'attributes'))),
      resource,
      scope,
      bounds: bounds === null || bounds === undefined ? null : list(bounds).map(dbl0),
      groups: Array.from({ length: byCount }, (_, i) => {
        const g = cell(row, `g${i}`);
        return typeof g === 'string' ? g : null;
      }),
    };
  });
}

/** A `servicesQuery` result as the one service per `by` group (null when the group's series span several or none). */
export function servicesFrom(t: Table, by: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const row of rowsOf(t)) {
    const { byKey } = byOf(by, row, new Map());
    const services = list(cell(row, 'services'));
    const [only] = services;
    out.set(byKey, services.length === 1 && typeof only === 'string' ? only : null);
  }
  return out;
}

const EMPTY_REF = 0;

/**
 * A per-series target for `where` (never read times or values), built as the old engine's `targetOf` built one: the
 * series' resource, scope and attributes with the entry's definition and no point.
 */
export function seriesTarget(entry: MetricEntry, row: SeriesRow): DatapointTarget {
  return {
    resource: row.resource,
    scope: row.scope,
    epoch: 0n as UnixNanos,
    point: {
      name: entry.name,
      description: entry.description,
      unit: entry.unit,
      type: entry.type,
      temporality: entry.temporality,
      monotonic: entry.monotonic,
      start: null,
      time: 0 as MetricPointRecord['time'],
      attributes: row.attributes,
      flags: 0,
      point: null,
      resource: EMPTY_REF as ResourceRef,
      scope: EMPTY_REF as ScopeRef,
    },
  };
}

const serviceOf = (r: ResourceRecord): string | null => {
  const v = r.attributes.get('service.name');
  return v?.kind === 'string' ? v.value : null;
};

/** A summary series' label: its attributes as `k=v, ...`, else its service, else the metric name. */
export function seriesLabel(row: SeriesRow, entry: Pick<MetricEntry, 'name'>): string {
  if (row.attributes.size > 0)
    return [...row.attributes].map(([k, v]) => `${k}=${anyValueToDisplay(v)}`).join(', ');
  return serviceOf(row.resource) ?? entry.name;
}

/** The service of a series row, or null. */
export const serviceOfRow = (row: SeriesRow): string | null => serviceOf(row.resource);
