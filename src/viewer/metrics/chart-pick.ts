import { parseSpanId, parseTraceId } from '../../model/ids.js';
import type { ChartPick } from '../components/metric-chart-card.js';
import type { DataSource } from '../data/data-source.js';
import type { MetricQuery } from '../data/metric-query.js';
import type { TimeWindow } from '../data/span-query.js';
import type { GoTo } from '../shell/go-to.js';
import { metricWindowLink } from '../state/carry.js';
import { formatWindow } from '../state/url-state.js';

/** The chart card's `hasTrace`: an exemplar's trace id looked up in the report. */
export function exemplarTraceLookup(ds: Pick<DataSource, 'hasTrace'>): (traceId: string) => Promise<boolean> {
  return async (traceId) => ds.hasTrace(parseTraceId(traceId, 'exemplar.traceId'));
}

/**
 * What a chart card's click menu does, for the Explorer and every embedded grid: an exemplar opens its trace, Traces
 * and Logs open that window with the query's `where` (`metricWindowLink`, anything dropped goes to the shell's
 * notice), zoom sets the chart window. `queryOf` returns undefined for a formula, which carries only the window.
 * Throws when an id or window cannot go into a URL.
 */
export function openChartPick(
  pick: ChartPick,
  ctx: { goTo: GoTo; queryOf(id: string): MetricQuery | undefined; zoom(w: TimeWindow): void },
): void {
  switch (pick.kind) {
    case 'exemplar':
      ctx.goTo('traces', '/traces', {
        trace: parseTraceId(pick.traceId, 'exemplar.traceId'),
        span: pick.spanId === null ? null : parseSpanId(pick.spanId, 'exemplar.spanId'),
        t: null,
        q: null,
        text: null,
      });
      return;
    case 'traces':
    case 'logs': {
      const q = ctx.queryOf(pick.queryId);
      const { url, dropped } =
        q === undefined
          ? { url: { t: formatWindow(pick.window) }, dropped: [] }
          : metricWindowLink(q, pick.window, pick.kind);
      ctx.goTo(pick.kind, `/${pick.kind}`, { t: url.t ?? null, q: url.q ?? null, text: null }, dropped);
      return;
    }
    case 'zoom':
      ctx.zoom(pick.window);
      return;
    default: {
      const never: never = pick;
      throw new Error(`unhandled chart pick ${JSON.stringify(never)}`);
    }
  }
}
