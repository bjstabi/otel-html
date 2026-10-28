import { anyValueToDisplay } from '../../model/anyvalue.js';
import { assertNever, OtelHtmlError } from '../../model/errors.js';
import type { MetricPointRecord, ResourceRecord } from '../../model/records.js';
import { type BucketAgg, type ExpAgg, type HistAgg, mergeAgg, quantileOf } from '../../rollups/metric-agg.js';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import { applyFns } from './metric-fn.js';
import { histogramViews } from './metric-heat.js';
import type { LevelData, LoadedMetric, LoadedSeries } from './metric-load.js';
import {
  type Across,
  COMBINE,
  type CombineRule,
  checkShow,
  DEFAULT_SHOW,
  kindOf,
  type MetricKind,
  NOTES,
  PERCENTILES,
  SHOW_BY_KIND,
  SUMMARY_TOP_QUANTILE,
} from './metric-tables.js';
import { compileSelector, targetOf } from './metric-where.js';
import { AbortTicker } from './query-common.js';
import type { TimeWindow } from './span-query.js';

export {
  COMBINE,
  type CombineRule,
  DEFAULT_SHOW,
  kindOf,
  type MetricKind,
  NOTES,
  SHOW_BY_KIND,
  SUMMARY_TOP_QUANTILE,
} from './metric-tables.js';

// ---------------------------------------------------------------------------------------------
// Query and result shapes
// ---------------------------------------------------------------------------------------------

export type MetricFn =
  | { op: 'rate' }
  | { op: 'increase' }
  | { op: 'rollup'; agg: 'avg' | 'min' | 'max' | 'sum'; intervalMs: number }
  | { op: 'top' | 'bottom'; n: number; by: 'avg' | 'max' | 'last' };

export interface MetricQuery {
  id: string;
  metric: string;
  kind: MetricPointRecord['type'] | null;
  unit: string | null;
  show: string;
  /** OTTL paths: `resource.attributes["…"]`, `attributes["…"]`. */
  by: string[];
  where: string | null;
  fn: MetricFn[];
  alias: string | null;
  hidden: boolean;
}

export interface SeriesPoints {
  key: string;
  label: string;
  group: Record<string, string>;
  unit: string;
  /** [bucket start (RelNanos), value]; null is a gap. */
  points: [number, number | null][];
  resourceService: string | null;
}

export interface MetricQueryResult {
  queryId: string;
  widthNs: number;
  series: SeriesPoints[];
  exemplars: {
    time: number;
    value: number;
    traceId: string | null;
    spanId: string | null;
    seriesKey: string;
  }[];
  heat: { bounds: number[]; cells: [number, number, number][] } | null;
  distribution: { bounds: number[]; counts: number[] } | null;
  notes: string[];
}

export function resolveMetric(
  catalog: { entries(): readonly MetricEntry[] },
  q: Pick<MetricQuery, 'metric' | 'kind' | 'unit'>,
): { entry: MetricEntry } | { ambiguous: MetricEntry[] } | { missing: true } {
  const found = catalog
    .entries()
    .filter(
      (e) =>
        e.name === q.metric &&
        (q.kind === null || e.type === q.kind) &&
        (q.unit === null || e.unit === q.unit),
    );
  const [only] = found;
  if (only === undefined) return { missing: true };
  return found.length === 1 ? { entry: only } : { ambiguous: found };
}

/** The quantiles present in a summary's finest level, as `q<quantile>` show options. */
function summaryQuantiles(m: LoadedMetric): string[] {
  const qs = new Set<number>();
  for (const s of m.levels[0]?.series.values() ?? [])
    for (const a of s.a) if (a.k === 'summary') for (const q of a.quantiles) qs.add(q.q);
  return [...qs].sort((a, b) => a - b).map((q) => `q${q}`);
}

/** Every `show` the metric offers (summary quantiles come from its data). */
export function showOptions(m: LoadedMetric): readonly string[] {
  const kind = kindOf(m.entry);
  return kind === 'summary' ? [...summaryQuantiles(m), ...SHOW_BY_KIND.summary] : SHOW_BY_KIND[kind];
}

/** The default `show` of a loaded metric: `DEFAULT_SHOW`, with a summary's highest quantile made concrete. */
export function defaultShow(m: LoadedMetric): string {
  const kind = kindOf(m.entry);
  if (kind !== 'summary') return DEFAULT_SHOW[kind];
  return summaryQuantiles(m).at(-1) ?? 'count';
}

// ---------------------------------------------------------------------------------------------
// Level pick
// ---------------------------------------------------------------------------------------------

const bucketsOver = (w: TimeWindow, widthNs: number): number =>
  Math.floor(w.end / widthNs) - Math.floor(w.start / widthNs) + 1;

/** The finest level with at most `maxPoints` buckets over the window, else the coarsest level present. */
export function pickLevel(
  levels: readonly LevelData[],
  window: TimeWindow,
  maxPoints: number,
): LevelData | null {
  const byWidth = [...levels].sort((a, b) => a.widthNs - b.widthNs);
  return (
    byWidth.find((l) => bucketsOver(window, l.widthNs) <= maxPoints) ?? byWidth[byWidth.length - 1] ?? null
  );
}

/**
 * The coarsest level no wider than `widthNs` (so `coarsenedTo` can merge it up to exactly that width), else the
 * finest level present (formula re-runs).
 */
function levelAtWidth(levels: readonly LevelData[], widthNs: number): LevelData | null {
  const byWidth = [...levels].sort((a, b) => a.widthNs - b.widthNs);
  return byWidth.filter((l) => l.widthNs <= widthNs).at(-1) ?? byWidth[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Combining
// ---------------------------------------------------------------------------------------------

/** One series' buckets inside the window: `a[lo..hi)` with indexes `t[lo..hi)`. */
interface Member {
  s: LoadedSeries;
  t: readonly number[];
  a: readonly BucketAgg[];
  lo: number;
  hi: number;
}

interface Group {
  /** The `by` values (plus the series, for summaries); bounds sets split it further only when they differ. */
  key: string;
  /** The `by` group alone (summaries add the series to `key`). */
  byKey: string;
  bounds: string;
  label: string;
  group: Record<string, string>;
  members: Member[];
}

function lowerBound(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Frame {
  b0: number;
  n: number;
  widthNs: number;
}

/** Per-bucket values of one group; NaN marks a gap. */
type Column = Float64Array;

function gaps(n: number): Column {
  return new Float64Array(n).fill(Number.NaN);
}

function counterColumn(g: Group, show: string, f: Frame): Column {
  const out = gaps(f.n);
  for (const m of g.members)
    for (let i = m.lo; i < m.hi; i++) {
      const a = m.a[i];
      const j = (m.t[i] ?? 0) - f.b0;
      if (a?.k !== 'counter') continue;
      out[j] = (Number.isNaN(out[j] ?? 0) ? 0 : (out[j] ?? 0)) + a.delta;
    }
  if (show === 'rate') {
    const perSec = 1e9 / f.widthNs;
    for (let j = 0; j < f.n; j++) out[j] = (out[j] ?? 0) * perSec;
  } else if (show === 'sum') {
    // Running total since the run start: deltas before the window count too.
    let total = 0;
    for (const m of g.members)
      for (let i = 0; i < m.lo; i++) {
        const a = m.a[i];
        if (a?.k === 'counter') total += a.delta;
      }
    for (let j = 0; j < f.n; j++) {
      const v = out[j] ?? Number.NaN;
      if (Number.isNaN(v)) continue;
      total += v;
      out[j] = total;
    }
  }
  return out;
}

function numberColumn(g: Group, show: string, across: Across, f: Frame): Column {
  const out = gaps(f.n);
  const n = new Uint32Array(f.n);
  for (const m of g.members)
    for (let i = m.lo; i < m.hi; i++) {
      const a = m.a[i];
      if (a?.k !== 'number') continue;
      const j = (m.t[i] ?? 0) - f.b0;
      const v = show === 'avg' ? a.sum / a.count : show === 'min' ? a.min : show === 'max' ? a.max : a.last;
      const cur = out[j] ?? Number.NaN;
      n[j] = (n[j] ?? 0) + 1;
      if (Number.isNaN(cur)) out[j] = v;
      else if (across === 'min') out[j] = Math.min(cur, v);
      else if (across === 'max') out[j] = Math.max(cur, v);
      else out[j] = cur + v;
    }
  if (across === 'mean') for (let j = 0; j < f.n; j++) out[j] = (out[j] ?? 0) / (n[j] ?? 1);
  return out;
}

function distributionShow(a: HistAgg | ExpAgg, show: string): number {
  const p = PERCENTILES[show];
  if (p !== undefined) return quantileOf(a, p) ?? Number.NaN;
  if (show === 'count') return a.count;
  if (show === 'sum') return a.sum;
  return a.count === 0 ? Number.NaN : a.sum / a.count;
}

/** Adds `b` into the accumulator `acc` (same bounds, guaranteed by the bounds split). */
function addHist(acc: HistAgg, b: HistAgg, path: string): void {
  if (acc.counts.length !== b.counts.length)
    throw new OtelHtmlError('invalid-report', {
      path,
      expected: `${acc.counts.length} bucket counts`,
      actual: String(b.counts.length),
    });
  acc.count += b.count;
  acc.sum += b.sum;
  acc.min = acc.min === null ? b.min : b.min === null ? acc.min : Math.min(acc.min, b.min);
  acc.max = acc.max === null ? b.max : b.max === null ? acc.max : Math.max(acc.max, b.max);
  for (let k = 0; k < b.counts.length; k++) acc.counts[k] = (acc.counts[k] ?? 0) + (b.counts[k] ?? 0);
}

/** The group's merged histogram per bucket (explicit or exponential). */
function mergedPerBucket(members: readonly Member[], f: Frame): (HistAgg | ExpAgg | undefined)[] {
  const merged = new Array<HistAgg | ExpAgg | undefined>(f.n);
  for (const m of members)
    for (let i = m.lo; i < m.hi; i++) {
      const a = m.a[i];
      if (a === undefined || (a.k !== 'hist' && a.k !== 'exp')) continue;
      const j = (m.t[i] ?? 0) - f.b0;
      const cur = merged[j];
      if (cur === undefined) merged[j] = a.k === 'hist' ? { ...a, counts: [...a.counts] } : a;
      else if (cur.k === 'hist' && a.k === 'hist') addHist(cur, a, `series ${m.s.def.id}`);
      else {
        const next = mergeAgg(cur, a, `series ${m.s.def.id}`);
        if (next.k === 'hist' || next.k === 'exp') merged[j] = next;
      }
    }
  return merged;
}

function histColumn(g: Group, show: string, f: Frame): Column {
  const out = gaps(f.n);
  mergedPerBucket(g.members, f).forEach((a, j) => {
    if (a !== undefined) out[j] = distributionShow(a, show);
  });
  return out;
}

function summaryColumn(g: Group, show: string, quantile: number | null, f: Frame): Column {
  const out = gaps(f.n);
  for (const m of g.members)
    for (let i = m.lo; i < m.hi; i++) {
      const a = m.a[i];
      if (a?.k !== 'summary') continue;
      const j = (m.t[i] ?? 0) - f.b0;
      if (show === 'count') out[j] = a.count;
      else if (show === 'sum') out[j] = a.sum;
      else out[j] = a.quantiles.find((x) => x.q === quantile)?.v ?? Number.NaN;
    }
  return out;
}

const serviceOf = (r: ResourceRecord | null): string | null => {
  const v = r?.attributes.get('service.name');
  return v?.kind === 'string' ? v.value : null;
};

function seriesLabel(s: LoadedSeries, e: MetricEntry): string {
  if (s.def.other) return 'other';
  if (s.def.attributes.size > 0)
    return [...s.def.attributes].map(([k, v]) => `${k}=${anyValueToDisplay(v)}`).join(', ');
  return serviceOf(s.resource) ?? e.name;
}

function topQuantile(members: readonly Member[]): number | null {
  let top: number | null = null;
  for (const m of members)
    for (let i = m.lo; i < m.hi; i++) {
      const a = m.a[i];
      if (a?.k === 'summary') for (const q of a.quantiles) if (top === null || q.q > top) top = q.q;
    }
  return top;
}

// ---------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------

/** Runs `q` at the level picked for `maxPoints` buckets over the window (finest level that fits). */
export function runMetricQuery(
  m: LoadedMetric,
  q: MetricQuery,
  window: TimeWindow,
  maxPoints: number,
  signal?: AbortSignal,
): MetricQueryResult {
  return runAtLevel(m, q, window, pickLevel(m.levels, window, maxPoints), signal);
}

/** Runs `q` at a given bucket width, for formulas whose operands must share one (`formulaWidth`). */
export function runMetricQueryAtWidth(
  m: LoadedMetric,
  q: MetricQuery,
  window: TimeWindow,
  widthNs: number,
  signal?: AbortSignal,
): MetricQueryResult {
  const level = levelAtWidth(m.levels, widthNs);
  return runAtLevel(m, q, window, level === null ? null : coarsenedTo(level, widthNs), signal);
}

/**
 * `level` merged into buckets of `widthNs` (aligned like a rollup: `floor(time / widthNs)`), so a formula reaches
 * a width off the ladder, such as an operand's rollup interval. A finer or equal width leaves it unchanged.
 */
function coarsenedTo(level: LevelData, widthNs: number): LevelData {
  if (widthNs <= level.widthNs) return level;
  const series = new Map<number, { t: number[]; a: BucketAgg[] }>();
  for (const [id, s] of level.series) {
    const t: number[] = [];
    const a: BucketAgg[] = [];
    s.t.forEach((b, i) => {
      const agg = s.a[i];
      if (agg === undefined) return;
      // By bucket start time, as `rollup` assigns points: widths need not divide each other.
      const nb = Math.floor((b * level.widthNs) / widthNs);
      const last = a[a.length - 1];
      if (t[t.length - 1] === nb && last !== undefined) a[a.length - 1] = mergeAgg(last, agg, `series ${id}`);
      else {
        t.push(nb);
        a.push(agg);
      }
    });
    series.set(id, { t, a });
  }
  // Merged buckets keep the last summary point, as a coarser ladder level does.
  return { level: Math.max(level.level, 1), widthNs, series };
}

function runAtLevel(
  m: LoadedMetric,
  q: MetricQuery,
  window: TimeWindow,
  level: LevelData | null,
  signal: AbortSignal | undefined,
): MetricQueryResult {
  const e = m.entry;
  const kind = kindOf(e);
  checkShow(kind, q.show);
  const combine = COMBINE[kind];
  const ticker = new AbortTicker(signal);

  const sel = compileSelector(q.where, q.by);

  const notes: string[] = [];
  const note = (n: string): void => {
    if (!notes.includes(n)) notes.push(n);
  };
  if (e.conflicting) note(NOTES.conflicting(e));
  if (m.fromSegments) note(NOTES.fromSegments);
  if (e.folded > 0 && sel.readsIdentity) note(NOTES.partial(e.folded));
  if (e.noValue > 0) note(NOTES.noValue(e.noValue));

  const widthNs = level?.widthNs ?? 0;
  const result = (series: SeriesPoints[], extra: Partial<MetricQueryResult> = {}): MetricQueryResult => ({
    queryId: q.id,
    widthNs,
    series,
    exemplars: [],
    heat: null,
    distribution: null,
    notes,
    ...extra,
  });
  if (level === null) return result([]);

  const b0Win = Math.floor(window.start / widthNs);
  const b1Win = Math.floor(window.end / widthNs);
  const groups = new Map<string, Group>();
  const groupOfSeries = new Map<number, Group>();
  let dataMin = Number.POSITIVE_INFINITY;
  let dataMax = Number.NEGATIVE_INFINITY;
  const baseLabel = q.alias ?? e.name;

  // Counter `sum` is a running total since the run start: series whose data all precede the window still
  // count toward their group's baseline.
  const runningTotal = kind === 'counter' && q.show === 'sum';
  const beforeWindow: { groupId: string; member: Member }[] = [];
  for (const s of m.series) {
    ticker.tick();
    const data = level.series.get(s.def.id);
    if (data === undefined) continue;
    const lo = lowerBound(data.t, b0Win);
    const hi = lowerBound(data.t, b1Win + 1);
    if (lo >= hi && !(runningTotal && lo > 0)) continue;
    const target = sel.by.length > 0 || sel.test !== null ? targetOf(e, s) : null;
    if (sel.test !== null && target !== null && !sel.test(target)) continue;
    const sg = sel.groupOf(s.def.other || target === null ? null : target);
    let key = sg.key;
    let label = sel.by.length > 0 ? sg.shown.join(', ') : baseLabel;
    const bounds = combine.rule === 'merge' && combine.splitByBounds ? JSON.stringify(s.def.bounds) : '';
    if (combine.rule === 'never') {
      key += `#${s.def.id}`;
      label = sel.by.length > 0 ? `${label} · ${seriesLabel(s, e)}` : seriesLabel(s, e);
    }
    const groupId = `${key}|${bounds}`;
    const member: Member = { s, t: data.t, a: data.a, lo, hi };
    if (lo >= hi) {
      beforeWindow.push({ groupId, member });
      continue;
    }
    let g = groups.get(groupId);
    if (g === undefined) {
      const group = Object.fromEntries(sel.by.map((b, i) => [b, sg.shown[i] ?? '']));
      g = { key, byKey: sg.key, bounds, label, group, members: [] };
      groups.set(groupId, g);
    }
    g.members.push(member);
    groupOfSeries.set(s.def.id, g);
    dataMin = Math.min(dataMin, data.t[lo] ?? b0Win);
    dataMax = Math.max(dataMax, data.t[hi - 1] ?? b1Win);
  }
  // A group with no data in the window draws nothing; otherwise its earlier series join the baseline.
  for (const { groupId, member } of beforeWindow) groups.get(groupId)?.members.push(member);
  if (groups.size === 0) return result([]);

  if (combine.rule === 'merge' && combine.splitByBounds) {
    // Lines of one by-group with different bounds sets keep their own line, keyed and labelled by bounds.
    const perBy = new Map<string, Group[]>();
    for (const g of groups.values()) perBy.set(g.key, [...(perBy.get(g.key) ?? []), g]);
    for (const gs of perBy.values())
      if (gs.length > 1) {
        note(NOTES.boundsDiffer);
        for (const g of gs) {
          g.key = `${g.key}|${g.bounds}`;
          g.label = `${g.label} · bounds [${g.members[0]?.s.def.bounds?.join(', ') ?? ''}]`;
        }
      }
  }
  if (combine.rule === 'never') {
    if (level.level > 0 && q.show !== 'count' && q.show !== 'sum') note(NOTES.summaryCoarse);
    const byGroups = new Set([...groups.values()].map((g) => g.byKey));
    if (byGroups.size < groups.size) note(NOTES.summariesNotCombined);
  }

  // Only the span holding data is materialised: a wide window over sparse data stays small.
  const frame: Frame = { b0: dataMin, n: dataMax - dataMin + 1, widthNs };
  const allMembers = [...groups.values()].flatMap((g) => g.members);
  if (kind === 'counter') {
    let resets = 0;
    for (const mb of allMembers)
      for (let i = mb.lo; i < mb.hi; i++) {
        const a = mb.a[i];
        if (a?.k === 'counter') resets += a.resets;
      }
    if (resets > 0) note(NOTES.resets(resets));
  }
  const quantile =
    kind === 'summary' && q.show !== 'count' && q.show !== 'sum'
      ? q.show === SUMMARY_TOP_QUANTILE
        ? topQuantile(allMembers)
        : Number(q.show.slice(1))
      : null;

  const unit =
    kind === 'counter' && q.show === 'rate'
      ? `${e.unit === '' ? '1' : e.unit}/s`
      : q.show === 'count'
        ? '{count}'
        : e.unit;
  const series: SeriesPoints[] = [];
  for (const g of groups.values()) {
    ticker.tick();
    const col = columnOf(kind, combine, g, q.show, quantile, frame);
    const points: [number, number | null][] = new Array(frame.n);
    for (let j = 0; j < frame.n; j++) {
      const v = col[j] ?? Number.NaN;
      points[j] = [(frame.b0 + j) * widthNs, Number.isFinite(v) ? v : null];
    }
    const services = new Set(g.members.map((mb) => (mb.s.def.other ? null : serviceOf(mb.s.resource))));
    const [service] = services;
    series.push({
      key: g.key,
      label: g.label,
      group: g.group,
      unit,
      points,
      resourceService: services.size === 1 && service !== undefined ? service : null,
    });
  }
  series.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  const fns = applyFns(series, widthNs, q.fn);
  const kept = new Set(fns.series.map((s) => s.key));
  const exemplars = m.exemplars.flatMap((x) => {
    const seriesKey = groupOfSeries.get(x.series)?.key;
    if (seriesKey === undefined || !kept.has(seriesKey) || x.time < window.start || x.time > window.end)
      return [];
    return [{ time: x.time, value: x.value, traceId: x.traceId, spanId: x.spanId, seriesKey }];
  });
  // Heatmap and distribution need one bucket layout across every series charted.
  const oneLayout = new Set(allMembers.map((mb) => JSON.stringify(mb.s.def.bounds))).size === 1;
  if (kind === 'hist' && !oneLayout) note(NOTES.heatBoundsDiffer);
  const views =
    (kind === 'hist' || kind === 'exp') && oneLayout
      ? histogramViews(mergedPerBucket(allMembers, frame), frame.b0, widthNs)
      : { heat: null, distribution: null };
  return { ...result(fns.series, { exemplars, ...views }), widthNs: fns.widthNs };
}

function columnOf(
  kind: MetricKind,
  combine: CombineRule,
  g: Group,
  show: string,
  quantile: number | null,
  f: Frame,
): Column {
  switch (kind) {
    case 'counter':
      return counterColumn(g, show, f);
    case 'number':
      return numberColumn(g, show, combine.rule === 'across' ? (combine.byShow[show] ?? 'mean') : 'mean', f);
    case 'hist':
    case 'exp':
      return histColumn(g, show, f);
    case 'summary':
      return summaryColumn(g, show, quantile, f);
    default:
      return assertNever(kind, 'metric kind');
  }
}
