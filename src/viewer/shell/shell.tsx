import { Tooltip } from '@base-ui/react/tooltip';
import { X } from 'lucide-react';
import { type JSX, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Redirect, Route, Router, Switch } from 'wouter';
import type { Manifest } from '../../format/manifest.js';
import { SELECTION_MODES } from '../../query/pages.js';
import { DashboardPage } from '../dashboards/dashboard-page.js';
import { DashboardsListPage } from '../dashboards/list-page.js';
import { defaultDashboardRoute } from '../dashboards/registry.js';
import type { DataSource } from '../data/data-source.js';
import { LogsExplorer } from '../logs/explorer.js';
import { MetricsCatalog } from '../metrics/catalog.js';
import { MetricsExplorer } from '../metrics/explorer.js';
import { applyPatch, carryTo, type DroppedParam } from '../state/carry.js';
import { PAGE_TITLES, type Page, pageOfRoute } from '../state/page-options.js';
import { bindUrl, createSelectionStore, type HistoryPort } from '../state/selection.js';
import { SelectionProvider } from '../state/selection-context.js';
import { parseUrlState, serializeUrlState } from '../state/url-state.js';
import { ColorsProvider } from '../theme/colors-context.js';
import { TracesExplorer } from '../traces/explorer.js';
import { ServicesPage } from '../traces/services-page.js';
import { leaveTracePage, TracePage } from '../traces/trace-page.js';
import { type GoTo, GoToContext } from './go-to.js';
import { MOVE_EVENT } from './move-event.js';
import { NotFoundPage } from './pages.js';
import { ShortcutHelp } from './shortcut-help.js';
import { createShortcutHandler, SHORTCUTS, type ShortcutActions } from './shortcuts.js';
import { Sidebar } from './sidebar.js';
import { currentRoute, navigateRoute, useRoute } from './use-route.js';

const TRACE_PAGE_HASH = '#/traces/trace/';

function UrlErrors(props: { errors: readonly string[]; onDismiss: () => void }): JSX.Element | null {
  if (props.errors.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-hairline bg-surface px-4 py-2 text-sm"
    >
      <div className="flex-1">
        <p className="font-semibold text-critical">Some link parameters were invalid and have been removed</p>
        <ul className="mt-1 list-disc pl-5 font-mono text-xs text-ink-2">
          {[...new Set(props.errors)].map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={props.onDismiss}
        className="rounded-full p-1 hover:bg-hairline"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

interface Carried {
  to: Page;
  dropped: readonly DroppedParam[];
}

function CarryNotice(props: { carried: Carried | null; onDismiss: () => void }): JSX.Element | null {
  const { carried } = props;
  if (carried === null || carried.dropped.length === 0) return null;
  return (
    <div
      role="status"
      aria-label="Filter not carried over"
      className="flex items-start gap-3 border-b border-hairline bg-surface px-4 py-2 text-sm"
    >
      <div className="flex-1">
        {carried.dropped.map((d) => (
          <p key={d.key} title={d.reason}>
            The filter <code className="font-mono text-xs">{d.value}</code> does not apply to{' '}
            {PAGE_TITLES[carried.to]} and was not carried over.
          </p>
        ))}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={props.onDismiss}
        className="rounded-full p-1 hover:bg-hairline"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

/**
 * `/logs/patterns` is the Logs explorer in patterns mode: replace it with `/logs?<query>&mode=patterns`. The raw query
 * is rewritten (not parsed), so invalid params still reach `bindUrl` and are reported: a layout effect, like `bindUrl`'s,
 * and a child's, so it runs first.
 */
function PatternsRedirect(): null {
  useLayoutEffect(() => {
    const hash = window.location.hash;
    const qi = hash.indexOf('?');
    const params = new URLSearchParams(qi >= 0 ? hash.slice(qi + 1) : '');
    // An invalid `mode` stays so `bindUrl` reports it; only a missing or valid one becomes `patterns`.
    const given = params.get('mode');
    if (given === null || SELECTION_MODES.some((m) => m === given)) params.set('mode', 'patterns');
    navigateRoute(window, '/logs', params.toString().replace(/%7E/g, '~'), true);
  }, []);
  return null;
}

export function Shell(props: { dataSource: DataSource; history: HistoryPort }): JSX.Element {
  const { dataSource, history } = props;
  const manifest = dataSource.manifest;
  const store = useMemo(() => createSelectionStore(parseUrlState(history.read()).state), [history]);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [carried, setCarried] = useState<Carried | null>(null);

  // Layout effects, here and for the shortcuts below, run before the page first paints. A passive effect can run after
  // it on a slow machine: bindUrl's first read of the URL then undid a choice made in between (a View picked), and keys
  // pressed in between were lost.
  useLayoutEffect(() => bindUrl(store, history, setErrors), [store, history]);

  const goTo = useCallback<GoTo>(
    (page, route, extra = {}, alsoDropped = []) => {
      const { url, dropped } = carryTo(store.getState(), pageOfRoute(currentRoute(window)), page);
      navigateRoute(window, route, serializeUrlState(applyPatch(url, extra)));
      // A patch that sets `q` (or clears it) replaces the carried filter, so nothing was dropped from the user's view.
      const lost = [...(extra.q === undefined ? dropped : []), ...alsoDropped];
      setCarried(lost.length === 0 ? null : { to: page, dropped: lost });
    },
    [store],
  );

  // The notice belongs to the page it was raised for: leaving that page (Back after `g l`) clears it.
  useEffect(() => {
    const onHash = (): void => {
      const page = pageOfRoute(currentRoute(window));
      setCarried((c) => (c !== null && c.to !== page ? null : c));
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    };
  }, []);

  useLayoutEffect(() => {
    const move = (delta: -1 | 1) => (): void => {
      window.dispatchEvent(new CustomEvent(MOVE_EVENT, { detail: delta }));
    };
    const actions: ShortcutActions = {
      goDashboards: () => goTo('dashboards', defaultDashboardRoute(manifest), { d: null }),
      goLogs: () => goTo('logs', '/logs'),
      goMetrics: () => goTo('metrics', '/metrics'),
      goTraces: () => goTo('traces', '/traces'),
      next: move(1),
      previous: move(-1),
      clear: () => {
        setHelpOpen(false);
        if (window.location.hash.startsWith(TRACE_PAGE_HASH)) leaveTracePage(window, store.getState());
        // A trace opened from a log panel sits on top of it, so the trace closes first; a lone log closes next.
        else if (store.getState().traceId !== null) store.getState().clear('traceId');
        else store.getState().clear('logRef');
      },
      focusQuery: () => {
        const q = document.querySelector('[data-oh-query]');
        if (q instanceof HTMLElement) q.focus();
      },
      help: () => setHelpOpen(true),
    };
    const handler = createShortcutHandler(SHORTCUTS, actions);
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [store, goTo, manifest]);

  return (
    <SelectionProvider store={store}>
      <GoToContext.Provider value={goTo}>
        <ColorsProvider>
          <Tooltip.Provider>
            <Router hook={useRoute}>
              <div className="flex min-h-screen bg-page text-ink">
                <Sidebar manifest={manifest} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <UrlErrors errors={errors} onDismiss={() => setErrors([])} />
                  <CarryNotice carried={carried} onDismiss={() => setCarried(null)} />
                  <RoutedPage dataSource={dataSource} />
                </div>
              </div>
              <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
            </Router>
          </Tooltip.Provider>
        </ColorsProvider>
      </GoToContext.Provider>
    </SelectionProvider>
  );
}

/** Where `#/` lands: the configured home page; `dashboards` opens the default dashboard. */
function homeRoute(manifest: Manifest): string {
  const { home } = manifest.config.viewer;
  return home === 'dashboards' ? defaultDashboardRoute(manifest) : `/${home}`;
}

function RoutedPage({ dataSource }: { dataSource: DataSource }): JSX.Element {
  const manifest = dataSource.manifest;
  const [route] = useRoute();
  return (
    <Switch>
      <Route path="/">
        <Redirect to={homeRoute(manifest)} replace />
      </Route>
      <Route path="/traces">
        <TracesExplorer dataSource={dataSource} />
      </Route>
      <Route path="/traces/trace/:id">
        {(params) => <TracePage dataSource={dataSource} id={params.id} />}
      </Route>
      <Route path="/traces/services">
        <ServicesPage dataSource={dataSource} />
      </Route>
      <Route path="/logs/patterns">
        <PatternsRedirect />
      </Route>
      <Route path="/logs">
        <LogsExplorer dataSource={dataSource} />
      </Route>
      <Route path="/metrics/catalog">
        <MetricsCatalog dataSource={dataSource} />
      </Route>
      <Route path="/metrics">
        <MetricsExplorer dataSource={dataSource} />
      </Route>
      <Route path="/dashboards">
        <DashboardsListPage manifest={manifest} />
      </Route>
      <Route path="/dashboards/:id">
        {(params) => <DashboardPage dataSource={dataSource} id={params.id} />}
      </Route>
      <Route>
        <NotFoundPage route={route} />
      </Route>
    </Switch>
  );
}
