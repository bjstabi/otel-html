import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CatalogueContext, CatalogueEntry } from '../../src/viewer/data/catalogue.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { LogQuery, SpanQuery } from '../../src/viewer/data/results.js';
import { buildFormat4Report } from '../../test-support/format4-fixture.js';
import {
  BASE,
  buildLayouts,
  edge,
  type Layout,
  longWindow,
  type SpanSpec,
  STATISTICS_KEYS,
  shortWindow,
  spansRequest,
  withoutRollups,
} from '../../test-support/rollup-fixture.js';
import { ROLLUP_ENTRIES } from '../../test-support/scaling/rollup-entries.js';
import { type Opened, openLayout } from './rollup-open.js';

/** Plain data for a comparison: the bucket and facet classes serialise themselves, a bigint is its text. */
const plain = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x)));

const SORT_KEY = 'resource.attributes["service.name"] == "svc-a"';
const STAT_KEY = 'resource.attributes["run.id"] == "r1"';
const IDS = {
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  logRef: '0.0',
  service: 'svc-a',
  resource: 'none',
  runId: 'r1',
  route: '/a',
  text: 'edge',
  metric: 'none',
};

/** `ds` with the condition of every aggregate request replaced (null keeps the entry's own). */
function withCondition(ds: DataSource, condition: string | null): DataSource {
  if (condition === null) return ds;
  return {
    ...ds,
    querySpans: (q, s) => ds.querySpans({ ...q, condition }, s),
    queryLogs: (q, s) => ds.queryLogs({ ...q, condition }, s),
    services: (o, s) => ds.services({ ...o, condition }, s),
  };
}

const CONDITIONS: readonly (readonly [string, string | null])[] = [
  ['its own condition', null],
  ['a sort-key condition', SORT_KEY],
  ['a statistics-key condition', STAT_KEY],
];

/** The epoch of the written report, and one a merge moved (not a multiple of the grain). */
const SHIFTS = [0n, -123_456_789n] as const;

let layouts: { A: Layout; B: Layout; C: Layout };
const open = new Map<string, Opened>();

async function openedOf(layout: Layout, shift: bigint): Promise<Opened> {
  const key = `${layout.name}/${shift}`;
  const hit = open.get(key);
  if (hit !== undefined) return hit;
  const o = await openLayout(layout.fixture, shift);
  open.set(key, o);
  return o;
}

beforeAll(async () => {
  layouts = await buildLayouts();
}, 120_000);
afterAll(() => {
  for (const o of open.values()) o.close();
});

async function run(
  entry: CatalogueEntry,
  layout: Layout,
  shift: bigint,
  condition: string | null,
  windowed: boolean,
): Promise<unknown> {
  const o = await openedOf(layout, shift);
  const ctx: CatalogueContext = { window: windowed ? longWindow(o.epoch) : null, ids: IDS };
  // a fresh data source per run: the trace and metric memos are per source
  return plain(await entry.run(withCondition(o.ds, condition), ctx));
}

describe('the entries a rollup may answer', () => {
  test('are the aggregates over rollup dimensions, the attribute- and trace-conditioned ones included', () => {
    expect(ROLLUP_ENTRIES.map((e) => e.id).sort()).toEqual([
      'logs.facets.attr.long',
      'logs.facets.core.long',
      'logs.timeline.long',
      'logs.timeline.statkey.long',
      'logs.total.long',
      'spans.buckets.long',
      'spans.durations.long',
      'spans.facets.attr.long',
      'spans.facets.core.long',
      'spans.groups.long',
      'spans.services.long',
      'spans.timeline.long',
      'spans.total.attr.long',
      'spans.total.long',
      'spans.total.sortkey.long',
      'spans.total.statkey.long',
    ]);
  });
});

describe('rollup equivalence', () => {
  test.each(
    ROLLUP_ENTRIES.flatMap((entry) =>
      CONDITIONS.flatMap(([label, condition]) =>
        SHIFTS.flatMap((shift) =>
          [true, false].map((windowed) => ({ entry, id: entry.id, label, condition, shift, windowed })),
        ),
      ),
    ),
  )(
    '$id with $label, epoch shift $shift, window $windowed answers the same from rollups, from raw files and from a mix',
    async ({ entry, condition, shift, windowed }) => {
      if (!windowed && entry.window === false) return;
      const raw = await run(entry, layouts.B, shift, condition, windowed);
      expect(await run(entry, layouts.A, shift, condition, windowed)).toEqual(raw);
      expect(await run(entry, layouts.C, shift, condition, windowed)).toEqual(raw);
    },
    60_000,
  );

  test('the rollups are what answers: A reads the rollup tables, B never does, C both', async () => {
    const seen = async (layout: Layout): Promise<{ rollup: boolean; base: boolean }> => {
      const o = await openLayout(layout.fixture);
      try {
        // a condition on a statistics key: the weak rollup of C lacks that dimension, so its partition reads the raw file
        await o.ds.querySpans(
          spanQuery({
            window: longWindow(o.epoch),
            needs: ['total', 'timeline'],
            condition: 'resource.attributes["run.id"] != "none"',
          }),
        );
        const sql = o.db.connector.requests.map((r) => r.sql).join('\n');
        return { rollup: /FROM "span_rollups"/.test(sql), base: /FROM "spans"/.test(sql) };
      } finally {
        o.close();
      }
    };
    expect(await seen(layouts.A)).toEqual({ rollup: true, base: false });
    expect(await seen(layouts.B)).toEqual({ rollup: false, base: true });
    expect(await seen(layouts.C)).toEqual({ rollup: true, base: true });
  });
});

const spanQuery = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 100,
  groupBy: null,
  measureBy: null,
  needs: ['total'],
  facetKeys: null,
  ...over,
});
const logQuery = (over: Partial<LogQuery>): LogQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'logs',
  sort: { column: 'time', dir: 'asc' },
  limit: 100,
  needs: ['total'],
  facetKeys: null,
  ...over,
});

describe('edge rows', () => {
  const needs = ['total', 'timeline', 'facets', 'durations', 'groups'] as const;
  const everything = async (o: Opened, over: Partial<SpanQuery>): Promise<Record<string, unknown>> =>
    plain(
      await o.ds.querySpans(spanQuery({ needs: [...needs], measureBy: 'service.name', ...over })),
    ) as Record<string, unknown>;

  test('a span starting on the window start counts, on the window end does not, and one overlapping from before does not', async () => {
    const o = await openedOf(layouts.A, 0n);
    const total = async (condition: string): Promise<number> =>
      (await o.ds.querySpans(spanQuery({ window: longWindow(o.epoch), condition }))).total;
    expect(await total('name == "edge-start"')).toBe(1);
    expect(await total('name == "edge-before"')).toBe(0);
    expect(await total('name == "edge-overlap"')).toBe(0);
    expect(await total('name == "edge-end"')).toBe(0);
    expect(await total('name == "edge-last"')).toBe(1);
    expect(await total('name == "edge-zero"')).toBe(1);
  });

  test('a log stamped on the window start counts, on the end does not; one with an observed time only counts', async () => {
    const o = await openedOf(layouts.A, 0n);
    const w = longWindow(o.epoch);
    const [row] = o.db.rows(
      `SELECT count(*) FILTER (WHERE coalesce(time_unix_nano, observed_time_unix_nano) >= ${o.epoch + BigInt(w.start)} AND coalesce(time_unix_nano, observed_time_unix_nano) < ${o.epoch + BigInt(w.end)}) AS inside, count(*) AS every FROM logs`,
    );
    const inside = Number(Reflect.get(row ?? {}, 'inside'));
    const every = Number(Reflect.get(row ?? {}, 'every'));
    // the log with no time at all is in no window; a log stamped on the end is in the next one
    expect(every).toBeGreaterThan(inside + 2);
    for (const layout of [layouts.A, layouts.B, layouts.C]) {
      const own = await openedOf(layout, 0n);
      expect((await own.ds.queryLogs(logQuery({ window: longWindow(own.epoch) }))).total).toBe(inside);
      expect((await own.ds.queryLogs(logQuery({ window: null }))).total).toBe(every);
    }
    const onEdges = async (condition: string): Promise<number> =>
      (await o.ds.queryLogs(logQuery({ window: w, condition }))).total;
    expect(await onEdges('severity_number == 9 and time_unix_nano == 0')).toBe(0);
  });

  test('a log with no time is in the timeline when no window is set (at the epoch), and in no bucket under a long window', async () => {
    const severities = ['unspecified', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    const sum = (r: Awaited<ReturnType<DataSource['queryLogs']>>): number =>
      severities.reduce((n, k) => n + r.buckets.total(k), 0);
    for (const layout of [layouts.A, layouts.B, layouts.C]) {
      const o = await openedOf(layout, 0n);
      const everything = await o.ds.queryLogs(logQuery({ needs: ['timeline', 'total'], window: null }));
      expect(sum(everything)).toBe(everything.total);
      const windowed = await o.ds.queryLogs(
        logQuery({ needs: ['timeline', 'total'], window: longWindow(o.epoch) }),
      );
      expect(sum(windowed)).toBe(windowed.total);
      // the logs with no time, and those stamped on or after the window's end, are in the first only
      expect(everything.total).toBeGreaterThan(windowed.total + 2);
    }
  });

  test.each([['attributes["http.route"] != "no-such"'], ['Len(name) > -1']])(
    '%s gives the same total, timeline, groups, services and durations as no condition',
    async (condition) => {
      for (const layout of [layouts.A, layouts.B, layouts.C]) {
        const o = await openedOf(layout, 0n);
        const window = longWindow(o.epoch);
        // a condition is echoed as the residual of the result; everything else is the same
        const bare = { ...(await everything(o, { window })), residual: null };
        expect({ ...(await everything(o, { window, condition })), residual: null }).toEqual(bare);
        const services = await o.ds.services({ window, condition: null, limit: 10 });
        expect(plain(await o.ds.services({ window, condition, limit: 10 }))).toEqual(plain(services));
      }
    },
  );

  test('a rollup lacking the condition key answers through the raw branch, whatever its statistics say', async () => {
    // C's weak rollup records "no value" for resource:run.id; the partition must still count
    const c = await openedOf(layouts.C, 0n);
    const b = await openedOf(layouts.B, 0n);
    for (const run of ['r1', 'r2', 'r3', 'r4']) {
      const condition = `resource.attributes["run.id"] == "${run}"`;
      const w = (o: Opened) => spanQuery({ window: longWindow(o.epoch), condition });
      expect((await c.ds.querySpans(w(c))).total).toBe((await b.ds.querySpans(w(b))).total);
    }
  });
});

describe('percentiles', () => {
  /** 17 durations, each 30 times, so the ranks of p50, p95 and p99 fall inside a run and `quantile_cont` is that run's value. */
  const runs = Array.from({ length: 17 }, (_, j) => BigInt(Math.floor(1000 * 1.7 ** j)));
  const dense = (): SpanSpec[] =>
    runs.flatMap((d, j) =>
      Array.from({ length: 30 }, (_, i) => ({
        id: 100 + j * 30 + i,
        trace: 1,
        svc: 'svc-a',
        run: 'r1',
        name: 'dense',
        startNs: edge(10 + ((j * 30 + i) % 200), BigInt(i) * 1_000_000n),
        durNs: d,
      })),
    );
  const truth = (o: Opened): number[] => {
    const w = longWindow(o.epoch);
    const [row] = o.db.rows(
      `SELECT quantile_cont(duration_ns, [0.5, 0.95, 0.99]) AS q FROM spans WHERE start_time_unix_nano >= ${o.epoch + BigInt(w.start)} AND start_time_unix_nano < ${o.epoch + BigInt(w.end)}`,
    );
    return Array.from(Reflect.get(row ?? {}, 'q') as ArrayLike<number>);
  };

  test('long: p50, p95 and p99 are within 4.43 % of quantile_cont over the same rows, and inside [min, max]', async () => {
    const rich = await buildFormat4Report([spansRequest(dense())], {
      config: { writer: { statisticsKeys: [...STATISTICS_KEYS] } },
    });
    for (const f of [rich, withoutRollups(rich)]) {
      const o = await openLayout(f);
      try {
        const r = await o.ds.querySpans(spanQuery({ window: longWindow(o.epoch), needs: ['durations'] }));
        const summary = r.durations.summary;
        if (summary === null) throw new Error('no summary');
        const want = truth(o);
        expect(want).toHaveLength(3);
        [summary.p50, summary.p95, summary.p99].forEach((got, i) => {
          const exact = want[i] ?? Number.NaN;
          expect(Math.abs(got / exact - 1)).toBeLessThanOrEqual(0.0443);
          expect(got).toBeGreaterThanOrEqual(summary.min);
          expect(got).toBeLessThanOrEqual(summary.max);
        });
        expect(summary.count).toBe(510);
        expect(summary.min).toBe(Number(runs[0]));
        expect(summary.max).toBe(Number(runs[16]));
      } finally {
        o.close();
      }
    }
  });

  test('short: percentiles are exact, as today', async () => {
    const o = await openedOf(layouts.A, 0n);
    const w = shortWindow(o.epoch);
    const r = await o.ds.querySpans(spanQuery({ window: w, needs: ['durations'] }));
    const summary = r.durations.summary;
    if (summary === null) throw new Error('no summary');
    // a short window selects by overlap, as before
    const [row] = o.db.rows(
      `SELECT quantile_cont(duration_ns, [0.5, 0.95, 0.99]) AS q FROM spans WHERE end_time_unix_nano >= ${o.epoch + BigInt(w.start)} AND start_time_unix_nano <= ${o.epoch + BigInt(w.end)}`,
    );
    const q = Array.from(Reflect.get(row ?? {}, 'q') as ArrayLike<number>);
    expect([summary.p50, summary.p95, summary.p99]).toEqual(q);
  });
});

describe('a report without spans or without logs', () => {
  test('a logs-only report and a report with an empty spans table answer empty under a long window', async () => {
    const { buildFormat4Report } = await import('../../test-support/format4-fixture.js');
    const { logsOf, longWindow: lw } = await import('../../test-support/rollup-fixture.js');
    const logsOnly = await buildFormat4Report([logsOf([{ svc: 'a', run: 'r', timeNs: BASE, severity: 9 }])]);
    const o = await openLayout(logsOnly);
    try {
      const w = lw(o.epoch);
      expect(
        await o.ds.querySpans(spanQuery({ needs: ['total', 'timeline', 'facets', 'durations'], window: w })),
      ).toMatchObject({ total: 0 });
      expect((await o.ds.services({ window: w, condition: null, limit: 5 })).services).toEqual([]);
      expect(
        (await o.ds.queryLogs(logQuery({ window: w, needs: ['total', 'timeline', 'facets'] }))).total,
      ).toBe(0);
    } finally {
      o.close();
    }
  });
});
