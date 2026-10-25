import { createStore, type StoreApi } from 'zustand/vanilla';
import { OtelHtmlError } from '../../model/errors.js';
import type { SpanId, TraceId } from '../../model/ids.js';
import { type FilterToken, facetKeyToPath, ottlToTokens, tokensToOttl } from '../components/filter-tokens.js';
import type { TimeWindow } from '../data/span-query.js';
import type { ExplorerView } from './explorer-view.js';
import { formatWindow, parseUrlState, parseWindow, serializeUrlState, type UrlState } from './url-state.js';

export const DEFAULT_TRACE_TAB = 'waterfall';
export const DEFAULT_SPAN_TAB = 'overview';

export type SelectionMode = 'spans' | 'traces';
export type ClearKey = 'window' | 'condition' | 'text' | 'traceId' | 'spanId' | 'groupBy' | 'sort';

export interface Selection {
  window: TimeWindow | null;
  condition: string | null;
  text: string;
  traceId: TraceId | null;
  spanId: SpanId | null;
  mode: SelectionMode;
  groupBy: string | null;
  view: ExplorerView;
  sort: string | null;
  tabs: { trace: string; span: string };
  setWindow(w: TimeWindow | null): void;
  setCondition(c: string | null): void;
  setText(t: string): void;
  setMode(m: SelectionMode): void;
  setGroupBy(g: string | null): void;
  setView(v: ExplorerView): void;
  setSort(s: string | null): void;
  setTab(which: 'trace' | 'span', tab: string): void;
  toggleFacet(key: string, value: string, op: 'include' | 'exclude'): void;
  selectTrace(id: TraceId | null): void;
  selectSpan(id: SpanId | null): void;
  clear(key: ClearKey): void;
}

type SelectionData = Omit<
  Selection,
  | 'setWindow'
  | 'setCondition'
  | 'setText'
  | 'setMode'
  | 'setGroupBy'
  | 'setView'
  | 'setSort'
  | 'setTab'
  | 'toggleFacet'
  | 'selectTrace'
  | 'selectSpan'
  | 'clear'
>;

function dataFromUrl(u: UrlState): SelectionData {
  return {
    window: u.t === undefined ? null : parseWindow(u.t),
    condition: u.q ?? null,
    text: u.text ?? '',
    traceId: u.trace ?? null,
    spanId: u.span ?? null,
    mode: u.mode ?? 'spans',
    groupBy: u.group ?? null,
    view: u.view ?? 'list',
    sort: u.sort ?? null,
    tabs: { trace: u.tab ?? DEFAULT_TRACE_TAB, span: u.stab ?? DEFAULT_SPAN_TAB },
  };
}

/** Defaults are omitted so a pristine store serializes to the empty string. */
export function selectionToUrlState(s: SelectionData): UrlState {
  const u: UrlState = {};
  if (s.condition !== null) u.q = s.condition;
  if (s.text !== '') u.text = s.text;
  if (s.window !== null) u.t = formatWindow(s.window);
  if (s.mode !== 'spans') u.mode = s.mode;
  if (s.groupBy !== null) u.group = s.groupBy;
  if (s.view !== 'list') u.view = s.view;
  if (s.traceId !== null) u.trace = s.traceId;
  if (s.spanId !== null) u.span = s.spanId;
  if (s.tabs.trace !== DEFAULT_TRACE_TAB) u.tab = s.tabs.trace;
  if (s.tabs.span !== DEFAULT_SPAN_TAB) u.stab = s.tabs.span;
  if (s.sort !== null) u.sort = s.sort;
  return u;
}

function toggleFacetCondition(
  condition: string | null,
  key: string,
  value: string,
  op: 'include' | 'exclude',
): string | null {
  let tokens: FilterToken[] = [];
  if (condition !== null) {
    const parsed = ottlToTokens(condition);
    if (parsed === null) {
      throw new OtelHtmlError('invalid-ottl', {
        path: 'condition',
        expected: 'a flat `and` of filter tokens to toggle a facet',
        actual: JSON.stringify(condition),
      });
    }
    tokens = parsed;
  }
  const path = facetKeyToPath(key, 'span');
  const wanted: FilterToken['op'] = op === 'include' ? '==' : '!=';
  const same = (t: FilterToken): boolean =>
    t.key === path && t.value === value && (t.op === '==' || t.op === '!=');
  const existing = tokens.find(same);
  const rest = tokens.filter((t) => !same(t));
  if (existing?.op !== wanted) rest.push({ key: path, op: wanted, value });
  return tokensToOttl(rest);
}

export function createSelectionStore(initial: UrlState): StoreApi<Selection> {
  return createStore<Selection>()((set, get) => ({
    ...dataFromUrl(initial),
    setWindow: (w) => {
      if (w !== null) formatWindow(w); // validates
      set({ window: w });
    },
    setCondition: (c) => set({ condition: c }),
    setText: (text) => set({ text }),
    setMode: (mode) => set({ mode }),
    setGroupBy: (groupBy) => set({ groupBy }),
    setView: (view) => set({ view }),
    setSort: (sort) => set({ sort }),
    setTab: (which, tab) => set({ tabs: { ...get().tabs, [which]: tab } }),
    toggleFacet: (key, value, op) =>
      set({ condition: toggleFacetCondition(get().condition, key, value, op) }),
    selectTrace: (traceId) => set({ traceId, spanId: null }),
    selectSpan: (spanId) => set({ spanId }),
    clear: (key) => {
      switch (key) {
        case 'window':
          return set({ window: null });
        case 'condition':
          return set({ condition: null });
        case 'text':
          return set({ text: '' });
        case 'traceId':
          return set({ traceId: null, spanId: null });
        case 'spanId':
          return set({ spanId: null });
        case 'groupBy':
          return set({ groupBy: null });
        case 'sort':
          return set({ sort: null });
      }
    },
  }));
}

export interface HistoryPort {
  /** The current query string (no route, no leading `?`). */
  read(): string;
  write(search: string, mode: 'push' | 'replace'): void;
  /** Fires only for changes not made through `write` (back/forward, manual edits). */
  subscribe(cb: () => void): () => void;
}

/**
 * Two-way binding. Trace/span opens push history entries; every other change replaces. Returns an unbind function.
 * Invalid URL params are passed to `onErrors` and rewritten out of the URL.
 */
export function bindUrl(
  store: StoreApi<Selection>,
  history: HistoryPort,
  onErrors?: (errors: string[]) => void,
): () => void {
  const current = (): string => serializeUrlState(selectionToUrlState(store.getState()));

  const applyUrl = (): void => {
    const { state, errors } = parseUrlState(history.read());
    store.setState(dataFromUrl(state));
    if (errors.length > 0) {
      onErrors?.(errors);
      history.write(current(), 'replace');
    }
  };
  applyUrl();

  const unsubscribeStore = store.subscribe((next, prev) => {
    const search = serializeUrlState(selectionToUrlState(next));
    if (search === serializeUrlState(parseUrlState(history.read()).state)) return;
    const opened = next.traceId !== prev.traceId || next.spanId !== prev.spanId;
    history.write(search, opened ? 'push' : 'replace');
  });
  const unsubscribeHistory = history.subscribe(() => {
    const { state, errors } = parseUrlState(history.read());
    const incoming = dataFromUrl(state);
    store.setState(incoming);
    if (errors.length > 0) {
      onErrors?.(errors);
      history.write(current(), 'replace');
    }
  });
  return () => {
    unsubscribeStore();
    unsubscribeHistory();
  };
}
