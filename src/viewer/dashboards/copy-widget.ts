import type { WidgetInput, WidgetType } from '../../dashboards/schema.js';
import type { ExplorerPage } from '../../query/pages.js';
import { DEFAULT_GROUP_KEY } from '../components/facet-views.js';
import type { ExportItem } from '../shell/page-chrome.js';
import { resolvePageMode, resolvePageView } from '../state/page-options.js';
import type { SelectionData } from '../state/selection.js';
import { WIDGET_DEFAULT_SIZE, widgetToYaml } from './copy-config.js';

/** One explorer view that has a widget. `mode: null` means any mode of the page. */
interface CopyableView {
  page: Exclude<ExplorerPage, 'metrics'>;
  mode: string | null;
  view: string;
  type: Exclude<WidgetType, 'timeline' | 'metric'>;
}

/** Which (page, mode, view) becomes which widget type; anything not listed cannot. */
export const COPYABLE_VIEWS: readonly CopyableView[] = [
  { page: 'traces', mode: 'traces', view: 'list', type: 'traces' },
  { page: 'traces', mode: 'spans', view: 'list', type: 'traces' },
  { page: 'traces', mode: null, view: 'toplist', type: 'toplist' },
  { page: 'traces', mode: null, view: 'table', type: 'table' },
  { page: 'logs', mode: 'logs', view: 'list', type: 'logs' },
  { page: 'logs', mode: null, view: 'toplist', type: 'toplist' },
  { page: 'logs', mode: null, view: 'table', type: 'table' },
];

export type WidgetFromPage = { ok: true; widget: WidgetInput } | { ok: false; reason: string };

const NOT_VIEW = 'Only the List, Top list and Table views can become widgets';
const NO_PATTERNS = "Patterns can't become a widget yet";
const NO_DISTRIBUTION = "The Distribution display can't become a widget";
const NO_METRIC = 'Choose a metric first';
const NO_SHOW = 'Choose what to show first';
const NO_SPLIT = "A split chart can't become a widget yet";
const NO_LOG_TRACES = "Logs grouped into traces can't become a widget yet";

const no = (reason: string): WidgetFromPage => ({ ok: false, reason });

/** Only what differs from the schema's defaults, so the copied YAML stays short. */
function filterFields(s: SelectionData): { query?: string; text?: string } {
  return {
    ...(s.condition === null ? {} : { query: s.condition }),
    ...(s.text === '' ? {} : { text: s.text }),
  };
}

/** The current explorer view as one dashboard widget at `x: 0, y: 0` with its type's default size. */
export function widgetFromPage(page: ExplorerPage, s: SelectionData): WidgetFromPage {
  if (page === 'metrics') {
    const m = s.metrics;
    if (m === null) return no(NO_METRIC);
    const { display } = m;
    if (display === 'distribution') return no(NO_DISTRIBUTION);
    if (m.queries.length === 0 || m.queries.some((q) => q.metric === '')) return no(NO_METRIC);
    if (m.queries.some((q) => q.show === '')) return no(NO_SHOW);
    if (m.split) return no(NO_SPLIT);
    return {
      ok: true,
      widget: {
        type: 'metric',
        x: 0,
        y: 0,
        ...WIDGET_DEFAULT_SIZE.metric,
        queries: m.queries,
        ...(m.formulas.length === 0 ? {} : { formulas: m.formulas }),
        ...(display === 'lines' ? {} : { display }),
        ...(m.scale === 'linear' ? {} : { scale: m.scale }),
        ...(m.exemplars ? {} : { exemplars: false }),
      },
    };
  }
  const { mode } = resolvePageMode(page, s.mode);
  const { view } = resolvePageView(page, s.view);
  if (mode === 'patterns') return no(NO_PATTERNS);
  const hit = COPYABLE_VIEWS.find(
    (c) => c.page === page && c.view === view && (c.mode === null || c.mode === mode),
  );
  if (hit === undefined)
    return no(page === 'logs' && mode === 'traces' && view === 'list' ? NO_LOG_TRACES : NOT_VIEW);
  const base = { x: 0, y: 0, ...WIDGET_DEFAULT_SIZE[hit.type], ...filterFields(s) };
  const signal = page === 'traces' ? 'spans' : 'logs';
  switch (hit.type) {
    case 'traces':
      return {
        ok: true,
        widget: { type: 'traces', ...base, ...(mode === 'spans' ? { mode: 'spans' } : {}) },
      };
    case 'logs':
      return { ok: true, widget: { type: 'logs', ...base } };
    case 'toplist':
      return {
        ok: true,
        widget: { type: 'toplist', signal, groupBy: s.groupBy ?? DEFAULT_GROUP_KEY, ...base },
      };
    case 'table':
      return {
        ok: true,
        widget: { type: 'table', signal, groupBy: s.groupBy ?? DEFAULT_GROUP_KEY, ...base },
      };
    default: {
      const never: never = hit.type;
      return never;
    }
  }
}

/** The Export menu item: copies the view's widget YAML through `copy` (disabled, with the reason, when it has none). */
export function copyWidgetItem(
  page: ExplorerPage,
  s: SelectionData,
  copy: (text: string) => Promise<boolean>,
): ExportItem {
  const r = widgetFromPage(page, s);
  const label = 'Copy as dashboard widget';
  return r.ok
    ? { label, onSelect: () => void copy(widgetToYaml(r.widget)) }
    : { label, onSelect: () => undefined, disabled: r.reason };
}
