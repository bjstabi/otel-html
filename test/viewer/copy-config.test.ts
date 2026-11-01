import { describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { ConfigSchema } from '../../src/config/schema.js';
import { FUSION } from '../../src/dashboards/fusion.js';
import {
  type Dashboard,
  DashboardSchema,
  DEFAULT_RUN_CONTROLS,
  type WidgetLayout,
} from '../../src/dashboards/schema.js';
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

  test('run chart fields are left out when unset, and controls when they equal the defaults', () => {
    const make = (extra: object): Dashboard =>
      DashboardSchema.parse({
        id: 'r',
        title: 'R',
        widgets: [
          {
            type: 'metric',
            x: 0,
            y: 0,
            w: 12,
            h: 8,
            queries: [{ id: 'a', metric: 'm', show: 'avg' }],
            ...extra,
          },
        ],
      });
    const plain = make({});
    expect(dashboardToYaml(plain, layoutOf(plain))).not.toMatch(/runBy|failedWhen|controls/);
    const runs = make({ runBy: 'resource.attributes["run"]' });
    const out = dashboardToYaml(runs, layoutOf(runs));
    expect(out).toContain('runBy:');
    expect(out).not.toMatch(/controls|slider/);
    expect(reparse(out)).toEqual(runs);
    const custom = make({
      runBy: 'resource.attributes["run"]',
      failedWhen: 'attributes["r"] == "failure"',
      controls: { legend: true },
    });
    const text = dashboardToYaml(custom, layoutOf(custom));
    expect(text).toContain('failedWhen:');
    expect(reparse(text)).toEqual(custom);
  });

  test('a controls override writes the current toggles, and the YAML parses back to them', () => {
    const queries = [{ id: 'a', metric: 'm', show: 'avg' }];
    const d = DashboardSchema.parse({
      id: 'r',
      title: 'R',
      widgets: [
        { type: 'metric', id: 'runs', x: 0, y: 0, w: 12, h: 8, queries, runBy: 'resource.attributes["run"]' },
        { type: 'metric', id: 'kept', x: 0, y: 8, w: 12, h: 8, queries, runBy: 'resource.attributes["run"]' },
        { type: 'metric', id: 'plain', x: 0, y: 16, w: 12, h: 8, queries },
      ],
    });
    const current = { slider: false, evenSpacing: true, split: false, legend: true };
    const text = dashboardToYaml(d, layoutOf(d), { runs: current, plain: current });
    const [runs, kept, plain] = reparse(text).widgets;
    expect(runs).toMatchObject({ controls: current });
    expect(kept).toMatchObject({ controls: DEFAULT_RUN_CONTROLS });
    // A widget that isn't a run chart can't carry controls: the schema would refuse the paste.
    expect(plain).toMatchObject({ runBy: null, controls: null });
    expect(text).not.toMatch(/zoom/);
  });

  test('a widget with no layout entry keeps its controls override', () => {
    const d = DashboardSchema.parse({
      id: 'r',
      title: 'R',
      widgets: [
        {
          type: 'metric',
          id: 'runs',
          x: 1,
          y: 2,
          w: 6,
          h: 8,
          queries: [{ id: 'a', metric: 'm', show: 'avg' }],
          runBy: 'resource.attributes["run"]',
        },
      ],
    });
    const current = { slider: false, evenSpacing: true, split: false, legend: true };
    const [runs] = reparse(dashboardToYaml(d, [], { runs: current })).widgets;
    expect(runs).toMatchObject({ controls: current, x: 1, y: 2, w: 6, h: 8 });
  });

  test('toggles put back to the defaults are left out, over a config that set others', () => {
    const d = DashboardSchema.parse({
      id: 'r',
      title: 'R',
      widgets: [
        {
          type: 'metric',
          id: 'runs',
          x: 0,
          y: 0,
          w: 12,
          h: 8,
          queries: [{ id: 'a', metric: 'm', show: 'avg' }],
          runBy: 'resource.attributes["run"]',
          controls: { legend: true },
        },
      ],
    });
    expect(dashboardToYaml(d, layoutOf(d), { runs: DEFAULT_RUN_CONTROLS })).not.toMatch(/controls|legend/);
    expect(dashboardToYaml(d, layoutOf(d))).toContain('legend: true');
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

describe('round trip', () => {
  test('a rich config dashboard survives dashboardToYaml, parse and the config schema unchanged', () => {
    const rich = DashboardSchema.parse({
      id: 'rich',
      title: 'Rich',
      description: 'Everything set',
      variables: [{ key: 'service.name', label: 'Service', default: 'web' }, 'host.name'],
      widgets: [
        { type: 'timeline', id: 'tl', title: 'All signals', x: 0, y: 0, w: 12, h: 6 },
        {
          type: 'traces',
          x: 0,
          y: 6,
          w: 6,
          h: 10,
          mode: 'spans',
          text: 'checkout',
          query: 'name == "GET /"',
        },
        { type: 'logs', x: 6, y: 6, w: 6, h: 10, context: true, follow: false },
        {
          type: 'metric',
          x: 0,
          y: 16,
          w: 12,
          h: 8,
          follow: false,
          queries: [
            {
              id: 'a',
              metric: 'http.server.request.duration',
              show: 'p95',
              by: ['attributes["http.route"]'],
            },
            { id: 'b', metric: 'http.server.request.duration', show: 'count', alias: 'n' },
          ],
          formulas: [{ id: 'f1', expr: 'a / b', alias: 'ratio' }],
          display: 'area',
          scale: 'log',
          exemplars: false,
          echarts: { grid: { top: 10 } },
        },
        {
          type: 'toplist',
          x: 0,
          y: 24,
          w: 6,
          h: 8,
          signal: 'logs',
          groupBy: 'service.name',
          echarts: { color: ['#123456'] },
        },
        { type: 'table', x: 6, y: 24, w: 6, h: 8, signal: 'spans', groupBy: 'http.route', title: 'Routes' },
      ],
    });
    expect(reparse(dashboardToYaml(rich, layoutOf(rich)))).toEqual(rich);
  });
});

describe('widgetToYaml', () => {
  test('wraps one widget under widgets', () => {
    const w = { type: 'logs', x: 0, y: 0, w: 6, h: 8 } as const;
    expect(widgetToYaml(w)).toBe(stringify({ widgets: [w] }));
  });
});
