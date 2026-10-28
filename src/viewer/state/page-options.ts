import { invariant } from '../../model/errors.js';
import type { OttlContextName } from '../../ottl/contexts.js';
import type { ExplorerView } from './explorer-view.js';
import type { SelectionMode } from './selection.js';

/** Top-level pages, one per sidebar section. */
export type Page = 'traces' | 'logs' | 'metrics' | 'dashboards';

const PAGES: readonly Page[] = ['traces', 'logs', 'metrics', 'dashboards'];

/** `/logs` and every `/logs/...` route belong to the Logs page; `/` and unknown routes belong to none. */
export function pageOfRoute(route: string): Page | null {
  return PAGES.find((p) => route === `/${p}` || route.startsWith(`/${p}/`)) ?? null;
}

interface PageOption {
  /** The OTTL context a `q` must compile in on this page. */
  readonly context: OttlContextName;
  /** Groupings this page offers; the first is the default (stored as `mode: null`). */
  readonly modes: readonly SelectionMode[];
  /** Views this page offers; the first is the default. */
  readonly views: readonly ExplorerView[];
}

/** What each explorer accepts. Data, not code: the explorers read their controls from here. */
export const PAGE_OPTIONS = {
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
} as const satisfies Record<string, PageOption>;

export type ExplorerPage = keyof typeof PAGE_OPTIONS;
export type PageMode<P extends ExplorerPage> = (typeof PAGE_OPTIONS)[P]['modes'][number];
export type PageView<P extends ExplorerPage> = (typeof PAGE_OPTIONS)[P]['views'][number];

export const PAGE_TITLES: Record<Page, string> = {
  traces: 'Traces',
  logs: 'Logs',
  metrics: 'Metrics',
  dashboards: 'Dashboards',
};

/** `a, b or c` */
function choices(xs: readonly string[]): string {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
}

function resolve<T extends string>(
  key: 'mode' | 'view',
  noun: string,
  page: ExplorerPage,
  allowed: readonly T[],
  value: string | null,
): { value: T; invalid: string | null } {
  const [first] = allowed;
  invariant(first !== undefined, `${page} offers no ${key}s`);
  if (value === null) return { value: first, invalid: null };
  const hit = allowed.find((x) => x === value);
  if (hit !== undefined) return { value: hit, invalid: null };
  return {
    value: first,
    invalid: `${key}=${value} is not a ${PAGE_TITLES[page]} ${noun}: expected ${choices(allowed)}`,
  };
}

/** The page's mode for a stored selection mode; a mode the page does not offer falls back to the default and says so. */
export function resolvePageMode<P extends ExplorerPage>(
  page: P,
  mode: SelectionMode | null,
): { mode: PageMode<P>; invalid: string | null } {
  const modes: readonly PageMode<P>[] = PAGE_OPTIONS[page].modes;
  const r = resolve('mode', 'grouping', page, modes, mode);
  return { mode: r.value, invalid: r.invalid };
}

/** The page's view for a stored view; a view the page does not offer falls back to the default and says so. */
export function resolvePageView<P extends ExplorerPage>(
  page: P,
  view: ExplorerView | null,
): { view: PageView<P>; invalid: string | null } {
  const views: readonly PageView<P>[] = PAGE_OPTIONS[page].views;
  const r = resolve('view', 'view', page, views, view);
  return { view: r.value, invalid: r.invalid };
}
