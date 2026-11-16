import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { ConfigSchema } from '../../src/config/schema.js';
import { conditionId, normalizeCondition, widgetTraceConditions } from '../../src/config/widget-traces.js';
import { CONVERTERS, type ConverterSpec } from '../../src/ottl/converters.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

async function dashboardsOf(path: string) {
  const fs = createMemoryFileSystem();
  await fs.mkdirp('/c');
  await fs.writeTextAtomic('/c/ci.yaml', await readFile(path, 'utf8'));
  const { config } = resolveConfig({
    file: await loadConfigFile(fs, '/c/ci.yaml'),
    env: {},
    fileLabel: 'config.yaml',
  });
  return config.dashboards;
}

const dashboardWith = (widgets: object[], variables: object[] = []) =>
  ConfigSchema.parse({
    dashboards: [
      {
        id: 'd',
        title: 'D',
        variables,
        widgets: widgets.map((w, i) => ({ ...w, x: 0, w: 6, h: 6, y: i * 6 })),
      },
    ],
  }).dashboards;

describe('normalizeCondition', () => {
  test('trims and collapses whitespace outside string literals, keeping literals and their escapes', () => {
    expect(normalizeCondition('  a  ==\n "x  y" ')).toBe('a == "x  y"');
    expect(normalizeCondition('a == "q\\"  z"   and\tb')).toBe('a == "q\\"  z" and b');
  });
});

describe('conditionId', () => {
  test('is 16 lowercase hex digits and ignores layout', () => {
    expect(conditionId('a == 1')).toMatch(/^[0-9a-f]{16}$/);
    expect(conditionId(' a  ==\n1 ')).toBe(conditionId('a == 1'));
    expect(conditionId('a == 2')).not.toBe(conditionId('a == 1'));
  });
});

describe('widgetTraceConditions', () => {
  test('the CI config indexes its Runs query once, on one line or three, under its three variables', async () => {
    const spec = widgetTraceConditions(await dashboardsOf('.github/otel-html-ci.yaml'));
    expect(spec.conditions).toHaveLength(1);
    const [only] = spec.conditions;
    expect(only?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(only?.source).toContain('IsRootSpan()');
    expect(spec.variables).toEqual(['cicd.pipeline.name', 'cicd.pipeline.run.id', 'cicd.pipeline.task.name']);
    expect(spec.notRowLocal).toEqual([]);

    const multi = (only?.source ?? '').replace(' and (', ' and\n  (').replace(' or (', '\n or (');
    expect(multi.split('\n').length).toBe(3);
    const again = widgetTraceConditions(dashboardWith([{ type: 'traces', query: multi }], [{ key: 'k' }]));
    expect(again.conditions).toEqual(spec.conditions);
  });

  test('a traces widget without a query adds nothing', async () => {
    const dashboards = await dashboardsOf('fixtures/dashboards.otel-html.yaml');
    const queryless = dashboards
      .flatMap((d) => d.dashboard.widgets)
      .filter((w) => w.type === 'traces' && w.query === null);
    expect(queryless.length).toBeGreaterThan(0);
    const spec = widgetTraceConditions(dashboards);
    expect(spec.conditions.map((c) => c.source)).toEqual([
      expect.stringContaining('instrumentation_scope.name == "otel-html-ci"'),
    ]);
    expect(widgetTraceConditions(dashboardWith([{ type: 'traces' }], [{ key: 'k' }]))).toEqual({
      conditions: [],
      variables: [],
      notRowLocal: [],
    });
  });

  test('a query that does not parse adds nothing', () => {
    const dashboards = dashboardWith([{ type: 'traces', query: 'attributes["a"] == "1"' }], [{ key: 'k' }]);
    for (const w of dashboards[0]?.dashboard.widgets ?? []) if (w.type === 'traces') w.query = 'a ==';
    expect(widgetTraceConditions(dashboards)).toEqual({ conditions: [], variables: [], notRowLocal: [] });
  });

  test('conditions are distinct and sorted by id; other widget types add nothing', () => {
    const spec = widgetTraceConditions(
      dashboardWith(
        [
          { type: 'traces', query: 'attributes["a"] == "1"' },
          { type: 'traces', query: 'attributes["b"] == "2"' },
          { type: 'traces', query: 'attributes["a"]  ==  "1"' },
          { type: 'toplist', signal: 'spans', query: 'attributes["c"] == "3"', groupBy: 'span.name' },
        ],
        [{ key: 'z' }, { key: 'k' }],
      ),
    );
    expect(spec.conditions).toHaveLength(2);
    const ids = spec.conditions.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
    expect(spec.variables).toEqual(['k', 'z']);
  });

  describe('a converter that is not row local', () => {
    const converters = CONVERTERS as Map<string, ConverterSpec>;
    afterEach(() => converters.delete('TestAcrossRows'));

    test('is listed in notRowLocal and left out of the conditions', () => {
      converters.set('TestAcrossRows', {
        arity: 0,
        returns: 'bool',
        rowLocal: false,
        call: () => true,
      });
      const spec = widgetTraceConditions(
        dashboardWith(
          [
            { type: 'traces', query: 'TestAcrossRows() and attributes["a"] == "1"' },
            { type: 'traces', query: 'attributes["b"] == "2"' },
          ],
          [{ key: 'k' }],
        ),
      );
      expect(spec.notRowLocal).toEqual(['TestAcrossRows() and attributes["a"] == "1"']);
      expect(spec.conditions.map((c) => c.source)).toEqual(['attributes["b"] == "2"']);
    });
  });
});
