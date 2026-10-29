import { useMemo } from 'react';
import { METRIC_KEYS } from '../../../rollups/signal-counts.js';
import { TimeBuckets } from '../../../rollups/time-buckets.js';
import { ErrorCard, LoadingNote, PILL } from '../../components/explorer-states.js';
import { FusionTimeline, type TimelineLane } from '../../components/fusion-timeline.js';
import {
  type BucketView,
  type HistogramSeriesSet,
  SEVERITY_SERIES,
  SPAN_STATUS_SERIES,
} from '../../components/histogram-card.js';
import type { DataSource } from '../../data/data-source.js';
import type { TimeWindow } from '../../data/span-query.js';
import { useLogQuery } from '../../logs/use-log-query.js';
import { useKeyedAsync } from '../../state/use-keyed-async.js';
import type { QueryProgress, QueryState } from '../../state/use-query.js';
import { useSpanQuery } from '../../traces/use-span-query.js';
import type { WidgetRenderer } from '../dashboard-page.js';
import { FRAME_CHROME_PX } from './layout.js';

/** Metric points have one series; they are not a status, so no hatch. */
const METRIC_POINT_SERIES: HistogramSeriesSet<string> = {
  noun: 'metric points',
  topFirst: false,
  series: [{ key: 'points', label: 'points', color: 'var(--oh-series-3)' }],
};

const MIN_CHART_PX = 96;

interface ChunkCount {
  scanned: number;
  total: number;
}

function sum(b: BucketView<string>): number {
  return b.keys.reduce((n, k) => n + b.total(k), 0);
}

/**
 * Points in the buckets that overlap `w`; the rollup is run-wide, so the lane total follows the page window. A bucket
 * that sticks out of `w` counts whole, so the total is `approximate` when one with points does (and sticks out where
 * the run has data: past the run's ends there are no points to overcount).
 */
function pointsWithin(
  b: BucketView<string>,
  w: TimeWindow,
  run: TimeWindow | null,
): { n: number; approximate: boolean } {
  let n = 0;
  let approximate = false;
  for (const k of b.keys) {
    const counts = b.counts(k);
    for (let i = 0; i < b.length; i++) {
      const t = b.startNs + i * b.widthNs;
      const c = counts[i] ?? 0;
      if (c === 0 || t + b.widthNs <= w.start || t >= w.end) continue;
      n += c;
      // The part of the bucket where the run has data, against the window.
      const from = Math.max(t, run?.start ?? t);
      const to = Math.min(t + b.widthNs, run?.end ?? t + b.widthNs);
      if (from < w.start || to > w.end) approximate = true;
    }
  }
  return { n, approximate };
}

/** The scans still running, added up; null while none has reported. */
function scanProgress(states: readonly QueryState<unknown>[]): QueryProgress | null {
  let scanned = 0;
  let total = 0;
  for (const s of states) {
    if (s.status !== 'loading' || s.progress === null) continue;
    scanned += s.progress.scanned;
    total += s.progress.total;
  }
  return total === 0 ? null : { scanned, total };
}

function notes(parts: readonly (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => p !== null);
  return kept.length === 0 ? null : kept.join(' · ');
}

const partialNote = (p: ChunkCount | null): string | null =>
  p === null ? null : `from ${p.scanned} of ${p.total} chunks`;

const loadPoints = (ds: DataSource): Promise<TimeBuckets<'points'>> =>
  ds.manifest.totals.metrics === 0 ? Promise.resolve(new TimeBuckets(METRIC_KEYS)) : ds.metricPoints();

/** The Fusion timeline: spans, logs and metric points over the page's window; a drag sets the selection window. */
export const TimelineWidget: WidgetRenderer = ({ scope, height, dataSource, actions, variables }) => {
  const base = { condition: scope.condition, text: '', window: scope.window, limit: 1, scanAll: false };
  const spans = useSpanQuery(dataSource, {
    ...base,
    mode: 'spans',
    sort: { column: 'start', dir: 'asc' },
    groupBy: null,
  });
  const logs = useLogQuery(dataSource, { ...base, mode: 'logs', sort: { column: 'time', dir: 'desc' } });
  const points = useKeyedAsync(dataSource, loadPoints);

  const run = dataSource.manifest.range;
  const win = useMemo<TimeWindow>(
    () => scope.window ?? { start: run?.start ?? 0, end: Math.max(run?.end ?? 1, (run?.start ?? 0) + 1) },
    [scope.window, run],
  );

  const failed = [spans.state, logs.state, points].find((s) => s.status === 'error');
  const ready = useMemo(
    () =>
      spans.state.status === 'ready' && logs.state.status === 'ready' && points.status === 'ready'
        ? { spans: spans.state.result, logs: logs.state.result, points: points.value }
        : null,
    [spans.state, logs.state, points],
  );

  const lanes = useMemo<TimelineLane[] | null>(() => {
    if (ready === null) return null;
    const sp = ready.spans;
    const lg = ready.logs;
    const spanTotal = sum(sp.buckets);
    const logTotal = sum(lg.buckets);
    const points = pointsWithin(ready.points, win, run);
    return [
      {
        label: 'Spans',
        total: spanTotal,
        buckets: sp.buckets,
        series: SPAN_STATUS_SERIES,
        note: notes([partialNote(sp.partial), spanTotal === 0 ? 'no spans' : null]),
      },
      {
        label: 'Logs',
        total: logTotal,
        buckets: lg.buckets,
        series: SEVERITY_SERIES,
        note: notes([partialNote(lg.partial), logTotal === 0 ? 'no logs' : null]),
      },
      {
        label: 'Metric points',
        total: points.n,
        approximate: points.approximate,
        buckets: ready.points,
        series: METRIC_POINT_SERIES,
        note: notes([
          variables.length > 0 ? 'all resources' : null,
          points.n === 0 ? 'no metric points' : null,
        ]),
      },
    ];
  }, [ready, win, run, variables.length]);

  if (failed?.status === 'error')
    return <ErrorCard title="Could not load the timeline" message={failed.message} />;
  if (lanes === null) {
    return <LoadingNote progress={scanProgress([spans.state, logs.state])} />;
  }
  const partial = ready?.spans.partial !== null || ready?.logs.partial !== null;
  return (
    <div className="flex flex-col gap-1">
      <FusionTimeline
        lanes={lanes}
        window={win}
        brush={scope.band}
        height={Math.max(MIN_CHART_PX, height - FRAME_CHROME_PX - (partial ? 24 : 0))}
        onBrush={actions.selectWindow}
      />
      {partial && (
        <button
          type="button"
          onClick={() => {
            spans.scanAll();
            logs.scanAll();
          }}
          className={`${PILL} self-start text-accent underline`}
        >
          Scan entire run
        </button>
      )}
    </div>
  );
};
