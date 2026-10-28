import { createStore, type StoreApi } from 'zustand/vanilla';
import { OtelHtmlError } from '../../model/errors.js';
import type { SpanId, TraceId } from '../../model/ids.js';
import { parseCondition } from '../../ottl/parse.js';
import type { MetricPageState } from '../../query/metric-query.js';
import type { SELECTION_MODES } from '../../query/pages.js';
import type { LogSeverityKey } from '../../semconv/severity.js';
import {
  type FacetScope,
  type FacetSignal,
  type FacetValueKind,
  type FilterToken,
  facetToken,
  ottlToTokens,
  SEVERITY_PATH,
  severityRangeTokens,
  tokensToOttl,
} from '../components/filter-tokens.js';
import type { LogRef } from '../data/log-query.js';
import type { TimeWindow } from '../data/span-query.js';
import { isLogTabId, LOG_TAB_IDS, type LogTabId } from '../logs/tabs.js';
import { isTraceTabId, TRACE_TAB_IDS, type TraceTabId } from '../traces/tabs.js';
import { type DashboardPageState, isPristine } from './dashboard-state.js';
import type { ExplorerView } from './explorer-view.js';
import { formatWindow, parseUrlState, parseWindow, serializeUrlState, type UrlState } from './url-state.js';

export const DEFAULT_TRACE_TAB: TraceTabId = 'flame';
export const DEFAULT_SPAN_TAB = 'overview';
export const DEFAULT_LOG_TAB: LogTabId = 'attributes';

/** Every explorer's groupings; `PAGE_OPTIONS` says which ones each page accepts. */
export type SelectionMode = (typeof SELECTION_MODES)[number];
export type ClearKey = 'window' | 'condition' | 'text' | 'traceId' | 'spanId' | 'logRef' | 'groupBy' | 'sort';

export interface Selection {
  window: TimeWindow | null;
  condition: string | null;
  text: string;
  traceId: TraceId | null;
  spanId: SpanId | null;
  logRef: LogRef | null;
  /** Null is the page's default mode (`PAGE_OPTIONS`); it is omitted from the URL. */
  mode: SelectionMode | null;
  groupBy: string | null;
  view: ExplorerView;
  sort: string | null;
  tabs: { trace: string; span: string; log: string };
  /** The Metrics page's state (URL key `m`); null until the page is first used. */
  metrics: MetricPageState | null;
  /** The Dashboards page's state (URL key `d`); null until the page is first used. */
  dashboard: DashboardPageState | null;
  setWindow(w: TimeWindow | null): void;
  setCondition(c: string | null): void;
  setText(t: string): void;
  setMode(m: SelectionMode | null): void;
  setGroupBy(g: string | null): void;
  setView(v: ExplorerView): void;
  setSort(s: string | null): void;
  setTab(which: 'trace' | 'span' | 'log', tab: string): void;
  setMetrics(m: MetricPageState | null): void;
  setDashboard(d: DashboardPageState | null): void;
  /** Facet values are strings (the rollups keep display text), so the token is a string literal. */
  toggleFacet(
    key: string,
    value: string,
    op: 'include' | 'exclude',
    scope?: FacetScope,
    kind?: FacetValueKind,
    signal?: FacetSignal,
  ): void;
  /** Replaces every `log.severity_number >=`/`<=` token with the bands' bounds (null drops that side); keeps the rest. */
  setSeverityRange(min: LogSeverityKey | null, max: LogSeverityKey | null): void;
  selectTrace(id: TraceId | null): void;
  selectSpan(id: SpanId | null): void;
  selectLog(ref: LogRef | null): void;
  /** The log panel's Trace tab opens a span: closes the log, opens the trace and span, resets the log tab, as one history entry. */
  openSpanFromLog(traceId: TraceId, spanId: SpanId): void;
  clear(key: ClearKey): void;
}

export type SelectionData = Omit<
  Selection,
  | 'setWindow'
  | 'setCondition'
  | 'setText'
  | 'setMode'
  | 'setGroupBy'
  | 'setView'
  | 'setSort'
  | 'setTab'
  | 'setMetrics'
  | 'setDashboard'
  | 'toggleFacet'
  | 'setSeverityRange'
  | 'selectTrace'
  | 'selectSpan'
  | 'selectLog'
  | 'openSpanFromLog'
  | 'clear'
>;

function dataFromUrl(u: UrlState): SelectionData {
  return {
    window: u.t === undefined ? null : parseWindow(u.t),
    condition: u.q ?? null,
    text: u.text ?? '',
    traceId: u.trace ?? null,
    spanId: u.span ?? null,
    logRef: u.log ?? null,
    mode: u.mode ?? null,
    groupBy: u.group ?? null,
    view: u.view ?? 'list',
    sort: u.sort ?? null,
    tabs: {
      trace: u.tab ?? DEFAULT_TRACE_TAB,
      span: u.stab ?? DEFAULT_SPAN_TAB,
      log: u.ltab ?? DEFAULT_LOG_TAB,
    },
    metrics: u.m ?? null,
    dashboard: u.d ?? null,
  };
}

/** Defaults are omitted so a pristine store serializes to the empty string. */
export function selectionToUrlState(s: SelectionData): UrlState {
  const u: UrlState = {};
  if (s.condition !== null) u.q = s.condition;
  if (s.text !== '') u.text = s.text;
  if (s.window !== null) u.t = formatWindow(s.window);
  if (s.mode !== null) u.mode = s.mode;
  if (s.groupBy !== null) u.group = s.groupBy;
  if (s.view !== 'list') u.view = s.view;
  if (s.traceId !== null) u.trace = s.traceId;
  if (s.spanId !== null) u.span = s.spanId;
  if (s.tabs.trace !== DEFAULT_TRACE_TAB && isTraceTabId(s.tabs.trace)) u.tab = s.tabs.trace;
  if (s.tabs.span !== DEFAULT_SPAN_TAB) u.stab = s.tabs.span;
  if (s.sort !== null) u.sort = s.sort;
  if (s.logRef !== null) u.log = s.logRef;
  if (s.tabs.log !== DEFAULT_LOG_TAB && isLogTabId(s.tabs.log)) u.ltab = s.tabs.log;
  if (s.metrics !== null) u.m = s.metrics;
  if (s.dashboard !== null && !isPristine(s.dashboard)) u.d = s.dashboard;
  return u;
}

function conditionTokens(condition: string | null, purpose: string): FilterToken[] {
  if (condition === null) return [];
  const parsed = ottlToTokens(condition);
  if (parsed === null) {
    throw new OtelHtmlError('invalid-ottl', {
      path: 'condition',
      expected: `a flat \`and\` of filter tokens to ${purpose}`,
      actual: JSON.stringify(condition),
    });
  }
  return parsed;
}

function severityRangeCondition(
  condition: string | null,
  min: LogSeverityKey | null,
  max: LogSeverityKey | null,
): string | null {
  const rest = conditionTokens(condition, 'set a severity range').filter(
    (t) => !(t.key === SEVERITY_PATH && (t.op === '>=' || t.op === '<=')),
  );
  return tokensToOttl([...rest, ...severityRangeTokens(min, max)]);
}

function toggleFacetCondition(
  condition: string | null,
  key: string,
  value: string,
  op: 'include' | 'exclude',
  scope: FacetScope,
  kind: FacetValueKind,
  signal: FacetSignal,
): string | null {
  const tokens = conditionTokens(condition, 'toggle a facet');
  // Built per operator, not flipped afterwards: some facets (a log's `trace.present`) map `!=` to a different path op.
  const target = facetToken(key, scope, value, op === 'include' ? '==' : '!=', kind, signal);
  const same = (t: FilterToken): boolean =>
    t.key === target.key &&
    t.value === target.value &&
    t.enum === target.enum &&
    (t.op === '==' || t.op === '!=');
  const existing = tokens.find(same);
  const rest = tokens.filter((t) => !same(t));
  if (existing?.op !== target.op) rest.push(target);
  return tokensToOttl(rest);
}

function assertNonEmpty(path: string, v: string): void {
  if (v === '') throw new OtelHtmlError('usage', { path, expected: 'a non-empty string', actual: '""' });
}

function assertOttl(c: string): void {
  try {
    parseCondition(c);
  } catch (cause) {
    throw new OtelHtmlError('invalid-ottl', {
      path: 'condition',
      expected: 'a valid OTTL condition',
      actual: JSON.stringify(c),
      ...(cause instanceof Error ? { hint: cause.message } : {}),
    });
  }
}

export function createSelectionStore(initial: UrlState): StoreApi<Selection> {
  return createStore<Selection>()((set, get) => ({
    ...dataFromUrl(initial),
    setWindow: (w) => {
      if (w !== null) formatWindow(w); // validates
      set({ window: w });
    },
    setCondition: (c) => {
      if (c !== null) assertOttl(c);
      set({ condition: c });
    },
    setText: (text) => set({ text }),
    setMode: (mode) => set({ mode }),
    setGroupBy: (groupBy) => {
      if (groupBy !== null) assertNonEmpty('groupBy', groupBy);
      set({ groupBy });
    },
    setView: (view) => set({ view }),
    setSort: (sort) => {
      if (sort !== null) assertNonEmpty('sort', sort);
      set({ sort });
    },
    setTab: (which, tab) => {
      assertNonEmpty(`tabs.${which}`, tab);
      if (which === 'trace' && !isTraceTabId(tab)) {
        throw new OtelHtmlError('usage', {
          path: 'tabs.trace',
          expected: `one of ${TRACE_TAB_IDS.join(', ')}`,
          actual: JSON.stringify(tab),
        });
      }
      if (which === 'log' && !isLogTabId(tab)) {
        throw new OtelHtmlError('usage', {
          path: 'tabs.log',
          expected: `one of ${LOG_TAB_IDS.join(', ')}`,
          actual: JSON.stringify(tab),
        });
      }
      set({ tabs: { ...get().tabs, [which]: tab } });
    },
    setMetrics: (metrics) => set({ metrics }),
    setDashboard: (dashboard) => set({ dashboard }),
    toggleFacet: (key, value, op, scope = 'core', kind = 'string', signal = 'span') =>
      set({ condition: toggleFacetCondition(get().condition, key, value, op, scope, kind, signal) }),
    setSeverityRange: (min, max) => set({ condition: severityRangeCondition(get().condition, min, max) }),
    selectTrace: (traceId) => set({ traceId, spanId: null }),
    selectSpan: (spanId) => set({ spanId }),
    selectLog: (logRef) => set({ logRef }),
    openSpanFromLog: (traceId, spanId) =>
      set({ logRef: null, traceId, spanId, tabs: { ...get().tabs, log: DEFAULT_LOG_TAB } }),
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
        case 'logRef':
          return set({ logRef: null });
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
 * Two-way binding. Trace/span/log opens push history entries; every other change replaces. Returns an unbind function.
 * Invalid URL params are passed to `onErrors` and rewritten out of the URL.
 */
export function bindUrl(
  store: StoreApi<Selection>,
  history: HistoryPort,
  onErrors: (errors: string[]) => void,
): () => void {
  const current = (): string => serializeUrlState(selectionToUrlState(store.getState()));
  let applying = false;
  let last = '';

  const applyUrl = (): void => {
    const { state, errors } = parseUrlState(history.read());
    applying = true;
    try {
      store.setState(dataFromUrl(state));
    } finally {
      applying = false;
    }
    last = current();
    if (errors.length > 0) {
      onErrors(errors);
      history.write(last, 'replace');
    }
  };
  applyUrl();

  const unsubscribeStore = store.subscribe((next, prev) => {
    if (applying) return;
    const search = serializeUrlState(selectionToUrlState(next));
    if (search === last) return;
    last = search;
    const opened =
      next.traceId !== prev.traceId || next.spanId !== prev.spanId || next.logRef !== prev.logRef;
    history.write(search, opened ? 'push' : 'replace');
  });
  const unsubscribeHistory = history.subscribe(applyUrl);
  return () => {
    unsubscribeStore();
    unsubscribeHistory();
  };
}
