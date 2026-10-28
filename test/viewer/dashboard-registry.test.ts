import { beforeAll, describe, expect, test } from 'vitest';
import { FUSION } from '../../src/dashboards/fusion.js';
import { DashboardSchema } from '../../src/dashboards/schema.js';
import { dashboardsOf, defaultDashboardRoute, findDashboard } from '../../src/viewer/dashboards/registry.js';
import { buildReport, type Fixture } from './report-fixture.js';

let fx: Fixture;
beforeAll(async () => {
  fx = await buildReport(1);
});

describe('dashboardsOf', () => {
  test('an M3 manifest has Fusion only, and it is the default', () => {
    expect(dashboardsOf(fx.manifest)).toEqual([{ dashboard: FUSION, source: 'built-in', isDefault: true }]);
    expect(defaultDashboardRoute(fx.manifest)).toBe('/dashboards/fusion');
  });

  test('config dashboards follow Fusion in order; the default flag follows viewer.defaultDashboard', () => {
    const mine = DashboardSchema.parse({
      id: 'mine',
      title: 'Mine',
      widgets: [{ type: 'timeline', x: 0, y: 0, w: 12, h: 6 }],
    });
    const manifest = {
      ...fx.manifest,
      config: {
        ...fx.manifest.config,
        viewer: { ...fx.manifest.config.viewer, defaultDashboard: 'mine' },
        dashboards: [{ source: 'otel-html.yaml', dashboard: mine }],
      },
    };
    const entries = dashboardsOf(manifest);
    expect(entries.map((e) => [e.dashboard.id, e.source, e.isDefault])).toEqual([
      ['fusion', 'built-in', false],
      ['mine', 'otel-html.yaml', true],
    ]);
    expect(findDashboard(entries, 'mine')?.source).toBe('otel-html.yaml');
    expect(findDashboard(entries, 'nope')).toBeNull();
    expect(defaultDashboardRoute(manifest)).toBe('/dashboards/mine');
  });
});
