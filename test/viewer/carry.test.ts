import { describe, expect, test } from 'vitest';
import type { SpanId, TraceId } from '../../src/model/ids.js';
import { parseLogRef } from '../../src/viewer/data/log-query.js';
import type { MetricQuery } from '../../src/viewer/data/metric-query.js';
import { applyPatch, carryTo, metricWindowLink } from '../../src/viewer/state/carry.js';
import {
  PAGE_OPTIONS,
  pageOfRoute,
  resolvePageMode,
  resolvePageView,
} from '../../src/viewer/state/page-options.js';
import {
  createSelectionStore,
  type SelectionData,
  selectionToUrlState,
} from '../../src/viewer/state/selection.js';

const TRACE = 'a'.repeat(32) as TraceId;
const SPAN = 'b'.repeat(16) as SpanId;

function data(over: Partial<SelectionData>): SelectionData {
  return { ...createSelectionStore({}).getState(), ...over };
}

describe('carryTo', () => {
  test('carry drops a span-only filter to logs and keeps window and text', () => {
    const { url, dropped } = carryTo(
      data({ condition: 'span.name == "x"', text: 'boom', window: { start: 1, end: 2 }, mode: 'traces' }),
      'traces',
      'logs',
    );
    expect(url).toEqual({ text: 'boom', t: '1~2' });
    expect(dropped).toEqual([
      { key: 'q', value: 'span.name == "x"', reason: expect.stringMatching(/log_record/) },
    ]);
  });

  test('carry keeps a resource filter across signals', () => {
    expect(
      carryTo(data({ condition: 'resource.attributes["service.name"] == "payments"' }), 'traces', 'logs').url
        .q,
    ).toBe('resource.attributes["service.name"] == "payments"');
  });

  test('every other key resets across explorers', () => {
    const s = data({
      mode: 'traces',
      groupBy: 'g',
      view: 'pie',
      sort: 'start:asc',
      traceId: TRACE,
      spanId: SPAN,
      logRef: parseLogRef('1.2', 'log'),
      tabs: { trace: 'waterfall', span: 'events', log: 'trace' },
    });
    expect(carryTo(s, 'traces', 'logs')).toEqual({ url: {}, dropped: [] });
    expect(carryTo(s, 'logs', 'traces')).toEqual({ url: {}, dropped: [] });
    expect(carryTo(s, null, 'traces')).toEqual({ url: {}, dropped: [] });
  });

  test('a log filter does not carry to traces', () => {
    const { url, dropped } = carryTo(data({ condition: 'log.severity_number >= 17' }), 'logs', 'traces');
    expect(url).toEqual({});
    expect(dropped).toEqual([
      { key: 'q', value: 'log.severity_number >= 17', reason: expect.stringMatching(/span/) },
    ]);
  });

  test('same page keeps everything', () => {
    const s = data({
      condition: 'span.name == "x"',
      mode: 'traces',
      view: 'pie',
      traceId: TRACE,
      groupBy: 'g',
    });
    expect(carryTo(s, 'traces', 'traces')).toEqual({ url: selectionToUrlState(s), dropped: [] });
  });

  test('the dashboards target keeps everything', () => {
    const s = data({ condition: 'span.name == "x"', mode: 'traces', text: 'a' });
    expect(carryTo(s, 'traces', 'dashboards')).toEqual({ url: selectionToUrlState(s), dropped: [] });
  });
});

describe('applyPatch', () => {
  test('sets keys and removes the ones patched to null', () => {
    expect(applyPatch({ text: 'a', mode: 'patterns' }, { mode: null, q: 'x == 1' })).toEqual({
      text: 'a',
      q: 'x == 1',
    });
    expect(applyPatch({ text: 'a' }, {})).toEqual({ text: 'a' });
  });
});

describe('page options', () => {
  test('pageOfRoute maps routes and their subroutes', () => {
    expect(pageOfRoute('/traces')).toBe('traces');
    expect(pageOfRoute('/traces/trace/abc')).toBe('traces');
    expect(pageOfRoute('/traces/services')).toBe('traces');
    expect(pageOfRoute('/logs')).toBe('logs');
    expect(pageOfRoute('/logs/patterns')).toBe('logs');
    expect(pageOfRoute('/metrics')).toBe('metrics');
    expect(pageOfRoute('/dashboards')).toBe('dashboards');
    expect(pageOfRoute('/tracesx')).toBeNull();
    expect(pageOfRoute('/')).toBeNull();
  });

  test('the first mode is the default and the contexts are the OTTL contexts', () => {
    expect(PAGE_OPTIONS.traces.modes[0]).toBe('spans');
    expect(PAGE_OPTIONS.logs.modes[0]).toBe('logs');
    expect([PAGE_OPTIONS.traces.context, PAGE_OPTIONS.logs.context]).toEqual(['span', 'log_record']);
    expect(PAGE_OPTIONS.logs.views).toContain('scatter');
    expect(PAGE_OPTIONS.logs.views).not.toContain('pointplot');
    expect(PAGE_OPTIONS.traces.views).not.toContain('scatter');
  });

  test('resolvePageMode reports a foreign mode', () => {
    expect(resolvePageMode('logs', 'spans')).toEqual({
      mode: 'logs',
      invalid: 'mode=spans is not a Logs grouping: expected logs, patterns or traces',
    });
    expect(resolvePageMode('logs', null)).toEqual({ mode: 'logs', invalid: null });
    expect(resolvePageMode('logs', 'patterns')).toEqual({ mode: 'patterns', invalid: null });
    expect(resolvePageMode('traces', 'patterns')).toEqual({
      mode: 'spans',
      invalid: 'mode=patterns is not a Traces grouping: expected spans or traces',
    });
  });

  test('resolvePageView reports a foreign view', () => {
    expect(resolvePageView('logs', 'pointplot')).toEqual({
      view: 'list',
      invalid:
        'view=pointplot is not a Logs view: expected list, timeseries, toplist, bar, table, treemap, pie or scatter',
    });
    expect(resolvePageView('traces', 'scatter').invalid).toMatch(/^view=scatter is not a Traces view/);
    expect(resolvePageView('traces', 'pie')).toEqual({ view: 'pie', invalid: null });
    expect(resolvePageView('logs', null)).toEqual({ view: 'list', invalid: null });
  });
});

describe('carry to and from metrics', () => {
  const SERVICE = 'resource.attributes["service.name"] == "payments"';

  test('logs to metrics seeds the first query where from a q that compiles in datapoint', () => {
    const { url, dropped } = carryTo(
      data({ condition: SERVICE, window: { start: 1, end: 2 }, text: 'x' }),
      'logs',
      'metrics',
    );
    expect(dropped).toEqual([]);
    expect(url.t).toBe('1~2');
    expect(url.q).toBeUndefined();
    expect(url.text).toBeUndefined();
    expect(url.m?.queries[0]?.where).toBe(SERVICE);
  });

  test('a q that does not compile in datapoint is dropped with a reason', () => {
    const { url, dropped } = carryTo(data({ condition: 'log.body == "x"' }), 'logs', 'metrics');
    expect(url).toEqual({});
    expect(dropped).toEqual([{ key: 'q', value: 'log.body == "x"', reason: expect.any(String) }]);
    expect(dropped[0]?.reason).not.toBe('');
  });

  test('without a q there is no m', () => {
    expect(carryTo(data({ window: { start: 1, end: 2 } }), 'traces', 'metrics').url).toEqual({ t: '1~2' });
  });
});

describe('metricWindowLink', () => {
  const q = (where: string | null): MetricQuery => ({
    id: 'a',
    metric: 'x',
    kind: null,
    unit: null,
    show: 'rate',
    by: [],
    where,
    fn: [],
    alias: null,
    hidden: false,
  });
  const w = { start: 10, end: 20 };

  test('keeps a resource-only where', () => {
    const where = 'resource.attributes["service.name"] == "payments"';
    expect(metricWindowLink(q(where), w, 'logs')).toEqual({ url: { t: '10~20', q: where }, dropped: [] });
    expect(metricWindowLink(q(where), w, 'traces').url.q).toBe(where);
  });

  test('drops a data point attribute where, with the reason', () => {
    const where = 'attributes["http.route"] == "/pay"';
    const r = metricWindowLink(q(where), w, 'logs');
    expect(r.url).toEqual({ t: '10~20' });
    expect(r.dropped).toEqual([
      { key: 'q', value: where, reason: "data point attributes don't apply to logs" },
    ]);
  });

  test('drops a where that mixes resource and point attributes', () => {
    const where = 'resource.attributes["a"] == "b" and attributes["c"] == "d"';
    expect(metricWindowLink(q(where), w, 'traces').dropped).toHaveLength(1);
  });

  test('no where carries only the window', () => {
    expect(metricWindowLink(q(null), w, 'logs')).toEqual({ url: { t: '10~20' }, dropped: [] });
  });
});
