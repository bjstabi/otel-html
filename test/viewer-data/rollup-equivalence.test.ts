import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { CatalogueContext, CatalogueEntry } from '../../src/viewer/data/catalogue.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { LogQuery, SpanQuery } from '../../src/viewer/data/results.js';
import { buildFormat4Report, type Format4Fixture } from '../../test-support/format4-fixture.js';
import {
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

const SERVICE_NAMES: readonly (readonly [string, string])[] = [
  ['an SDK default service.name', 'resource.attributes["service.name"] == "unknown_service:node"'],
  ['an empty service.name', 'resource.attributes["service.name"] == ""'],
  ['an int service.name', 'resource.attributes["service.name"] == 7'],
  ['the derived name of a resource without one', 'resource.attributes["service.name"] == "unknown_service"'],
  ['a bool service.name', 'resource.attributes["service.name"] == true'],
  ['a missing service.name', 'resource.attributes["service.name"] == nil'],
];

const CONDITIONS: readonly (readonly [string, string | null])[] = [
  ['its own condition', null],
  ['a sort-key condition', SORT_KEY],
  ['a statistics-key condition', STAT_KEY],
  ...SERVICE_NAMES,
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

  test.each(ROLLUP_ENTRIES.map((e) => e.id))(
    'the rollups are what answers %s: A reads the rollup tables, B never does, C where its rollup has the dimension',
    async (id) => {
      const entry = ROLLUP_ENTRIES.find((e) => e.id === id);
      if (entry === undefined) throw new Error(id);
      const seen = async (layout: Layout): Promise<{ rollup: boolean; base: boolean }> => {
        const o = await openLayout(layout.fixture);
        try {
          await entry.run(o.ds, { window: longWindow(o.epoch), ids: IDS });
          const sql = o.db.connector.requests.map((r) => r.sql).join('\n');
          return { rollup: /FROM "(span|log)_rollups"/.test(sql), base: /FROM "(spans|logs)"/.test(sql) };
        } finally {
          o.close();
        }
      };
      // an attribute condition never reads a rollup; a statistics-key condition meets C's weak rollup, which lacks the key
      const attribute = id.includes('.total.attr.');
      const weak = id.includes('.statkey.');
      expect((await seen(layouts.A)).rollup).toBe(!attribute);
      expect(await seen(layouts.B)).toMatchObject({ rollup: false, base: true });
      expect((await seen(layouts.C)).rollup).toBe(!attribute && !weak);
    },
    60_000,
  );

  test('a condition on a statistics key reads the weak rollup of C through the raw file', async () => {
    const o = await openLayout(layouts.C.fixture);
    try {
      // the weak rollup of C lacks that dimension, so its partition reads the raw file
      await o.ds.querySpans(
        spanQuery({
          window: longWindow(o.epoch),
          needs: ['total', 'timeline'],
          condition: 'resource.attributes["run.id"] != "none"',
        }),
      );
      const sql = o.db.connector.requests.map((r) => r.sql).join('\n');
      expect(sql).toMatch(/FROM "span_rollups"/);
      expect(sql).toMatch(/FROM "spans"/);
    } finally {
      o.close();
    }
  });
});

describe('core facets under a long window', () => {
  /** The statements one call sends over the base table, a fresh data source per call (the coordinator caches by SQL text). */
  async function over(layout: Layout, table: 'spans' | 'logs', condition: string | null, long: boolean) {
    const o = await openLayout(layout.fixture);
    try {
      const window = long ? longWindow(o.epoch) : shortWindow(o.epoch);
      await (table === 'spans'
        ? o.ds.querySpans(spanQuery({ window, condition, needs: ['facets'], facetKeys: null }))
        : o.ds.queryLogs(logQuery({ window, condition, needs: ['facets'], facetKeys: null })));
      const own = new RegExp(`FROM "${table}"`);
      return o.db.connector.requests.filter((r) => r.type === 'arrow' && own.test(r.sql)).length;
    } finally {
      o.close();
    }
  }

  test.each([
    ['spans', null],
    ['spans', 'attributes["http.route"] != "no-such"'],
    ['logs', null],
    ['logs', 'attributes["http.route"] != "no-such"'],
  ] as const)(
    '%s with condition %s scan the base files once on raw partitions, as under a short window',
    async (table, condition) => {
      const short = await over(layouts.B, table, condition, false);
      expect(short).toBeGreaterThan(0);
      // the attribute facets are one more statement, short or long
      expect(await over(layouts.B, table, condition, true)).toBe(short);
      if (condition !== null) expect(await over(layouts.A, table, condition, true)).toBe(short);
    },
  );
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

describe('a service.name that is not a plain name', () => {
  test('a condition on it is answered from the rollups, which keep the key as a dimension', async () => {
    const o = await openLayout(layouts.A.fixture);
    try {
      await o.ds.querySpans(
        spanQuery({ window: longWindow(o.epoch), condition: SERVICE_NAMES[0]?.[1] ?? '', needs: ['total'] }),
      );
      const sql = o.db.connector.requests.map((r) => r.sql).join('\n');
      expect(sql).toMatch(/FROM "span_rollups"/);
      expect(sql).not.toMatch(/FROM "spans"/);
    } finally {
      o.close();
    }
  });

  test.each(SERVICE_NAMES)(
    '%s counts the same from rollups, raw files and a mix',
    async (_label, condition) => {
      const totals: number[] = [];
      for (const layout of [layouts.A, layouts.B, layouts.C]) {
        const o = await openedOf(layout, 0n);
        const r = await o.ds.querySpans(
          spanQuery({ window: longWindow(o.epoch), condition, needs: ['total'] }),
        );
        totals.push(r.total);
        const l = await o.ds.queryLogs(
          logQuery({ window: longWindow(o.epoch), condition, needs: ['total'] }),
        );
        totals.push(l.total);
      }
      expect(totals.slice(0, 2)).toEqual(totals.slice(2, 4));
      expect(totals.slice(0, 2)).toEqual(totals.slice(4, 6));
    },
  );

  test('the explicit, empty and int names are found; a resource without one is not "unknown_service"', async () => {
    const o = await openedOf(layouts.A, 0n);
    const total = async (condition: string): Promise<number> =>
      (await o.ds.querySpans(spanQuery({ window: longWindow(o.epoch), condition }))).total;
    expect(await total(SERVICE_NAMES[0]?.[1] ?? '')).toBe(1);
    expect(await total(SERVICE_NAMES[1]?.[1] ?? '')).toBe(1);
    expect(await total(SERVICE_NAMES[2]?.[1] ?? '')).toBe(1);
    expect(await total('resource.attributes["service.name"] == true')).toBe(1);
    expect(await total(SERVICE_NAMES[3]?.[1] ?? '')).toBe(0);
  });
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

  /** `durations` as spans in the long window, from rollups and from raw files: p50, p95, p99 against `quantile_cont`. */
  async function within(durations: readonly bigint[]): Promise<number[]> {
    const specs: SpanSpec[] = durations.map((d, i) => ({
      id: 500 + i,
      trace: 1,
      svc: 'svc-a',
      run: 'r1',
      name: 'spread',
      startNs: edge(10 + (i % 200), BigInt(i) * 1_000_000n),
      durNs: d,
    }));
    const rich = await buildFormat4Report([spansRequest(specs)], {
      config: { writer: { statisticsKeys: [...STATISTICS_KEYS] } },
    });
    const worst: number[] = [];
    for (const f of [rich, withoutRollups(rich)]) {
      const o = await openLayout(f);
      try {
        const r = await o.ds.querySpans(spanQuery({ window: longWindow(o.epoch), needs: ['durations'] }));
        const summary = r.durations.summary;
        if (summary === null) throw new Error('no summary');
        const want = truth(o);
        [summary.p50, summary.p95, summary.p99].forEach((got, i) => {
          const exact = want[i] ?? Number.NaN;
          worst.push(Math.abs(got - exact) / exact);
          expect(got).toBeGreaterThanOrEqual(summary.min);
          expect(got).toBeLessThanOrEqual(summary.max);
        });
      } finally {
        o.close();
      }
    }
    return worst;
  }

  test('long: two durations far apart interpolate as quantile_cont does (1 ms and 1 s: p50 is 500.5 ms)', async () => {
    const worst = await within([1_000_000n, 1_000_000_000n]);
    expect(Math.max(...worst)).toBeLessThanOrEqual(0.0443);
  });

  test('long: seeded random inputs whose ranks fall between distinct buckets stay within 4.43 %', async () => {
    let seed = 12345n;
    const next = (): number => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      return Number(seed >> 11n) / 2 ** 53;
    };
    for (const n of [3, 7, 21, 61, 100]) {
      // log-uniform from 1 ns to 10 s, so neighbouring ranks are often several buckets apart
      const durations = Array.from({ length: n }, () => BigInt(Math.floor(10 ** (next() * 10))));
      const worst = await within(durations);
      expect(Math.max(...worst), `n = ${n}`).toBeLessThanOrEqual(0.0443);
    }
  }, 60_000);

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

describe('percentileOf on a long range', () => {
  /** 17 durations 1.7 times apart (each in a bucket of its own), 30 spans each, over more than 256 grains. */
  const runs = Array.from({ length: 17 }, (_, j) => BigInt(Math.floor(1000 * 1.7 ** j)));
  const specs = (): SpanSpec[] => [
    ...runs.flatMap((d, j) =>
      Array.from({ length: 30 }, (_, i) => ({
        id: 100 + j * 30 + i,
        trace: 1,
        svc: 'svc-a',
        run: 'r1',
        name: 'dense',
        startNs: edge(10 + ((j * 30 + i) % 200), BigInt(i) * 1_000_000n),
        durNs: d,
      })),
    ),
    // another service, and a span far out so that the report's range is long
    { id: 900, trace: 2, svc: 'svc-b', run: 'r1', name: 'other', startNs: edge(300), durNs: 5n },
  ];

  const exact = (o: Opened, resource: string, d: bigint): number => {
    const [row] = o.db.rows(
      `SELECT count(*) FILTER (WHERE duration_ns <= ${d}) * 100.0 / count(*) AS p FROM spans WHERE service_name = 'svc-a' AND resource_name = '${resource}'`,
    );
    return Number(Reflect.get(row ?? {}, 'p'));
  };

  test('is within 4.43 percentage points of the exact share at a bucket edge, and equal from rollups and raw files', async () => {
    const rich = await buildFormat4Report([spansRequest(specs())], {
      config: { writer: { statisticsKeys: [...STATISTICS_KEYS] } },
    });
    const got: number[][] = [];
    for (const f of [rich, withoutRollups(rich)]) {
      const o = await openLayout(f);
      try {
        const [row] = o.db.rows(`SELECT resource_name AS r FROM spans WHERE service_name = 'svc-a' LIMIT 1`);
        const resource = String(Reflect.get(row ?? {}, 'r'));
        const before = o.db.connector.requests.length;
        const shares: number[] = [];
        for (const d of runs) {
          const share = await o.ds.percentileOf('svc-a', resource, Number(d));
          if (share === null) throw new Error('no spans');
          expect(Math.abs(share - exact(o, resource, d))).toBeLessThanOrEqual(4.43);
          shares.push(share);
        }
        expect(await o.ds.percentileOf('svc-a', 'no-such', 5)).toBeNull();
        got.push(shares);
        const sql = o.db.connector.requests
          .slice(before)
          .map((r) => r.sql)
          .join('\n');
        // a report with rollups reads them; one without reads the spans files, in the same statement shape
        expect(/FROM "span_rollups"/.test(sql)).toBe(f === rich);
      } finally {
        o.close();
      }
    }
    expect(got[0]).toEqual(got[1]);
  });

  test('a short range is the exact share over the spans files, as today', async () => {
    const few = [3n, 4n, 5n, 6n].map((d, i) => ({
      id: 700 + i,
      trace: 1,
      svc: 'svc-a',
      run: 'r1',
      name: 'few',
      startNs: edge(10 + i),
      durNs: d,
    }));
    const o = await openLayout(await buildFormat4Report([spansRequest(few)]));
    try {
      const [row] = o.db.rows(`SELECT resource_name AS r FROM spans LIMIT 1`);
      const resource = String(Reflect.get(row ?? {}, 'r'));
      // 3, 4 and 5 are at most 5; buckets would count 6 with 5 when they share one, so the exact answer pins the path
      expect(await o.ds.percentileOf('svc-a', resource, 5)).toBe(75);
      expect(/span_rollups/.test(o.db.connector.requests.map((r) => r.sql).join('\n'))).toBe(false);
    } finally {
      o.close();
    }
  });
});

describe('resourceValues under a long window', () => {
  const KEYS = ['service.name', 'run.id', 'host.name', 'no.such.key'] as const;
  test.each(KEYS.flatMap((key) => [true, false].map((windowed) => ({ key, windowed }))))(
    '$key with window $windowed is the same list from rollups, raw files and a mix',
    async ({ key, windowed }) => {
      const answers: unknown[] = [];
      for (const layout of [layouts.A, layouts.B, layouts.C]) {
        const o = await openedOf(layout, 0n);
        answers.push(
          plain(await o.ds.resourceValues(key, { window: windowed ? longWindow(o.epoch) : null })),
        );
      }
      expect(answers[0]).toEqual(answers[2]);
      expect(answers[1]).toEqual(answers[2]);
    },
    60_000,
  );

  test('a short-range report with no window lists the same values from rollups and raw files', async () => {
    const few = ['svc-a', 'svc-b'].map((svc, i) => ({
      id: 800 + i,
      trace: 1,
      svc,
      run: `r${i}`,
      name: 'few',
      startNs: edge(10 + i),
      durNs: 5n,
    }));
    const rich = await buildFormat4Report([spansRequest(few)], {
      config: { writer: { statisticsKeys: [...STATISTICS_KEYS] } },
    });
    const answers: unknown[] = [];
    for (const f of [rich, withoutRollups(rich)]) {
      const o = await openLayout(f);
      try {
        answers.push(
          plain(await o.ds.resourceValues('service.name', { window: null })),
          plain(await o.ds.resourceValues('run.id', { window: null })),
        );
        // a report whose whole range is short never reads a rollup (spec 6.3), the rollups being there or not
        expect(o.db.connector.requests.some((r) => /_rollups/.test(r.sql))).toBe(false);
      } finally {
        o.close();
      }
    }
    expect(answers.slice(0, 2)).toEqual(answers.slice(2));
    expect(answers[0]).toMatchObject({ values: ['svc-a', 'svc-b'] });
  });

  test('the rollups answer for a dimension and the raw files for a key that is not one', async () => {
    const sqlOf = async (layout: Layout, key: string): Promise<string> => {
      const o = await openLayout(layout.fixture);
      try {
        await o.ds.resourceValues(key, { window: longWindow(o.epoch) });
        return o.db.connector.requests.map((r) => r.sql).join('\n');
      } finally {
        o.close();
      }
    };
    expect(await sqlOf(layouts.A, 'service.name')).toMatch(/FROM "span_rollups"/);
    expect(await sqlOf(layouts.A, 'service.name')).not.toMatch(/FROM "spans"/);
    expect(await sqlOf(layouts.A, 'no.such.key')).toMatch(/FROM "spans"/);
    expect(await sqlOf(layouts.B, 'service.name')).not.toMatch(/span_rollups/);
  });
});

describe('a report without spans or without logs', () => {
  const stamped = (): Promise<Format4Fixture> =>
    import('../../test-support/rollup-fixture.js').then(({ logsOf }) =>
      buildFormat4Report([logsOf([{ svc: 'a', run: 'r', timeNs: edge(10), severity: 9 }])]),
    );

  test.each([
    ['with log_rollups and no span_rollups', (f: Format4Fixture) => f, true],
    ['without rollups (format 4)', withoutRollups, false],
  ] as const)('a logs-only report %s answers under a long window', async (_label, shape, rollups) => {
    const fixture = shape(await stamped());
    const files = fixture.manifest.partitions.flatMap((p) => Object.keys(p.files));
    expect(files.includes('log_rollups')).toBe(rollups);
    expect(files.includes('span_rollups')).toBe(false);
    const o = await openLayout(fixture);
    try {
      const w = longWindow(o.epoch);
      expect(
        await o.ds.querySpans(spanQuery({ needs: ['total', 'timeline', 'facets', 'durations'], window: w })),
      ).toMatchObject({ total: 0 });
      // traces mode bypasses the early exit of a spans request without files
      for (const condition of [null, 'name == "x"', 'Len(name) > 7']) {
        expect(
          await o.ds.querySpans(
            spanQuery({
              mode: 'traces',
              sort: { column: 'start', dir: 'asc' },
              needs: ['rows', 'total'],
              window: w,
              condition,
            }),
          ),
        ).toMatchObject({ total: 0, rows: [] });
      }
      expect((await o.ds.services({ window: w, condition: null, limit: 5 })).services).toEqual([]);
      const logs = await o.ds.queryLogs(logQuery({ window: w, needs: ['total', 'timeline', 'facets'] }));
      expect(logs.total).toBe(1);
      expect(logs.buckets.total('info')).toBe(1);
      expect(plain(await o.ds.resourceValues('service.name', { window: w }))).toMatchObject({
        values: ['a'],
      });
      expect(plain(await o.ds.resourceValues('service.name', { window: null }))).toMatchObject({
        values: ['a'],
      });
    } finally {
      o.close();
    }
  });
});
