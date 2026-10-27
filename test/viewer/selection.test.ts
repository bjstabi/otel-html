import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { SpanId, TraceId } from '../../src/model/ids.js';
import {
  type FilterToken,
  facetKeyToPath,
  ottlToTokens,
  tokensToOttl,
} from '../../src/viewer/components/filter-tokens.js';
import { parseLogRef } from '../../src/viewer/data/log-query.js';
import {
  bindUrl,
  createSelectionStore,
  type HistoryPort,
  selectionToUrlState,
} from '../../src/viewer/state/selection.js';

const TRACE = 'a'.repeat(32) as TraceId;
const SPAN = 'b'.repeat(16) as SpanId;

interface FakeHistory extends HistoryPort {
  writes: { s: string; mode: 'push' | 'replace' }[];
  external(s: string): void;
  listeners: number;
}

function fakeHistory(initial: string): FakeHistory {
  let cur = initial;
  const subs = new Set<() => void>();
  const h: FakeHistory = {
    writes: [],
    read: () => cur,
    write(s, mode) {
      cur = s;
      h.writes.push({ s, mode });
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    external(s) {
      cur = s;
      for (const cb of [...subs]) cb();
    },
    get listeners() {
      return subs.size;
    },
  };
  return h;
}

describe('toggleFacet', () => {
  test('include then exclude on the same value flips to != in canonical form', () => {
    const store = createSelectionStore({});
    store.getState().toggleFacet('service.name', 'checkout', 'include');
    expect(store.getState().condition).toBe('resource.attributes["service.name"] == "checkout"');
    store.getState().toggleFacet('service.name', 'checkout', 'exclude');
    expect(store.getState().condition).toBe('resource.attributes["service.name"] != "checkout"');
  });

  test('repeating the same facet removes it; other tokens stay', () => {
    const store = createSelectionStore({ q: 'span.name == "x"' });
    store.getState().toggleFacet('status.code', 'error', 'include');
    expect(store.getState().condition).toBe('span.name == "x" and span.status.code == STATUS_CODE_ERROR');
    store.getState().toggleFacet('status.code', 'error', 'include');
    expect(store.getState().condition).toBe('span.name == "x"');
    store.getState().toggleFacet('x', 'y', 'include');
    store.getState().clear('condition');
    expect(store.getState().condition).toBeNull();
  });

  test('a condition that is not a flat and of tokens fails fast', () => {
    const store = createSelectionStore({ q: 'a == 1 or b == 2' });
    expect(() => store.getState().toggleFacet('x', 'y', 'include')).toThrow(/condition/);
  });
});

describe('store state', () => {
  test('initial state comes from the URL state', () => {
    const store = createSelectionStore({
      t: '0~5000000',
      trace: TRACE,
      span: SPAN,
      mode: 'traces',
      tab: 'flame',
    });
    const s = store.getState();
    expect(s.window).toEqual({ start: 0, end: 5000000 });
    expect([s.traceId, s.spanId, s.mode, s.tabs.trace]).toEqual([TRACE, SPAN, 'traces', 'flame']);
  });

  test('the default trace tab is the flame graph and is omitted from the URL; other tabs round-trip', () => {
    const store = createSelectionStore({});
    expect(store.getState().tabs.trace).toBe('flame');
    expect(selectionToUrlState(store.getState())).toEqual({});
    store.getState().setTab('trace', 'waterfall');
    expect(selectionToUrlState(store.getState())).toEqual({ tab: 'waterfall' });
  });

  test('selecting a trace resets the span; clearing the trace clears both', () => {
    const store = createSelectionStore({ trace: TRACE, span: SPAN });
    store.getState().selectTrace('c'.repeat(32) as TraceId);
    expect(store.getState().spanId).toBeNull();
    store.getState().selectSpan(SPAN);
    store.getState().clear('traceId');
    expect([store.getState().traceId, store.getState().spanId]).toEqual([null, null]);
  });
});

describe('bindUrl', () => {
  test('applies the URL, reports errors and rewrites a clean URL with replace', () => {
    const store = createSelectionStore({});
    const h = fakeHistory('#/traces?t=abc&mode=traces');
    const seen: string[][] = [];
    const unbind = bindUrl(store, h, (e) => seen.push(e));
    expect(seen).toEqual([['t: expected <start>~<end> in nanoseconds, got abc']]);
    expect(store.getState().mode).toBe('traces');
    expect(h.writes).toEqual([{ s: 'mode=traces', mode: 'replace' }]);
    unbind();
  });

  test('trace and span opens push, window drags replace', () => {
    const store = createSelectionStore({});
    const h = fakeHistory('');
    bindUrl(store, h, () => undefined);
    store.getState().selectTrace(TRACE);
    store.getState().setWindow({ start: 0, end: 10 });
    store.getState().setWindow({ start: 1, end: 11 });
    store.getState().selectSpan(SPAN);
    expect(h.writes).toEqual([
      { s: `trace=${TRACE}`, mode: 'push' },
      { s: `t=0~10&trace=${TRACE}`, mode: 'replace' },
      { s: `t=1~11&trace=${TRACE}`, mode: 'replace' },
      { s: `t=1~11&trace=${TRACE}&span=${SPAN}`, mode: 'push' },
    ]);
  });

  test('external URL changes update the store without writing back', () => {
    const store = createSelectionStore({});
    const h = fakeHistory('');
    bindUrl(store, h, () => undefined);
    h.external(`trace=${TRACE}&t=2~4`);
    expect(store.getState().traceId).toBe(TRACE);
    expect(store.getState().window).toEqual({ start: 2, end: 4 });
    h.external('');
    expect(store.getState().traceId).toBeNull();
    expect(store.getState().window).toBeNull();
    expect(h.writes).toEqual([]);
  });

  test('unbind stops both directions', () => {
    const store = createSelectionStore({});
    const h = fakeHistory('');
    const unbind = bindUrl(store, h, () => undefined);
    unbind();
    expect(h.listeners).toBe(0);
    store.getState().selectTrace(TRACE);
    expect(h.writes).toEqual([]);
  });
});

describe('hostile input', () => {
  const HOSTILE = '") or true or ("\\ \n"';

  test('a facet value with quotes, backslashes and newlines round-trips as one token', () => {
    const store = createSelectionStore({});
    store.getState().toggleFacet('service.name', HOSTILE, 'include');
    const cond = store.getState().condition ?? '';
    expect(ottlToTokens(cond)).toEqual([
      { key: 'resource.attributes["service.name"]', op: '==', value: HOSTILE },
    ]);
    expect(cond).not.toContain('\n');
  });

  test('contains values with backslash and quote round-trip', () => {
    const tokens: FilterToken[] = [{ key: 'span.name', op: 'contains', value: 'a\\"b' }];
    expect(ottlToTokens(tokensToOttl(tokens) ?? '')).toEqual(tokens);
  });

  test('an attribute key containing a quote stays one path', () => {
    const key = 'we"ird\\key';
    const path = facetKeyToPath(key, 'span');
    const tokens: FilterToken[] = [{ key: path, op: 'exists', value: null }];
    expect(ottlToTokens(tokensToOttl(tokens) ?? '')).toEqual(tokens);
  });

  test('inherited property names and bare name/kind are span attributes', () => {
    for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'name', 'kind']) {
      expect(facetKeyToPath(k, 'span')).toBe(`span.attributes["${k}"]`);
    }
    expect(facetKeyToPath('span.kind', 'span')).toBe('span.kind');
  });
});

describe('setter validation and bind errors', () => {
  test('invalid values fail fast', () => {
    const s = createSelectionStore({}).getState();
    expect(() => s.setCondition('a ==')).toThrow(/condition/);
    expect(() => s.setGroupBy('')).toThrow(/groupBy/);
    expect(() => s.setTab('trace', '')).toThrow(/tabs.trace/);
    expect(() => s.setTab('trace', 'bogus')).toThrow(/tabs.trace[\s\S]*one of flame/);
    expect(() => s.setTab('log', 'flame')).toThrow(/tabs.log[\s\S]*one of attributes/);
  });
});

describe('logs selection', () => {
  test('mode defaults to null (the page default) and stays out of the URL', () => {
    const store = createSelectionStore({});
    expect(store.getState().mode).toBeNull();
    store.getState().setMode('patterns');
    expect(selectionToUrlState(store.getState())).toEqual({ mode: 'patterns' });
    store.getState().setMode(null);
    expect(selectionToUrlState(store.getState())).toEqual({});
  });

  test('log ref and log tab come from the URL and round-trip; the default tab is attributes', () => {
    const store = createSelectionStore({ log: parseLogRef('12.345', 'log'), ltab: 'trace' });
    expect(store.getState().logRef).toBe('12.345');
    expect(store.getState().tabs.log).toBe('trace');
    expect(selectionToUrlState(store.getState())).toEqual({ log: '12.345', ltab: 'trace' });
    store.getState().setTab('log', 'attributes');
    store.getState().clear('logRef');
    expect(selectionToUrlState(store.getState())).toEqual({});
  });

  test('setSeverityRange replaces only severity tokens', () => {
    const store = createSelectionStore({});
    const s = (): ReturnType<typeof store.getState> => store.getState();
    s().setCondition(
      'resource.attributes["service.name"] == "a" and log.severity_number >= SEVERITY_NUMBER_INFO',
    );
    s().setSeverityRange('warn', 'warn');
    expect(s().condition).toBe(
      'resource.attributes["service.name"] == "a" and log.severity_number >= SEVERITY_NUMBER_WARN and log.severity_number <= SEVERITY_NUMBER_WARN4',
    );
    s().setSeverityRange('error', null);
    expect(s().condition).toBe(
      'resource.attributes["service.name"] == "a" and log.severity_number >= SEVERITY_NUMBER_ERROR',
    );
    s().setSeverityRange(null, 'unspecified');
    expect(s().condition).toBe(
      'resource.attributes["service.name"] == "a" and log.severity_number <= SEVERITY_NUMBER_UNSPECIFIED',
    );
    s().setSeverityRange(null, null);
    expect(s().condition).toBe('resource.attributes["service.name"] == "a"');
    s().setCondition('log.severity_number >= 9 and log.severity_number <= 12');
    s().setSeverityRange(null, null);
    expect(s().condition).toBeNull();
    s().setSeverityRange('trace', 'fatal');
    expect(s().condition).toBe(
      'log.severity_number >= SEVERITY_NUMBER_TRACE and log.severity_number <= SEVERITY_NUMBER_FATAL4',
    );
  });

  test('setSeverityRange on a condition that is not a flat and fails fast', () => {
    const store = createSelectionStore({ q: 'a == 1 or b == 2' });
    expect(() => store.getState().setSeverityRange('warn', null)).toThrow(/condition/);
  });

  test('setSeverityRange with min above max is a usage error and leaves the condition alone', () => {
    const store = createSelectionStore({ q: 'log.severity_number >= SEVERITY_NUMBER_INFO' });
    expect(() => store.getState().setSeverityRange('error', 'warn')).toThrow(OtelHtmlError);
    expect(() => store.getState().setSeverityRange('error', 'warn')).toThrow(/severity range/);
    expect(store.getState().condition).toBe('log.severity_number >= SEVERITY_NUMBER_INFO');
  });

  test('selectLog pushes a history entry', () => {
    const store = createSelectionStore({});
    const h = fakeHistory('');
    bindUrl(store, h, () => undefined);
    store.getState().selectLog(parseLogRef('3.4', 'log'));
    store.getState().setTab('log', 'surrounding');
    store.getState().selectLog(null);
    expect(h.writes).toEqual([
      { s: 'log=3.4', mode: 'push' },
      { s: 'log=3.4&ltab=surrounding', mode: 'replace' },
      { s: 'ltab=surrounding', mode: 'push' },
    ]);
  });

  test('openSpanFromLog is one push: trace and span set, log and ltab dropped', () => {
    const store = createSelectionStore({ log: parseLogRef('3.4', 'log'), ltab: 'trace' });
    const h = fakeHistory('log=3.4&ltab=trace');
    bindUrl(store, h, () => undefined);
    store.getState().openSpanFromLog(TRACE, SPAN);
    expect(h.writes).toEqual([{ s: `trace=${TRACE}&span=${SPAN}`, mode: 'push' }]);
  });
});
