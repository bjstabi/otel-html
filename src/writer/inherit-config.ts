import type { ResolvedConfig } from '../config/schema.js';
import type { Manifest } from '../format/manifest.js';

/**
 * Fill what a run's config leaves empty from an earlier report's manifest, so appending or merging
 * without `--config` keeps that report's dashboards and views. A config that names dashboards replaces them.
 */
export function inheritDashboards(config: ResolvedConfig, prior: Manifest['config']): ResolvedConfig {
  const keepDashboards = config.dashboards.length === 0;
  const dashboards = keepDashboards ? prior.dashboards : config.dashboards;
  const views = config.views.length === 0 ? prior.views : config.views;
  // The prior default is only meaningful while the dashboards it names are the ones kept.
  const defaultDashboard =
    keepDashboards && config.viewer.defaultDashboard === 'fusion'
      ? prior.viewer.defaultDashboard
      : config.viewer.defaultDashboard;
  return { ...config, dashboards, views, viewer: { ...config.viewer, defaultDashboard } };
}
