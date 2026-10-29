import { invariant } from '../../model/errors.js';
import { type ExplorerPage, PAGE_OPTIONS, type PageMode, type PageView } from '../../query/pages.js';
import type { ExplorerView } from './explorer-view.js';
import type { SelectionMode } from './selection.js';

/** Top-level pages, one per sidebar section. */
export type Page = 'traces' | 'logs' | 'metrics' | 'dashboards';

const PAGES: readonly Page[] = ['traces', 'logs', 'metrics', 'dashboards'];

/** `/logs` and every `/logs/...` route belong to the Logs page; `/` and unknown routes belong to none. */
export function pageOfRoute(route: string): Page | null {
  return PAGES.find((p) => route === `/${p}` || route.startsWith(`/${p}/`)) ?? null;
}

export { type ExplorerPage, PAGE_OPTIONS, type PageMode, type PageView };

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
