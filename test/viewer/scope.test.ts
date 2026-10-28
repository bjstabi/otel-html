import { describe, expect, test } from 'vitest';
import { FUSION } from '../../src/dashboards/fusion.js';
import { DashboardSchema, type Widget, type WidgetType } from '../../src/dashboards/schema.js';
import type { AnyValue } from '../../src/model/anyvalue.js';
import type { RelNanos, TraceId, UnixNanos } from '../../src/model/ids.js';
import type {
  LogRecordRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
} from '../../src/model/records.js';
import {
  bindings,
  following,
  scopeFor,
  type VariableBinding,
  variableCondition,
  WIDGET_SCOPE,
} from '../../src/viewer/dashboards/scope.js';
import { type LogQuery, queryLogEntries, toLogEntries } from '../../src/viewer/data/log-query.js';
import { EMPTY_DASHBOARD_STATE } from '../../src/viewer/state/dashboard-state.js';

const TRACE = 'c'.repeat(32) as TraceId;
const PAGE = { start: 100, end: 200 };

const WIDGETS: Record<WidgetType, Widget> = {
  timeline: { type: 'timeline', id: 'w1', title: null, x: 0, y: 0, w: 12, h: 6 },
  traces: {
    type: 'traces',
    id: 'w2',
    title: null,
    x: 0,
    y: 0,
    w: 6,
    h: 6,
    follow: true,
    query: 'name == "x"',
    text: '',
    mode: 'traces',
  },
  logs: {
    type: 'logs',
    id: 'w3',
    title: null,
    x: 0,
    y: 0,
    w: 6,
    h: 6,
    follow: true,
    query: null,
    text: '',
    context: false,
  },
  metric: {
    type: 'metric',
    id: 'w4',
    title: null,
    x: 0,
    y: 0,
    w: 6,
    h: 6,
    follow: true,
    queries: null,
    formulas: [],
    display: 'lines',
    scale: 'linear',
    exemplars: false,
    echarts: null,
  },
  toplist: {
    type: 'toplist',
    id: 'w5',
    title: null,
    x: 0,
    y: 0,
    w: 6,
    h: 6,
    follow: true,
    signal: 'logs',
    query: null,
    text: '',
    groupBy: 'service.name',
    echarts: null,
  },
  table: {
    type: 'table',
    id: 'w6',
    title: null,
    x: 0,
    y: 0,
    w: 6,
    h: 6,
    follow: true,
    signal: 'spans',
    query: null,
    text: '',
    groupBy: 'service.name',
  },
};

const sel = { t: { start: 150, end: 180 }, trace: TRACE };
const ctx = (over: Partial<Parameters<typeof scopeFor>[1]> = {}): Parameters<typeof scopeFor>[1] => ({
  page: PAGE,
  sel,
  following: true,
  vars: [],
  ...over,
});
const traceClause = `trace_id.string == "${TRACE}"`;

describe('scopeFor, table-driven over WIDGET_SCOPE', () => {
  test.each(Object.entries(WIDGET_SCOPE))('%s', (type, rule) => {
    const widget = WIDGETS[type as WidgetType];
    const on = scopeFor(widget, ctx());
    expect(on.window).toEqual(rule.window === 'selection' ? sel.t : PAGE);
    expect(on.band).toEqual(rule.band ? sel.t : null);
    expect(on.traceFilter).toBe(rule.trace === 'filter' ? TRACE : null);
    expect(on.highlightTrace).toBe(rule.trace === 'highlight' || rule.trace === 'resources' ? TRACE : null);
    expect(on.condition?.includes(traceClause) ?? false).toBe(rule.trace === 'filter');
    expect(on.outside).toBe(false);

    if (type === 'timeline') return; // never follows: always draws the brush
    const off = scopeFor(widget, ctx({ following: false }));
    expect(off).toMatchObject({ window: PAGE, band: null, traceFilter: null, highlightTrace: null });
    expect(off.condition ?? '').not.toContain(traceClause);
  });

  test('logs: following with a trace adds the trace condition and the intersected window', () => {
    const s = scopeFor(WIDGETS.logs, ctx({ sel: { t: { start: 50, end: 150 }, trace: TRACE } }));
    expect(s.condition).toBe(traceClause);
    expect(s.window).toEqual({ start: 100, end: 150 });
  });

  test('metric: the band is sel.t and the window is the page', () => {
    const s = scopeFor(WIDGETS.metric, ctx());
    expect(s.band).toEqual(sel.t);
    expect(s.window).toBe(PAGE);
  });

  test('a selection disjoint from the page is outside and falls back to the page', () => {
    const s = scopeFor(WIDGETS.logs, ctx({ sel: { t: { start: 300, end: 400 }, trace: null } }));
    expect(s).toMatchObject({ window: PAGE, band: null, outside: true });
    expect(scopeFor(WIDGETS.metric, ctx({ sel: { t: { start: 300, end: 400 }, trace: null } })).outside).toBe(
      true,
    );
  });

  test('no selection window leaves the page; a null page takes the selection', () => {
    expect(scopeFor(WIDGETS.logs, ctx({ sel: { t: null, trace: null } })).window).toBe(PAGE);
    expect(scopeFor(WIDGETS.logs, ctx({ page: null })).window).toEqual(sel.t);
  });

  test('the widget query, variables and trace join with and', () => {
    const vars: VariableBinding[] = [{ key: 'k', value: 'v', kind: 'string' }];
    expect(scopeFor(WIDGETS.traces, ctx({ vars })).condition).toBe(
      '(name == "x") and (resource.attributes["k"] == "v")',
    );
    expect(scopeFor(WIDGETS.logs, ctx({ vars })).condition).toBe(
      `(resource.attributes["k"] == "v") and (${traceClause})`,
    );
    // variables apply even when the widget does not follow
    expect(scopeFor(WIDGETS.logs, ctx({ vars, following: false })).condition).toBe(
      'resource.attributes["k"] == "v"',
    );
  });
});

describe('following', () => {
  test('the URL override beats the config; a timeline never follows', () => {
    expect(following(WIDGETS.logs, EMPTY_DASHBOARD_STATE)).toBe(true);
    expect(following(WIDGETS.logs, { ...EMPTY_DASHBOARD_STATE, follow: { w3: false } })).toBe(false);
    expect(following(WIDGETS.timeline, { ...EMPTY_DASHBOARD_STATE, follow: { w1: true } })).toBe(false);
  });
});

describe('variableCondition', () => {
  const str = (value: string): AnyValue => ({ kind: 'string', value });
  const resource = (k: string): ResourceRecord => ({
    attributes: new Map([['k', str(k)]]),
    droppedAttributesCount: 0,
    schemaUrl: '',
  });
  const scope: ScopeRecord = {
    name: 's',
    version: '',
    attributes: new Map(),
    droppedAttributesCount: 0,
    schemaUrl: '',
  };
  const record = (r: number): LogRecordRecord => ({
    time: 1 as RelNanos,
    observedTime: null,
    severityNumber: 9,
    severityText: 'INFO',
    body: str('x'),
    attributes: new Map(),
    droppedAttributesCount: 0,
    flags: 0,
    traceId: null,
    spanId: null,
    eventName: '',
    resource: r as ResourceRef,
    scope: 0 as ScopeRef,
  });
  const base: LogQuery = {
    condition: null,
    text: '',
    window: null,
    mode: 'logs',
    sort: { column: 'time', dir: 'asc' },
    limit: 10,
    scanAll: false,
  };

  test('quoting survives a round trip through the evaluator', () => {
    const value = 'a"b\\c';
    const condition = variableCondition([{ key: 'k', value, kind: 'string' }], 'log');
    const entries = toLogEntries(
      { n: 0, resources: [resource(value), resource('other')], scopes: [scope] },
      [record(0), record(1)],
      0n as UnixNanos,
      'test',
    );
    expect(queryLogEntries(entries, { ...base, condition }).total).toBe(1);
  });

  test('none gives null; a typed value gives a literal; datapoint uses the same path', () => {
    expect(variableCondition([], 'log')).toBeNull();
    expect(variableCondition([{ key: 'pid', value: '7', kind: 'int' }], 'span')).toBe(
      'resource.attributes["pid"] == 7',
    );
    expect(variableCondition([{ key: 'k', value: 'v', kind: 'string' }], 'datapoint')).toBe(
      variableCondition([{ key: 'k', value: 'v', kind: 'string' }], 'span'),
    );
  });
});

describe('bindings', () => {
  const dashboard = DashboardSchema.parse({
    id: 'd',
    title: 'D',
    variables: [{ key: 'service.name', default: 'checkout' }, 'host.name', 'process.pid', 'mix'],
    widgets: [{ type: 'timeline', x: 0, y: 0, w: 12, h: 6 }],
  });
  const values = {
    'service.name': { values: ['checkout', 'payments'], kind: 'string' as const },
    'host.name': { values: ['h1'], kind: 'string' as const },
    'process.pid': { values: ['7'], kind: 'int' as const },
    mix: { values: ['1', 'a'], kind: 'mixed' as const },
  };
  const withVars = (vars: Record<string, string | null>) => ({ ...EMPTY_DASHBOARD_STATE, vars });

  test('the default applies, with the facet kind', () => {
    expect(bindings(dashboard, EMPTY_DASHBOARD_STATE, values).bindings).toEqual([
      { key: 'service.name', value: 'checkout', kind: 'string' },
    ]);
  });

  test('a URL value wins; null means all', () => {
    const r = bindings(dashboard, withVars({ 'service.name': 'payments', 'host.name': 'h1' }), values);
    expect(r.bindings.map((b) => b.value)).toEqual(['payments', 'h1']);
    expect(bindings(dashboard, withVars({ 'service.name': null }), values).bindings).toEqual([]);
  });

  test('a key with no values in the report is hidden and its default is not applied', () => {
    const r = bindings(dashboard, EMPTY_DASHBOARD_STATE, {
      ...values,
      'service.name': { values: [], kind: 'string' },
    });
    expect(r.bindings).toEqual([]);
    expect(r.hidden).toEqual(['service.name']);
    expect(bindings(dashboard, EMPTY_DASHBOARD_STATE, {}).hidden).toEqual([
      'service.name',
      'host.name',
      'process.pid',
      'mix',
    ]);
  });

  test('a mixed key compares as a string', () => {
    const r = bindings(dashboard, withVars({ 'service.name': null, mix: 'a' }), values);
    expect(r.bindings).toEqual([{ key: 'mix', value: 'a', kind: 'string' }]);
    expect(variableCondition(r.bindings, 'log')).toBe('resource.attributes["mix"] == "a"');
  });

  test('an unparseable typed value is unusable, and scopeFor never throws on the result', () => {
    const r = bindings(dashboard, withVars({ 'process.pid': 'abc', mix: '1' }), values);
    expect(r.unusable).toEqual([{ key: 'process.pid', value: 'abc', reason: expect.any(String) }]);
    expect(r.bindings.map((b) => b.key)).toContain('mix');
    for (const widget of Object.values(WIDGETS)) {
      expect(() => scopeFor(widget, ctx({ vars: r.bindings }))).not.toThrow();
    }
  });

  test('Fusion has no defaults', () => {
    expect(bindings(FUSION, EMPTY_DASHBOARD_STATE, {}).bindings).toEqual([]);
  });
});
