import type { ManifestV4 } from '../../src/format/manifest.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';

export type ConditionKind = 'none' | 'sortkey' | 'statkey' | 'attr' | 'text';

/** What the scaling model needs to know of one request the viewer made; nothing of the page that made it. */
export interface RecordedCall {
  method: keyof DataSource;
  needs: readonly string[];
  window: 'none' | 'window';
  condition: ConditionKind;
  /** `querySpans`' and `queryLogs`' mode (a trace list is a rows request in `traces` mode); null elsewhere. */
  mode: 'spans' | 'traces' | 'logs' | 'patterns' | null;
  /** Facets over every attribute (no key list) rather than the core keys. */
  attrFacets: boolean;
  /** The condition holds a function the SQL cannot run (an id table follows); only meaningful beside `condition`. */
  residual: boolean;
  /** `metricRunQuery` with a failure condition (an id table of the failed runs follows). */
  failedWhen: boolean;
  /** The id a by-id call asked for (`getTrace`, `serviceShare`, `hasTrace`, `traceLogs`, `getLog`, `surroundingLogs`), else null. */
  idKey: string | null;
  /** `metricQuery` of a summary metric (its quantiles are read); by the entry's type, not its name. */
  summary: boolean;
}

export interface Recording {
  ds: DataSource;
  calls: RecordedCall[];
  /**
   * Resolves once every method of `required` has been asked, every call returned and none started for a quiet period.
   * Rejects naming the methods still missing after `waitMs`.
   */
  settled(required?: readonly string[], waitMs?: number): Promise<void>;
}

/** The parts of a query the recording reads; the argument of a method is any of the query types, or an id. */
interface Asked {
  condition?: unknown;
  text?: unknown;
  needs?: unknown;
  window?: unknown;
  mode?: unknown;
  facetKeys?: unknown;
  entry?: unknown;
  query?: unknown;
  failedWhen?: unknown;
}

/** Milliseconds without a new call before the page counts as settled. */
const QUIET_MS = 150;
/** How long a page may take to ask the methods it must ask: a loaded CPU renders a page's rows slowly. */
const REQUIRED_WAIT_MS = 30_000;

const CALL = /[A-Za-z_]\w*\s*\(/;
const RESOURCE_ATTR = /resource\.attributes\["([^"]+)"\]/g;
const OTHER_ATTR = /(?<![.\w])(?:attributes)\["[^"]+"\]/;
const SORT_TERM = /instrumentation_scope\.name|resource\.attributes\["service\.name"\]/;

/**
 * The kind of condition by what the writer can prune with: a term on a statistics key of the manifest (`resource:<key>`)
 * is a statkey, one on the sort columns (service, scope) a sortkey, any other attribute an attr; a text search is its own
 * kind. Mixed conditions take the dearest kind: attr, then statkey, then sortkey.
 */
export function conditionKindOf(
  condition: string | null,
  text: string,
  statisticsKeys: ReadonlySet<string>,
): ConditionKind {
  if (text !== '') return 'text';
  if (condition === null || condition.trim() === '') return 'none';
  if (OTHER_ATTR.test(condition)) return 'attr';
  const keys = [...condition.matchAll(RESOURCE_ATTR)].map((m) => m[1] ?? '');
  const others = keys.filter((k) => k !== 'service.name');
  if (others.some((k) => !statisticsKeys.has(`resource:${k}`))) return 'attr';
  if (others.length > 0) return 'statkey';
  return SORT_TERM.test(condition) ? 'sortkey' : 'none';
}

const NO_NEEDS: readonly string[] = [];

const BY_ID = new Set<keyof DataSource>([
  'getTrace',
  'serviceShare',
  'hasTrace',
  'traceLogs',
  'getLog',
  'surroundingLogs',
]);

/**
 * Wraps `inner` so each request is recorded as it starts, by method, needs, window and the kind of its condition.
 * `manifest` is what the wrapper reports as the source's manifest (the page reads its config from it).
 */
export function recordingDataSource(inner: DataSource, manifest: ManifestV4): Recording {
  const calls: RecordedCall[] = [];
  const statisticsKeys = new Set([...manifest.statisticsKeys.spans, ...manifest.statisticsKeys.logs]);
  let inflight = 0;
  let waiters: (() => void)[] = [];
  const idle = (): void => {
    if (inflight > 0) return;
    const ready = waiters;
    waiters = [];
    for (const w of ready) w();
  };

  const describe = (method: keyof DataSource, arg: unknown): RecordedCall => {
    const q: Asked = typeof arg === 'object' && arg !== null ? (arg as Asked) : {};
    const condition = typeof q.condition === 'string' ? q.condition : null;
    const text = typeof q.text === 'string' ? q.text : '';
    const needs = Array.isArray(q.needs) ? q.needs.map(String) : NO_NEEDS;
    const mode =
      q.mode === 'spans' || q.mode === 'traces' || q.mode === 'logs' || q.mode === 'patterns' ? q.mode : null;
    const where =
      typeof q.query === 'object' &&
      q.query !== null &&
      'where' in q.query &&
      typeof q.query.where === 'string'
        ? q.query.where
        : null;
    const type = typeof q.entry === 'object' && q.entry !== null && 'type' in q.entry ? q.entry.type : null;
    return {
      method,
      needs,
      window: q.window === null || q.window === undefined ? 'none' : 'window',
      condition: conditionKindOf(condition, text, statisticsKeys),
      mode,
      attrFacets: Array.isArray(q.needs) && q.needs.includes('facets') && q.facetKeys === null,
      residual: (condition !== null && CALL.test(condition)) || (where !== null && CALL.test(where)),
      failedWhen: typeof q.failedWhen === 'string',
      idKey: BY_ID.has(method) && typeof arg === 'string' ? arg : null,
      summary: type === 'summary',
    };
  };

  const ds = new Proxy(inner, {
    get(target, prop, receiver): unknown {
      if (prop === 'manifest') return manifest;
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string' || prop === 'close') return value;
      return (...args: unknown[]): unknown => {
        calls.push(describe(prop as keyof DataSource, prop === 'resourceValues' ? args[1] : args[0]));
        inflight++;
        const settle = (): void => {
          inflight--;
          idle();
        };
        let result: unknown;
        try {
          result = value.apply(target, args);
        } catch (e) {
          settle();
          throw e;
        }
        if (result instanceof Promise) return result.finally(settle);
        settle();
        return result;
      };
    },
  });

  return {
    ds,
    calls,
    settled: async (required: readonly string[] = [], waitMs = REQUIRED_WAIT_MS): Promise<void> => {
      // a page asks some methods only once an earlier result has rendered, which on a loaded CPU (a Windows runner) takes
      // longer than QUIET_MS: the quiet period below starts only once every required method has been asked
      const since = performance.now();
      for (;;) {
        const missing = required.filter((m) => !calls.some((c) => c.method === m));
        if (missing.length === 0) break;
        if (performance.now() - since > waitMs)
          throw new OtelHtmlError('usage', {
            message: `the page did not ask ${missing.join(', ')} within ${waitMs / 1000} s`,
          });
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      // a widget behind a debounce or a lazy import starts its request late: no call in flight and none started for QUIET_MS
      for (let started = -1; started !== calls.length || inflight > 0; ) {
        started = calls.length;
        if (inflight > 0) await new Promise<void>((resolve) => waiters.push(resolve));
        await new Promise<void>((resolve) => setTimeout(resolve, QUIET_MS));
      }
    },
  };
}

const SPAN_NEEDS = new Set(['rows', 'facets', 'timeline', 'buckets', 'total', 'durations', 'groups']);
const LOG_NEEDS = new Set(['rows', 'facets', 'timeline']);

/**
 * The catalogue ids of a call, one per need. `long`: whether the window of the shape being predicted (the report's whole
 * range for a call without one) is long. A condition leaves a call on its unconditioned entry, except where the catalogue
 * has an entry for it: a `total`, a trace list and a log timeline. A `total` asked beside `rows` is the rows statement's own
 * count, so it adds no entry.
 */
export function entryIdsOf(call: RecordedCall, long: boolean): string[] {
  const s = long ? 'long' : 'short';
  const c = call.condition;
  switch (call.method) {
    case 'querySpans':
      return call.needs
        .filter((n) => !(n === 'total' && call.needs.includes('rows')))
        .map((n) => spanId(call, n, s));
    case 'queryLogs':
      return call.needs.map((n) => logId(call, n, s));
    case 'services':
      return [`spans.services.${s}`];
    case 'percentileOf':
      return [`percentile.${s}`];
    case 'getTrace':
      return ['trace.get'];
    case 'serviceShare':
      return ['trace.share'];
    case 'hasTrace':
      return ['trace.has'];
    case 'traceLogs':
      return ['trace.logs'];
    case 'getLog':
      return ['log.get'];
    case 'surroundingLogs':
      return ['log.surrounding'];
    case 'patterns':
      return ['patterns'];
    case 'resourceValues':
      return [call.window === 'none' ? 'resourceValues.all' : `resourceValues.${s}`];
    case 'metricCatalog':
      return ['metrics.catalog'];
    case 'metricShowOptions':
      return ['metrics.showOptions'];
    case 'metricQuery':
      if (call.summary) return ['metrics.query.summary'];
      return [call.residual ? 'metrics.query.residual.long' : `metrics.query.${s}`];
    case 'metricRunQuery':
      return [call.failedWhen ? 'metrics.runQuery.failed' : 'metrics.runQuery'];
    case 'metricsForResources':
      return ['metrics.forResources'];
    case 'metricPoints':
      return ['metrics.points'];
    default:
      throw new OtelHtmlError('usage', { message: `no catalogue entry for the call ${call.method} (${c})` });
  }
}

function spanId(call: RecordedCall, need: string, s: 'short' | 'long'): string {
  if (!SPAN_NEEDS.has(need)) throw new OtelHtmlError('usage', { message: `unknown span need ${need}` });
  const c = call.condition;
  const windowed = call.window === 'window';
  switch (need) {
    case 'total':
      if (call.mode === 'traces') return 'spans.total.traces.long';
      if (call.residual) return `spans.total.residual.${s}`;
      return c === 'none' ? `spans.total.${s}` : `spans.total.${c}.${s}`;
    case 'rows':
      if (call.mode === 'traces') {
        if (!windowed) return s === 'long' ? 'traces.list.all.long' : 'traces.list.all';
        if (c === 'statkey' || c === 'attr') return `traces.list.${c}.long`;
        return `traces.list.${s}`;
      }
      return windowed ? `spans.rows.${s}` : 'spans.rows.all';
    case 'facets':
      return `spans.facets.${call.attrFacets ? 'attr' : 'core'}.${s}`;
    default:
      return `spans.${need}.${s}`;
  }
}

function logId(call: RecordedCall, need: string, s: 'short' | 'long'): string {
  if (!LOG_NEEDS.has(need)) throw new OtelHtmlError('usage', { message: `unknown log need ${need}` });
  const c = call.condition;
  switch (need) {
    case 'timeline':
      if (c === 'statkey') return `logs.timeline.statkey.${s}`;
      if (c === 'text') return 'logs.timeline.text.long';
      return `logs.timeline.${s}`;
    case 'rows':
      return call.mode === 'traces' ? `logs.traces.${s}` : `logs.rows.${s}`;
    default:
      return `logs.facets.${call.attrFacets ? 'attr' : 'core'}.${s}`;
  }
}
