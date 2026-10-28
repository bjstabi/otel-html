import { Menu } from '@base-ui/react/menu';
import { ChevronDown, Copy, LayoutDashboard, Pencil } from 'lucide-react';
import { type JSX, useCallback, useMemo, useState } from 'react';
import type { Widget, WidgetLayout, WidgetType } from '../../dashboards/schema.js';
import { parseUnixNanos, type TraceId } from '../../model/ids.js';
import type { DataSource, ResourceValues } from '../data/data-source.js';
import type { TimeWindow } from '../data/span-query.js';
import { LogPanel } from '../logs/log-panel.js';
import { useGoTo } from '../shell/go-to.js';
import { CONTROL, CopyButton, PageChrome, POPUP } from '../shell/page-chrome.js';
import { PageOptionNotice } from '../shell/page-option-notice.js';
import { absoluteTime } from '../shell/time-range.js';
import type { UrlPatch } from '../state/carry.js';
import { type DashboardPageState, EMPTY_DASHBOARD_STATE } from '../state/dashboard-state.js';
import type { Page } from '../state/page-options.js';
import { useSelection, useSelectionStore } from '../state/selection-context.js';
import { formatWindow, parseWindow } from '../state/url-state.js';
import { type KeyedState, useKeyedAsync } from '../state/use-keyed-async.js';
import { TracePanel } from '../traces/trace-panel.js';
import { dashboardToYaml } from './copy-config.js';
import { DashboardLink } from './dashboard-link.js';
import { DashboardGrid, useStacked } from './grid.js';
import { type DashboardEntry, dashboardsOf, findDashboard } from './registry.js';
import { bindings, following, scopeFor, type VariableBinding, type WidgetScope } from './scope.js';
import { SelectionChips } from './selection-chips.js';
import { VariablesBar } from './variables-bar.js';
import { WidgetFrame } from './widget-frame.js';
import { TimelineWidget } from './widgets/timeline.js';

/** What a widget can do to the page; each widget gets its own, bound to its id. */
export interface WidgetActions {
  selectWindow(w: TimeWindow | null): void;
  selectTrace(id: TraceId | null): void;
  openIn(page: Page, route: string, patch: UrlPatch): void;
  setLogView(v: 'matches' | 'context'): void;
}

export type WidgetRenderer = (props: {
  widget: Widget;
  scope: WidgetScope;
  dashboard: DashboardEntry;
  height: number;
  dataSource: DataSource;
  actions: WidgetActions;
  /** The variables bound on the page (empty when every variable is all or unset). */
  variables: readonly VariableBinding[];
}) => JSX.Element;

/** Stands in for a widget type whose component has not been written yet. */
const PendingWidget: WidgetRenderer = ({ widget }) => (
  <p className="p-2 text-sm text-muted">{widget.type} widget</p>
);

/** One renderer per widget type: the page draws every widget through this table. */
export const WIDGETS: Record<WidgetType, WidgetRenderer> = {
  timeline: TimelineWidget,
  traces: PendingWidget,
  logs: PendingWidget,
  metric: PendingWidget,
  toplist: PendingWidget,
  table: PendingWidget,
};

const CARD = 'max-w-xl rounded-card border border-hairline bg-surface p-6';

function layoutOf(widgets: readonly Widget[]): WidgetLayout[] {
  return widgets.map(({ x, y, w, h }) => ({ x, y, w, h }));
}

/** Ids in `d` that the dashboard does not have: per-widget overrides of a widget that is gone, variables it lacks. */
function staleIds(entry: DashboardEntry, state: DashboardPageState): string[] {
  const widgetIds = new Set(entry.dashboard.widgets.map((w) => w.id));
  const keys = new Set(entry.dashboard.variables.map((v) => v.key));
  return [
    ...Object.keys(state.follow)
      .filter((id) => !widgetIds.has(id))
      .map((id) => `follow.${id}`),
    ...Object.keys(state.logView)
      .filter((id) => !widgetIds.has(id))
      .map((id) => `logView.${id}`),
    ...Object.keys(state.vars)
      .filter((k) => !keys.has(k))
      .map((k) => `vars.${k}`),
  ];
}

function windowText(w: TimeWindow | null, epoch: ReturnType<typeof parseUnixNanos>): string {
  return w === null ? 'entire run' : `${absoluteTime(w.start, epoch)} – ${absoluteTime(w.end, epoch)}`;
}

/** The widget's "Open in …" target: the explorer for its signal, with its effective filter and window. */
function openInOf(
  widget: Widget,
  scope: WidgetScope,
): { page: 'traces' | 'logs'; label: string; patch: UrlPatch } | null {
  switch (widget.type) {
    case 'timeline':
    case 'metric':
      return null;
    case 'traces':
    case 'logs':
    case 'toplist':
    case 'table': {
      const logs =
        widget.type === 'logs' ||
        ((widget.type === 'toplist' || widget.type === 'table') && widget.signal === 'logs');
      return {
        page: logs ? 'logs' : 'traces',
        label: logs ? 'Open in Logs' : 'Open in Traces',
        patch: {
          q: scope.condition,
          t: scope.window === null ? null : formatWindow(scope.window),
          text: widget.text === '' ? null : widget.text,
        },
      };
    }
  }
}

function DashboardSwitcher(props: { entries: readonly DashboardEntry[] }): JSX.Element {
  const goTo = useGoTo();
  return (
    <Menu.Root>
      <Menu.Trigger className={CONTROL}>
        <LayoutDashboard size={16} aria-hidden />
        Dashboards
        <ChevronDown size={14} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="start">
          <Menu.Popup className={POPUP}>
            <Menu.Item
              onClick={() => goTo('dashboards', '/dashboards', { d: null })}
              className="rounded-md px-3 py-1.5 text-sm hover:bg-hairline"
            >
              All dashboards
            </Menu.Item>
            {props.entries.map((e) => (
              <Menu.Item
                key={e.dashboard.id}
                onClick={() => goTo('dashboards', `/dashboards/${e.dashboard.id}`, { d: null })}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-hairline"
              >
                {e.isDefault ? '★ ' : ''}
                {e.dashboard.title}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function NotFound(props: { id: string; manifest: DataSource['manifest'] }): JSX.Element {
  return (
    <PageChrome title="Dashboards" manifest={props.manifest}>
      <section className={CARD}>
        <h2 className="text-base font-semibold">Dashboard not found</h2>
        <p className="mt-1 text-sm text-ink-2">
          This report has no dashboard <code className="font-mono">{props.id}</code>.
        </p>
        <DashboardLink to="/dashboards" className="mt-3 inline-block text-sm text-accent hover:underline">
          All dashboards
        </DashboardLink>
      </section>
    </PageChrome>
  );
}

type ValuesByKey = Readonly<Record<string, ResourceValues>>;

function DashboardView(props: {
  entry: DashboardEntry;
  dataSource: DataSource;
  /** The grid positions as edited on this page; the config's when absent. Never persisted. */
  layout: WidgetLayout[] | undefined;
  onLayout(layout: WidgetLayout[] | undefined): void;
}): JSX.Element {
  const { entry, dataSource } = props;
  const d = entry.dashboard;
  const manifest = dataSource.manifest;
  const entries = useMemo(() => dashboardsOf(manifest), [manifest]);
  const store = useSelectionStore();
  const goTo = useGoTo();
  const stored = useSelection((s) => s.dashboard);
  const state = stored ?? EMPTY_DASHBOARD_STATE;
  const page = useSelection((s) => s.window);
  const traceId = useSelection((s) => s.traceId);
  const logRef = useSelection((s) => s.logRef);
  const clear = useSelection((s) => s.clear);
  const [editing, setEditing] = useState(false);
  const stacked = useStacked();
  const epoch = parseUnixNanos(manifest.epochUnixNano, 'manifest.epochUnixNano');
  const layout = props.layout ?? layoutOf(d.widgets);

  /** Applies `fn` to the state as it is now, so two quick changes never overwrite each other. */
  const change = useCallback(
    (fn: (s: DashboardPageState) => DashboardPageState): void => {
      const s = store.getState();
      s.setDashboard(fn(s.dashboard ?? EMPTY_DASHBOARD_STATE));
    },
    [store],
  );

  const loadValues = useCallback(
    async (dash: typeof d): Promise<ValuesByKey> =>
      Object.fromEntries(
        await Promise.all(
          dash.variables.map(async (v) => [v.key, await dataSource.resourceValues(v.key)] as const),
        ),
      ),
    [dataSource],
  );
  const values: KeyedState<ValuesByKey> = useKeyedAsync(d, loadValues);

  const stale = staleIds(entry, state);
  const bound = values.status === 'ready' ? bindings(d, state, values.value) : null;
  const sel = { t: state.sel.t === null ? null : parseWindow(state.sel.t), trace: state.sel.trace };
  const scopes = new Map<string, { scope: WidgetScope; following: boolean }>();
  if (bound !== null) {
    for (const w of d.widgets) {
      const follows = following(w, state);
      scopes.set(w.id, {
        scope: scopeFor(w, { page, sel, following: follows, vars: bound.bindings }),
        following: follows,
      });
    }
  }
  const outside = [...scopes.values()].some((s) => s.scope.outside);

  const renderWidget = (w: Widget, heightPx: number): JSX.Element => {
    const known = scopes.get(w.id);
    if (known === undefined) return <div />;
    const { scope } = known;
    const open = openInOf(w, scope);
    const actions: WidgetActions = {
      selectWindow: (win) =>
        change((s) => ({ ...s, sel: { ...s.sel, t: win === null ? null : formatWindow(win) } })),
      selectTrace: (id) => change((s) => ({ ...s, sel: { ...s.sel, trace: id } })),
      openIn: (target, route, patch) => goTo(target, route, patch),
      setLogView: (v) => change((s) => ({ ...s, logView: { ...s.logView, [w.id]: v } })),
    };
    const Body = WIDGETS[w.type];
    return (
      <WidgetFrame
        widget={w}
        resetKey={JSON.stringify([w, scope])}
        subtitle={windowText(scope.window, epoch)}
        following={w.type === 'timeline' ? null : known.following}
        onFollow={(v) => change((s) => ({ ...s, follow: { ...s.follow, [w.id]: v } }))}
        openIn={
          open === null
            ? null
            : { label: open.label, onOpen: () => goTo(open.page, `/${open.page}`, open.patch) }
        }
        editing={editing}
      >
        <Body
          widget={w}
          scope={scope}
          dashboard={entry}
          height={heightPx}
          dataSource={dataSource}
          actions={actions}
          variables={bound?.bindings ?? []}
        />
      </WidgetFrame>
    );
  };

  const actions = (
    <>
      <DashboardSwitcher entries={entries} />
      {editing ? (
        <>
          <button type="button" className={CONTROL} onClick={() => props.onLayout(undefined)}>
            Reset layout
          </button>
          <button type="button" className={CONTROL} onClick={() => setEditing(false)}>
            Done
          </button>
        </>
      ) : (
        <button
          type="button"
          className={`${CONTROL} disabled:opacity-50`}
          disabled={stacked}
          title={stacked ? 'Layout editing needs a wider window' : undefined}
          onClick={() => setEditing(true)}
        >
          <Pencil size={16} aria-hidden />
          Edit layout
        </button>
      )}
      <CopyButton
        label="Copy config"
        icon={<Copy size={16} aria-hidden />}
        text={() => dashboardToYaml(d, layout)}
        dialog={{ title: 'Copy config', label: 'Dashboard config' }}
      />
    </>
  );

  return (
    <PageChrome title={d.title} manifest={manifest} actions={actions}>
      <div className="flex flex-col gap-3">
        <PageOptionNotice
          message={
            stale.length === 0
              ? null
              : `This link refers to widgets or variables this dashboard does not have: ${stale.join(', ')}`
          }
          onReset={() => change(() => EMPTY_DASHBOARD_STATE)}
        />
        {values.status === 'error' && (
          <p role="alert" className="font-mono text-xs text-critical">
            Could not read the variables' values: {values.message}
          </p>
        )}
        {values.status === 'loading' && (
          <p role="status" className="text-sm text-muted">
            Loading variables…
          </p>
        )}
        {bound !== null && values.status === 'ready' && (
          <VariablesBar
            variables={d.variables}
            values={values.value}
            bound={bound}
            state={state}
            onChange={(vars) => change((s) => ({ ...s, vars }))}
          />
        )}
        <SelectionChips
          state={state}
          epoch={epoch}
          outside={outside}
          onChange={(next) => change(() => next)}
        />
        {bound !== null && (
          <DashboardGrid
            widgets={d.widgets}
            layout={layout}
            editing={editing}
            onLayout={props.onLayout}
            render={renderWidget}
          />
        )}
      </div>
      {logRef !== null && (
        <LogPanel dataSource={dataSource} logRef={logRef} onClose={() => clear('logRef')} />
      )}
      {traceId !== null && (
        <TracePanel
          dataSource={dataSource}
          traceId={traceId}
          layout="overlay"
          onClose={() => clear('traceId')}
        />
      )}
    </PageChrome>
  );
}

/** `#/dashboards/<id>`: the dashboard, or a not-found card that links to the list. */
export function DashboardPage(props: { dataSource: DataSource; id: string }): JSX.Element {
  const { dataSource, id } = props;
  const entry = findDashboard(dashboardsOf(dataSource.manifest), id);
  // Edited positions live here, keyed by dashboard, so switching away and back keeps them; a reload drops them.
  const [layouts, setLayouts] = useState<Readonly<Record<string, WidgetLayout[]>>>({});
  if (entry === null) return <NotFound id={id} manifest={dataSource.manifest} />;
  return (
    <DashboardView
      key={id}
      entry={entry}
      dataSource={dataSource}
      layout={layouts[id]}
      onLayout={(layout) =>
        setLayouts((all) => {
          const { [id]: _old, ...rest } = all;
          return layout === undefined ? rest : { ...rest, [id]: layout };
        })
      }
    />
  );
}
