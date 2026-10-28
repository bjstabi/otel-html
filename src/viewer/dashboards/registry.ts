import { FUSION } from '../../dashboards/fusion.js';
import type { Dashboard } from '../../dashboards/schema.js';
import type { Manifest } from '../../format/manifest.js';

export interface DashboardEntry {
  dashboard: Dashboard;
  /** The config file the dashboard came from, or `built-in`. */
  source: string;
  isDefault: boolean;
}

/** Fusion first, then the config dashboards in order. */
export function dashboardsOf(manifest: Manifest): DashboardEntry[] {
  const def = manifest.config.viewer.defaultDashboard;
  return [
    { dashboard: FUSION, source: 'built-in', isDefault: FUSION.id === def },
    ...manifest.config.dashboards.map(({ source, dashboard }) => ({
      dashboard,
      source,
      isDefault: dashboard.id === def,
    })),
  ];
}

export function findDashboard(entries: readonly DashboardEntry[], id: string): DashboardEntry | null {
  return entries.find((e) => e.dashboard.id === id) ?? null;
}

export function defaultDashboardRoute(manifest: Manifest): string {
  return `/dashboards/${manifest.config.viewer.defaultDashboard}`;
}
