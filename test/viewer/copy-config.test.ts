import { describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { ConfigSchema } from '../../src/config/schema.js';
import { FUSION } from '../../src/dashboards/fusion.js';
import { type Dashboard, DashboardSchema, type WidgetLayout } from '../../src/dashboards/schema.js';
import { dashboardToYaml, WIDGET_DEFAULTS, widgetToYaml } from '../../src/viewer/dashboards/copy-config.js';

const layoutOf = (d: Dashboard): WidgetLayout[] => d.widgets.map(({ x, y, w, h }) => ({ x, y, w, h }));

function reparse(yamlText: string): Dashboard {
  const config = ConfigSchema.parse({ dashboards: parse(yamlText).dashboards });
  const [only] = config.dashboards;
  if (only === undefined) throw new Error('no dashboard came back');
  return only.dashboard;
}

describe('dashboardToYaml', () => {
  test('Fusion is renamed and round-trips through the config schema with its layout', () => {
    const text = dashboardToYaml(FUSION, layoutOf(FUSION));
    expect(text).toContain('id: fusion-copy');
    expect(text).toContain('title: Fusion (copy)');
    const back = reparse(text);
    expect(back.id).toBe('fusion-copy');
    expect(back.title).toBe('Fusion (copy)');
    expect(layoutOf(back)).toEqual(layoutOf(FUSION));
    expect(back.widgets.map((w) => [w.id, w.type])).toEqual(FUSION.widgets.map((w) => [w.id, w.type]));
    expect(back.variables).toEqual(FUSION.variables);
  });

  test('defaults, nulls and default ids are left out', () => {
    const text = dashboardToYaml(FUSION, layoutOf(FUSION));
    expect(text).not.toMatch(/follow:|query:|text:|mode:|title: null/);
    const mine = DashboardSchema.parse({
      id: 'mine',
      title: 'Mine',
      widgets: [
        { type: 'timeline', x: 0, y: 0, w: 12, h: 6 },
        { type: 'logs', x: 0, y: 6, w: 12, h: 8, query: 'severity_number >= 17', follow: false },
      ],
    });
    const out = dashboardToYaml(mine, layoutOf(mine));
    expect(out).not.toMatch(/\bid: w\d/);
    expect(out).toContain('follow: false');
    expect(out).toContain('query: severity_number >= 17');
    expect(out).not.toContain('context');
    expect(out).toContain('id: mine');
  });

  test('a moved widget keeps its new position, and the result is a valid dashboard', () => {
    const mine = DashboardSchema.parse({
      id: 'mine',
      title: 'Mine',
      variables: [{ key: 'service.name', label: 'Service', default: 'web' }, 'host.name'],
      widgets: [
        { type: 'timeline', x: 0, y: 0, w: 12, h: 6 },
        { type: 'traces', x: 0, y: 6, w: 6, h: 10 },
      ],
    });
    const moved = [
      { x: 0, y: 0, w: 12, h: 6 },
      { x: 6, y: 6, w: 6, h: 12 },
    ];
    const back = reparse(dashboardToYaml(mine, moved));
    expect(layoutOf(back)).toEqual(moved);
    expect(back.variables).toEqual(mine.variables);
  });

  test('every default is what the schema fills in', () => {
    for (const [type, defaults] of Object.entries(WIDGET_DEFAULTS)) {
      const d = DashboardSchema.parse({
        id: 'x',
        title: 'x',
        widgets: [
          type === 'toplist' || type === 'table'
            ? { type, x: 0, y: 0, w: 6, h: 6, signal: 'spans', groupBy: 'service.name' }
            : { type, x: 0, y: 0, w: 6, h: 6 },
        ],
      });
      const [w] = d.widgets;
      for (const [k, v] of Object.entries(defaults)) {
        expect(JSON.stringify((w as unknown as Record<string, unknown>)[k]), `${type}.${k}`).toBe(
          JSON.stringify(v),
        );
      }
    }
  });
});

describe('widgetToYaml', () => {
  test('wraps one widget under widgets', () => {
    const w = { type: 'logs', x: 0, y: 0, w: 6, h: 8 } as const;
    expect(widgetToYaml(w)).toBe(stringify({ widgets: [w] }));
  });
});
