import { createContext, type JSX, type ReactNode, useContext, useState } from 'react';
import type { RunControls } from '../../dashboards/schema.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { RunChartView } from '../components/run-chart-card.js';

type ControlsByWidget = Readonly<Record<string, RunControls>>;

const NO_CONTROLS: ControlsByWidget = {};

/**
 * What a run chart's viewer changed, by dashboard and widget. It sits above the routes because a widget remounts
 * when the page is left, the grid crosses its stacking breakpoint or a reload shows the loading state, and all of
 * this lasts until the page reloads. Never in the URL.
 */
export interface RunSessionStore {
  subscribe(listener: () => void): () => void;
  /** Stable until a toggle of that dashboard changes. */
  controlsOf(dashboardId: string): ControlsByWidget;
  setControls(dashboardId: string, widgetId: string, controls: RunControls): void;
  viewOf(dashboardId: string, widgetId: string): RunChartView | undefined;
  setView(dashboardId: string, widgetId: string, view: RunChartView): void;
}

export function createRunSessionStore(): RunSessionStore {
  const controls = new Map<string, ControlsByWidget>();
  const views = new Map<string, RunChartView>();
  const listeners = new Set<() => void>();
  const viewKey = (dashboardId: string, widgetId: string): string => JSON.stringify([dashboardId, widgetId]);
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    controlsOf: (dashboardId) => controls.get(dashboardId) ?? NO_CONTROLS,
    setControls(dashboardId, widgetId, c) {
      controls.set(dashboardId, { ...controls.get(dashboardId), [widgetId]: c });
      for (const l of listeners) l();
    },
    viewOf: (dashboardId, widgetId) => views.get(viewKey(dashboardId, widgetId)),
    // Read when a card mounts, so a zoom being dragged re-renders nothing.
    setView(dashboardId, widgetId, view) {
      views.set(viewKey(dashboardId, widgetId), view);
    },
  };
}

const RunSessionContext = createContext<RunSessionStore | null>(null);

export function RunSessionProvider(props: { children: ReactNode }): JSX.Element {
  const [store] = useState(createRunSessionStore);
  return <RunSessionContext.Provider value={store}>{props.children}</RunSessionContext.Provider>;
}

export function useRunSession(): RunSessionStore {
  const store = useContext(RunSessionContext);
  if (store === null)
    throw new OtelHtmlError('usage', {
      path: 'useRunSession',
      expected: 'a <Shell> ancestor (RunSessionProvider)',
      actual: 'no provider',
    });
  return store;
}
