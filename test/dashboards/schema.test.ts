import { describe, expect, it } from 'vitest';
import { FUSION } from '../../src/dashboards/fusion.js';
import {
  type DashboardInput,
  DashboardListSchema,
  DashboardSchema,
  ViewListSchema,
  ViewSchema,
  type WidgetInput,
} from '../../src/dashboards/schema.js';

const tl = (over: Partial<WidgetInput> = {}): WidgetInput =>
  ({ type: 'timeline', x: 0, y: 0, w: 6, h: 4, ...over }) as WidgetInput;
const dash = (widgets: WidgetInput[], over: Partial<DashboardInput> = {}): DashboardInput => ({
  id: 'd1',
  title: 'D',
  widgets,
  ...over,
});
const issuePaths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] =>
  r.error?.issues.map((i) => i.path.join('.')) ?? [];

const everyWidget: DashboardInput = dash(
  [
    { type: 'timeline', x: 0, y: 0, w: 12, h: 4 },
    { type: 'traces', x: 0, y: 4, w: 6, h: 4, query: 'name == "x"', mode: 'spans' },
    { type: 'logs', x: 6, y: 4, w: 6, h: 4, context: true, follow: false },
    {
      type: 'metric',
      x: 0,
      y: 8,
      w: 6,
      h: 4,
      queries: [{ id: 'a', metric: 'm', show: 'value' }],
      formulas: [{ id: 'f1', expr: 'a * 2' }],
      echarts: { grid: { top: 1 } },
    },
    { type: 'metric', x: 6, y: 8, w: 6, h: 4 },
    { type: 'toplist', x: 0, y: 12, w: 6, h: 4, signal: 'spans', groupBy: 'name', echarts: { a: 1 } },
    {
      type: 'table',
      x: 6,
      y: 12,
      w: 6,
      h: 4,
      signal: 'logs',
      groupBy: 'severity_text',
      query: 'severity_number > 9',
    },
  ],
  { variables: ['service.name', { key: 'env', default: 'prod' }], description: 'x' },
);

describe('FUSION', () => {
  it('has the four widgets', () => {
    expect(FUSION.widgets.map((w) => w.id)).toEqual(['timeline', 'traces', 'logs', 'metrics']);
    expect(FUSION.id).toBe('fusion');
  });
  it('is idempotent through the schema', () => {
    expect(DashboardSchema.parse(FUSION)).toEqual(FUSION);
  });
});

describe('DashboardSchema', () => {
  it('is idempotent for a dashboard using every widget type', () => {
    const once = DashboardSchema.parse(everyWidget);
    expect(DashboardSchema.parse(once)).toEqual(once);
  });

  it('rejects overlap on the later widget; touching edges pass', () => {
    const r = DashboardSchema.safeParse(dash([tl(), tl({ x: 5, y: 2, w: 4, h: 4 })]));
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toEqual(['widgets.1']);
    expect(JSON.stringify(r.error?.issues)).toContain('does not overlap widgets[0] (w1)');
    expect(DashboardSchema.safeParse(dash([tl(), tl({ x: 6, w: 6 }), tl({ y: 4 })])).success).toBe(true);
  });

  it('takes at most 50 widgets', () => {
    const rows = (n: number): WidgetInput[] => Array.from({ length: n }, (_, i) => tl({ y: i * 4 }));
    expect(DashboardSchema.safeParse(dash(rows(50))).success).toBe(true);
    const r = DashboardSchema.safeParse(dash(rows(51)));
    expect(issuePaths(r)).toEqual(['widgets']);
    expect(r.error?.issues[0]?.message).toBe('at most 50 widgets');
  });

  it('bounds h to 2..40 rows', () => {
    expect(DashboardSchema.safeParse(dash([tl({ h: 2 })])).success).toBe(true);
    expect(DashboardSchema.safeParse(dash([tl({ h: 40 })])).success).toBe(true);
    expect(issuePaths(DashboardSchema.safeParse(dash([tl({ h: 1 })])))).toEqual(['widgets.0.h']);
    expect(issuePaths(DashboardSchema.safeParse(dash([tl({ h: 41 })])))).toEqual(['widgets.0.h']);
  });

  it('rejects a repeated metric query id at the later query', () => {
    const q = { id: 'a', metric: 'm', show: 'value' };
    const r = DashboardSchema.safeParse(
      dash([{ type: 'metric', x: 0, y: 0, w: 6, h: 4, queries: [q, { ...q, metric: 'n' }] }]),
    );
    expect(issuePaths(r)).toEqual(['widgets.0.queries.1.id']);
    expect(r.error?.issues[0]?.message).toBe('unique query ids');
  });

  it('rejects x + w over 12', () => {
    const r = DashboardSchema.safeParse(dash([tl({ x: 8, w: 6 })]));
    expect(JSON.stringify(r.error?.issues)).toContain('x + w at most 12');
  });

  it('rejects a spans-invalid query on a traces widget at its path', () => {
    const r = DashboardSchema.safeParse(
      dash([{ type: 'traces', x: 0, y: 0, w: 6, h: 4, query: 'log.severity_number > 9' }]),
    );
    expect(issuePaths(r)).toEqual(['widgets.0.query']);
    expect(r.error?.issues[0]?.message).toMatch(/^an OTTL condition valid for spans \(/);
  });

  it('names log records for a logs query', () => {
    const r = DashboardSchema.safeParse(dash([{ type: 'logs', x: 0, y: 0, w: 6, h: 4, query: 'name ==' }]));
    expect(r.error?.issues[0]?.message).toMatch(/^an OTTL condition valid for log records \(/);
  });

  it('validates metric queries and formulas', () => {
    const m = (extra: object): WidgetInput =>
      ({ type: 'metric', x: 0, y: 0, w: 6, h: 4, ...extra }) as WidgetInput;
    const q = { id: 'a', metric: 'm', show: 'value' };
    const bad = DashboardSchema.safeParse(
      dash([m({ queries: [q], formulas: [{ id: 'f1', expr: 'a / c' }] })]),
    );
    expect(issuePaths(bad)).toEqual(['widgets.0.formulas.0.expr']);
    expect(DashboardSchema.safeParse(dash([m({ queries: [] })])).success).toBe(false);
    expect(DashboardSchema.safeParse(dash([m({ queries: [{ ...q, metric: '' }] })])).success).toBe(false);
    expect(DashboardSchema.safeParse(dash([m({ queries: [{ ...q, show: '' }] })])).success).toBe(false);
    expect(DashboardSchema.safeParse(dash([m({ formulas: [{ id: 'f1', expr: 'a' }] })])).success).toBe(false);
    expect(
      DashboardSchema.safeParse(dash([m({ queries: [q], formulas: [{ id: 'f1', expr: 'a +' }] })])).success,
    ).toBe(false);
  });

  it('rejects follow on a timeline', () => {
    expect(
      DashboardSchema.safeParse(dash([{ ...tl(), follow: true } as unknown as WidgetInput])).success,
    ).toBe(false);
  });

  it('normalizes variables and rejects duplicates and more than 8', () => {
    const d = DashboardSchema.parse(
      dash([tl()], { variables: ['k', { key: 'j', label: 'J', default: 'x' }] }),
    );
    expect(d.variables).toEqual([
      { key: 'k', label: 'k', default: null },
      { key: 'j', label: 'J', default: 'x' },
    ]);
    expect(DashboardSchema.safeParse(dash([tl()], { variables: ['k', { key: 'k' }] })).success).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => `k${i}`);
    expect(DashboardSchema.safeParse(dash([tl()], { variables: nine })).success).toBe(false);
  });

  it('defaults widget ids by position and keeps explicit ones', () => {
    const d = DashboardSchema.parse(dash([tl(), tl({ id: 'mine', x: 6 }), tl({ y: 4 })]));
    expect(d.widgets.map((w) => w.id)).toEqual(['w1', 'mine', 'w3']);
  });

  it('rejects duplicate widget ids and bad ids', () => {
    expect(DashboardSchema.safeParse(dash([tl({ id: 'a' }), tl({ id: 'a', x: 6 })])).success).toBe(false);
    expect(DashboardSchema.safeParse(dash([tl({ id: 'A' })])).success).toBe(false);
    expect(DashboardSchema.safeParse(dash([tl()], { id: 'Bad' })).success).toBe(false);
  });

  it('requires 1 to 50 widgets', () => {
    expect(DashboardSchema.safeParse(dash([])).success).toBe(false);
  });
});

describe('DashboardListSchema', () => {
  it('rejects the reserved id and duplicates', () => {
    expect(DashboardListSchema.safeParse([dash([tl()], { id: 'fusion' })]).success).toBe(false);
    const dup = DashboardListSchema.safeParse([dash([tl()]), dash([tl()])]);
    expect(dup.success).toBe(false);
    expect(DashboardListSchema.safeParse([dash([tl()]), dash([tl()], { id: 'd2' })]).success).toBe(true);
  });
});

describe('ViewSchema', () => {
  const v = (over: object): unknown => ({ id: 'v1', title: 'V', ...over });
  it('checks mode, view, query and metrics against the page', () => {
    expect(ViewSchema.safeParse(v({ page: 'logs', mode: 'spans' })).success).toBe(false);
    expect(ViewSchema.safeParse(v({ page: 'traces', view: 'scatter' })).success).toBe(false);
    expect(ViewSchema.safeParse(v({ page: 'traces', metrics: { queries: [] } })).success).toBe(false);
    expect(ViewSchema.safeParse(v({ page: 'traces', query: 'log.severity_number > 9' })).success).toBe(false);
    expect(ViewSchema.safeParse(v({ page: 'metrics', metrics: { queries: [] } })).success).toBe(true);
    expect(ViewSchema.safeParse(v({ page: 'metrics', mode: 'spans' })).success).toBe(false);
    expect(ViewSchema.safeParse(v({ page: 'metrics', query: 'a == 1' })).success).toBe(false);
    expect(ViewSchema.safeParse(v({ page: 'metrics', text: 'x' })).success).toBe(false);
    expect(
      ViewSchema.safeParse(v({ page: 'logs', mode: 'patterns', view: 'list', query: 'severity_number > 9' }))
        .success,
    ).toBe(true);
  });

  it('is idempotent', () => {
    for (const x of [
      v({
        page: 'traces',
        query: 'name == "x"',
        text: 't',
        mode: 'spans',
        groupBy: 'name',
        view: 'toplist',
        sort: 'dur',
      }),
      v({ page: 'metrics', metrics: { queries: [{ id: 'a', metric: 'm', show: 'value' }] } }),
      v({ page: 'logs' }),
    ]) {
      const once = ViewSchema.parse(x);
      expect(ViewSchema.parse(once)).toEqual(once);
    }
  });

  it('requires unique ids in a list', () => {
    expect(ViewListSchema.safeParse([v({ page: 'logs' }), v({ page: 'logs' })]).success).toBe(false);
    expect(ViewListSchema.safeParse([v({ page: 'logs' })]).success).toBe(true);
  });
});
