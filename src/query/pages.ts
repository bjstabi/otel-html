import type { OttlContextName } from '../ottl/contexts.js';

/** Every grouping any explorer offers; which ones a page accepts is `PAGE_OPTIONS`. */
export const SELECTION_MODES = ['spans', 'traces', 'logs', 'patterns'] as const;

export const EXPLORER_VIEWS = [
  'list',
  'timeseries',
  'toplist',
  'bar',
  'table',
  'pointplot',
  'treemap',
  'pie',
  'scatter',
] as const;

type SelectionMode = (typeof SELECTION_MODES)[number];
type ExplorerView = (typeof EXPLORER_VIEWS)[number];

/** One page's options. Written out per page because `isolatedDeclarations` cannot infer the literal types. */
interface PageOption<
  C extends OttlContextName,
  M extends readonly SelectionMode[],
  V extends readonly ExplorerView[],
> {
  /** The OTTL context a `q` must compile in on this page. */
  readonly context: C;
  /** Groupings this page offers; the first is the default (stored as `mode: null`). */
  readonly modes: M;
  /** Views this page offers; the first is the default. */
  readonly views: V;
}

/** What each explorer accepts. Data, not code: the explorers read their controls from here. */
export const PAGE_OPTIONS: {
  readonly traces: PageOption<
    'span',
    readonly ['spans', 'traces'],
    readonly ['list', 'timeseries', 'toplist', 'bar', 'table', 'pointplot', 'treemap', 'pie']
  >;
  readonly logs: PageOption<
    'log_record',
    readonly ['logs', 'patterns', 'traces'],
    readonly ['list', 'timeseries', 'toplist', 'bar', 'table', 'treemap', 'pie', 'scatter']
  >;
  readonly metrics: PageOption<'datapoint', readonly [], readonly []>;
} = {
  traces: {
    context: 'span',
    modes: ['spans', 'traces'],
    views: ['list', 'timeseries', 'toplist', 'bar', 'table', 'pointplot', 'treemap', 'pie'],
  },
  logs: {
    context: 'log_record',
    modes: ['logs', 'patterns', 'traces'],
    views: ['list', 'timeseries', 'toplist', 'bar', 'table', 'treemap', 'pie', 'scatter'],
  },
  metrics: { context: 'datapoint', modes: [], views: [] },
};

export type ExplorerPage = keyof typeof PAGE_OPTIONS;
export type PageMode<P extends ExplorerPage> = (typeof PAGE_OPTIONS)[P]['modes'][number];
export type PageView<P extends ExplorerPage> = (typeof PAGE_OPTIONS)[P]['views'][number];
