import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import type { SpanQuery } from '../../src/viewer/data/results.js';
import { buildFormat4Report } from '../../test-support/format4-fixture.js';
import {
  longWindow,
  reportRequests,
  withoutRollups,
  withWeakRollup,
} from '../../test-support/rollup-fixture.js';
import { freshSource, type Opened, openLayout } from './rollup-open.js';

vi.setConfig({ testTimeout: 30_000 });

const plain = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x)));

/** A toplist whose query tests `k.mixed`: the writer keeps the key without `writer.statisticsKeys` naming it. */
const WIDGETS: ConfigInput = {
  dashboards: [
    {
      id: 'd',
      title: 'D',
      widgets: [
        {
          type: 'toplist',
          signal: 'spans',
          groupBy: 'span.name',
          query: 'attributes["k.mixed"] != nil',
          x: 0,
          y: 0,
          w: 6,
          h: 6,
        },
      ],
    },
  ],
};
const CONDITIONS = ['attributes["k.mixed"] != nil', 'attributes["k.mixed"] == "5"'];

const query = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 100,
  groupBy: null,
  measureBy: 'service.name',
  needs: ['total', 'groups', 'timeline'],
  facetKeys: null,
  ...over,
});

let rich: Opened;
let raw: Opened;
let mixed: Opened;

beforeAll(async () => {
  const requests = reportRequests();
  const withKeys = await buildFormat4Report(requests, { config: WIDGETS, close: false });
  const without = await buildFormat4Report(requests, { close: false });
  const first = withKeys.manifest.partitions.find((p) => p.files.span_rollups !== undefined)?.n;
  if (first === undefined) throw new Error('the fixture has no span rollup');
  rich = await openLayout(withKeys);
  raw = await openLayout(withoutRollups(withKeys));
  // the older partition's rollup was written before a widget tested the key
  mixed = await openLayout(withWeakRollup(withKeys, without, 'span_rollups', first));
}, 120_000);
afterAll(() => {
  for (const o of [rich, raw, mixed]) o.close();
});

describe('a key only a widget condition tests', () => {
  test('is a dimension of the rollups written under the dashboard, without writer.statisticsKeys', () => {
    for (const p of rich.manifest.partitions) {
      const d = p.files.span_rollups?.rollup?.dimensions;
      if (d !== undefined) expect(d).toContain('attr:k.mixed');
    }
    expect(rich.manifest.statisticsKeys.spans).toContain('attr:k.mixed');
  });

  test.each(CONDITIONS)(
    'a toplist on it reads the older partition raw and the newer from its rollup, with the answer of an all-raw read (%s)',
    async (condition) => {
      const run = async (o: Opened) =>
        plain(await o.ds.querySpans(query({ condition, window: longWindow(o.epoch) })));
      const expected = await run(raw);
      expect(await run(rich)).toEqual(expected);
      expect(await run(mixed)).toEqual(expected);
      const o = mixed;
      const from = o.db.connector.requests.length;
      await freshSource(o).querySpans(query({ condition, window: longWindow(o.epoch) }));
      const sql = o.db.connector.requests
        .slice(from)
        .map((r) => r.sql)
        .join('\n');
      expect(sql).toMatch(/FROM "span_rollups"/);
      expect(sql).toMatch(/FROM "spans"/);
    },
  );
});
