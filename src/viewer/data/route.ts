import type { LogNeed, SpanNeed } from './results.js';

/**
 * What a statement needs, for the router: the spans and logs needs, the services table (a request of its own) and the
 * attribute facets, which no rollup can answer.
 */
export type RouteNeed = SpanNeed | LogNeed | 'services' | 'attributeFacets';

/** The request as the router sees it: its shape, never a widget, a dashboard or a key's name. */
export interface RequestShape {
  table: 'spans' | 'logs';
  need: RouteNeed;
  mode: 'spans' | 'traces' | 'logs';
  /** The window (or, with none, the report's range) is long (spec 6.3). */
  long: boolean;
  /** What the condition and the need read, in the statistics-key grammar of a rollup's dimensions. */
  reads: ReadonlySet<string>;
  /** The condition leaves terms the browser evaluates on rows. */
  residual: boolean;
  /** A text search is set. */
  text: boolean;
}

const MEASURED: Readonly<Record<RequestShape['table'], ReadonlySet<RouteNeed>>> = {
  spans: new Set<RouteNeed>(['total', 'timeline', 'buckets', 'groups', 'durations', 'services', 'facets']),
  logs: new Set<RouteNeed>(['total', 'timeline', 'facets']),
};

/**
 * `'measures'`: the need is built over `measuresRelation` (decision 14: whatever the condition, so a number on the page has
 * one computation under a long window). `'direct'`: today's statement. A request is `'measures'` exactly when its window
 * is long and the need is a total (not of distinct traces), a timeline, buckets, groups, durations, services or core
 * facets. Rows, attribute facets and a distinct-trace count stay direct.
 */
export function routeOf(shape: RequestShape): 'measures' | 'direct' {
  if (!shape.long || !MEASURED[shape.table].has(shape.need)) return 'direct';
  if (shape.need === 'total' && shape.mode === 'traces') return 'direct';
  return 'measures';
}

/**
 * A rollup cannot answer: a text search, a residual term, or a whole-map read (the literal `resource:*` or `attr:*`;
 * a named key such as `resource:run.id` is fine). Every file is then read raw, in the rollup's shape.
 */
export function rawOnly(shape: RequestShape): boolean {
  return shape.text || shape.residual || shape.reads.has('resource:*') || shape.reads.has('attr:*');
}
