import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { DashboardSchema, type WidgetInput } from '../../src/dashboards/schema.js';
import { COPYABLE_VIEWS, widgetFromPage } from '../../src/viewer/dashboards/copy-widget.js';
import { defaultMetricState } from '../../src/viewer/state/metric-state.js';
import { createSelectionStore } from '../../src/viewer/state/selection.js';

type Initial = Parameters<typeof createSelectionStore>[0];
const data = (initial: Initial) => createSelectionStore(initial).getState();

function widgetOf(r: ReturnType<typeof widgetFromPage>): WidgetInput {
  if (!r.ok) throw new Error(`not ok: ${r.reason}`);
  return r.widget;
}

/** Every copied widget must be accepted as the only widget of a dashboard. */
function parses(w: WidgetInput): void {
  expect(() => DashboardSchema.parse({ id: 'd', title: 'D', widgets: [w] })).not.toThrow();
}

describe('widgetFromPage', () => {
  test('Traces list keeps the query and text, at the default size', () => {
    const w = widgetOf(
      widgetFromPage('traces', data({ q: 'status.code == 2', text: 'boom', mode: 'traces' })),
    );
    expect(w).toEqual({ type: 'traces', x: 0, y: 0, w: 7, h: 13, query: 'status.code == 2', text: 'boom' });
    parses(w);
  });

  test('the Spans grouping (the page default) becomes mode: spans', () => {
    const w = widgetOf(widgetFromPage('traces', data({ mode: 'spans' })));
    expect(w).toMatchObject({ type: 'traces', mode: 'spans' });
    parses(w);
  });

  test('Logs toplist grouped by host.name', () => {
    const w = widgetOf(widgetFromPage('logs', data({ view: 'toplist', group: 'host.name' })));
    expect(w).toMatchObject({ type: 'toplist', signal: 'logs', groupBy: 'host.name', w: 4, h: 8 });
    parses(w);
  });

  test('Traces table without a group uses the explorer default', () => {
    const w = widgetOf(widgetFromPage('traces', data({ view: 'table' })));
    expect(w).toMatchObject({ type: 'table', signal: 'spans', groupBy: 'service.name' });
    parses(w);
  });

  test('Logs list becomes a logs widget', () => {
    const w = widgetOf(widgetFromPage('logs', data({ q: 'severity_number >= 17' })));
    expect(w).toEqual({ type: 'logs', x: 0, y: 0, w: 5, h: 13, query: 'severity_number >= 17' });
    parses(w);
  });

  test('Logs patterns, other views and Distribution say why not', () => {
    expect(widgetFromPage('logs', data({ mode: 'patterns' }))).toEqual({
      ok: false,
      reason: "Patterns can't become a widget yet",
    });
    expect(widgetFromPage('traces', data({ view: 'pie' }))).toEqual({
      ok: false,
      reason: 'Only the List, Top list and Table views can become widgets',
    });
    const m = { ...defaultMetricState(null), display: 'distribution' as const };
    expect(widgetFromPage('metrics', { ...data({}), metrics: m })).toEqual({
      ok: false,
      reason: "The Distribution display can't become a widget",
    });
  });

  test('Metrics without a metric says to choose one', () => {
    expect(widgetFromPage('metrics', data({}))).toEqual({ ok: false, reason: 'Choose a metric first' });
  });

  test('Metrics state becomes a metric widget with the same queries, omitting defaults', () => {
    const seed = defaultMetricState(null);
    const queries = seed.queries.map((q) => ({ ...q, metric: 'http.server.requests', show: 'rate' }));
    const m = { ...seed, queries, exemplars: true };
    const w = widgetOf(widgetFromPage('metrics', { ...data({}), metrics: m }));
    expect(w).toEqual({ type: 'metric', x: 0, y: 0, w: 6, h: 8, queries });
    parses(w);
    const scaled = widgetOf(
      widgetFromPage('metrics', { ...data({}), metrics: { ...m, scale: 'log', exemplars: false } }),
    );
    expect(scaled).toMatchObject({ scale: 'log', exemplars: false });
    parses(scaled);
  });

  test('every copyable view parses, and the YAML reads back to the widget', () => {
    for (const c of COPYABLE_VIEWS) {
      const w = widgetOf(
        widgetFromPage(
          c.page,
          data({ view: c.view as 'list', ...(c.mode === null ? {} : { mode: c.mode as 'spans' }) }),
        ),
      );
      expect(w.type).toBe(c.type);
      parses(w);
    }
    expect(parse('widgets:\n  - type: logs\n')).toBeTruthy();
  });
});
