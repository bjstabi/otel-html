import { Tooltip } from '@base-ui/react/tooltip';
import { X } from 'lucide-react';
import { type JSX, useEffect, useMemo, useState } from 'react';
import { Redirect, Route, Router, Switch } from 'wouter';
import type { DataSource } from '../data/data-source.js';
import { bindUrl, createSelectionStore, type HistoryPort, selectionToUrlState } from '../state/selection.js';
import { SelectionProvider } from '../state/selection-context.js';
import { parseUrlState, serializeUrlState } from '../state/url-state.js';
import { ColorsProvider } from '../theme/colors-context.js';
import { TracesExplorer } from '../traces/explorer.js';
import { ServicesPage } from '../traces/services-page.js';
import { leaveTracePage, TracePage } from '../traces/trace-page.js';
import { MOVE_EVENT } from './move-event.js';
import { ComingLaterPage, NotFoundPage } from './pages.js';
import { ShortcutHelp } from './shortcut-help.js';
import { createShortcutHandler, SHORTCUTS, type ShortcutActions } from './shortcuts.js';
import { Sidebar } from './sidebar.js';
import { navigateRoute, useRoute } from './use-route.js';

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

export function Shell(props: { dataSource: DataSource; history: HistoryPort }): JSX.Element {
  const { dataSource, history } = props;
  const manifest = dataSource.manifest;
  const store = useMemo(() => createSelectionStore(parseUrlState(history.read()).state), [history]);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => bindUrl(store, history, setErrors), [store, history]);

  useEffect(() => {
    const move = (delta: -1 | 1) => (): void => {
      window.dispatchEvent(new CustomEvent(MOVE_EVENT, { detail: delta }));
    };
    const go = (route: string): void =>
      navigateRoute(window, route, serializeUrlState(selectionToUrlState(store.getState())));
    const actions: ShortcutActions = {
      goDashboards: () => go('/dashboards'),
      goLogs: () => go('/logs'),
      goMetrics: () => go('/metrics'),
      goTraces: () => go('/traces'),
      next: move(1),
      previous: move(-1),
      clear: () => {
        setHelpOpen(false);
        if (window.location.hash.startsWith(TRACE_PAGE_HASH)) leaveTracePage(window, store.getState());
        else store.getState().clear('traceId');
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
  }, [store]);

  return (
    <SelectionProvider store={store}>
      <ColorsProvider>
        <Tooltip.Provider>
          <Router hook={useRoute}>
            <div className="flex min-h-screen bg-page text-ink">
              <Sidebar manifest={manifest} />
              <div className="flex min-w-0 flex-1 flex-col">
                <UrlErrors errors={errors} onDismiss={() => setErrors([])} />
                <RoutedPage dataSource={dataSource} />
              </div>
            </div>
            <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
          </Router>
        </Tooltip.Provider>
      </ColorsProvider>
    </SelectionProvider>
  );
}

function RoutedPage({ dataSource }: { dataSource: DataSource }): JSX.Element {
  const manifest = dataSource.manifest;
  const [route] = useRoute();
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/traces" replace />
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
      <Route path="/logs">
        <ComingLaterPage page="logs" manifest={manifest} />
      </Route>
      <Route path="/metrics">
        <ComingLaterPage page="metrics" manifest={manifest} />
      </Route>
      <Route path="/dashboards">
        <ComingLaterPage page="dashboards" manifest={manifest} />
      </Route>
      <Route>
        <NotFoundPage route={route} />
      </Route>
    </Switch>
  );
}
