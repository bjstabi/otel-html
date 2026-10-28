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
import { useSpanQuery } from '../../traces/use-span-query.js';
import type { WidgetRenderer } from '../dashboard-page.js';

/** Metric points have one series; they are not a status, so no hatch. */
const METRIC_POINT_SERIES: HistogramSeriesSet<string> = {
  noun: 'metric points',
  topFirst: false,
  series: [{ key: 'points', label: 'points', color: 'var(--oh-series-3)' }],
};

/** Card header, padding and border around the body; the chart gets what is left of the widget's height. */
const FRAME_CHROME_PX = 52;
const MIN_CHART_PX = 96;

interface Partial {
  scanned: number;
  total: number;
}

function sum(b: BucketView<string>): number {
  return b.keys.reduce((n, k) => n + b.total(k), 0);
}

/** Points whose bucket starts inside `w`; the rollup is run-wide, so the lane total follows the page window. */
function pointsWithin(b: BucketView<string>, w: TimeWindow): number {
  let n = 0;
  for (const k of b.keys) {
    const counts = b.counts(k);
    for (let i = 0; i < b.length; i++) {
      const t = b.startNs + i * b.widthNs;
      if (t + b.widthNs > w.start && t < w.end) n += counts[i] ?? 0;
    }
  }
  return n;
}

function notes(parts: readonly (string | null)[]): string | null {
  const kept = parts.filter((p): p is string => p !== null);
  return kept.length === 0 ? null : kept.join(' · ');
}

const partialNote = (p: Partial | null): string | null =>
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
    const pointTotal = pointsWithin(ready.points, win);
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
        total: pointTotal,
        buckets: ready.points,
        series: METRIC_POINT_SERIES,
        note: notes([
          variables.length > 0 ? 'all resources' : null,
          pointTotal === 0 ? 'no metric points' : null,
        ]),
      },
    ];
  }, [ready, win, variables.length]);

  if (failed?.status === 'error')
    return <ErrorCard title="Could not load the timeline" message={failed.message} />;
  if (lanes === null) {
    return <LoadingNote progress={spans.state.status === 'loading' ? spans.state.progress : null} />;
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
