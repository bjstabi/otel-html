import { describe, expect, test } from 'vitest';
import type { SpanId, TraceId } from '../../src/model/ids.js';
import { bindUrl, createSelectionStore, type HistoryPort } from '../../src/viewer/state/selection.js';

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
    store.getState().toggleFacet('status.code', 'STATUS_CODE_ERROR', 'include');
    expect(store.getState().condition).toBe('span.name == "x" and span.status.code == "STATUS_CODE_ERROR"');
    store.getState().toggleFacet('status.code', 'STATUS_CODE_ERROR', 'include');
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
    bindUrl(store, h);
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
    bindUrl(store, h);
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
    const unbind = bindUrl(store, h);
    unbind();
    expect(h.listeners).toBe(0);
    store.getState().selectTrace(TRACE);
    expect(h.writes).toEqual([]);
  });
});
