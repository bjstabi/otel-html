import { Query } from '@uwdata/mosaic-sql';
import { beforeAll, describe, expect, test } from 'vitest';
import type { ManifestV4 } from '../../../src/format/manifest.js';
import { bucketValue } from '../../../src/format/parquet/duration-bucket.js';
import { CORE_LOG_FACETS, CORE_SPAN_FACETS } from '../../../src/query/sql/facets.js';
import { buildFilter } from '../../../src/query/sql/filter.js';
import {
  BAND_KEY,
  facetKeyOf,
  groupKeyOf,
  measuresRelation,
  readsOf,
  rollupDurationBinsQuery,
  rollupDurationsQuery,
  rollupFacetsQuery,
  rollupGroupsQuery,
  rollupTimelineQuery,
  rollupTotalQuery,
  SERVICE_KEY,
  STATUS_KEY,
  splitFiles,
  timeKey,
} from '../../../src/query/sql/rollup.js';
import { bucketSpec } from '../../../src/query/sql/time.js';
import { openTestDb } from '../../../test-support/duckdb-node.js';
import { buildLayouts, E0, edge, GRAIN } from '../../../test-support/rollup-fixture.js';

type Layouts = Awaited<ReturnType<typeof buildLayouts>>;
let layouts: Layouts;
beforeAll(async () => {
  layouts = await buildLayouts();
}, 120_000);

const filterOf = (manifest: ManifestV4, table: 'spans' | 'logs', condition: string | null) =>
  buildFilter({
    manifest,
    table,
    condition,
    text: '',
    window: {
      start: Number(E0 - BigInt(manifest.epochUnixNano)),
      end: Number(edge(300) - BigInt(manifest.epochUnixNano)),
    },
    long: true,
  });

const rollupPathsOf = (m: ManifestV4, table: 'span_rollups' | 'log_rollups'): string[] =>
  m.partitions.flatMap((p) => (p.files[table] === undefined ? [] : [p.files[table].path]));

describe('splitFiles', () => {
  test('a rollup lacking a read dimension sends its partition to raw; a format-4 partition is raw', () => {
    const { A, B, C } = layouts;
    for (const [layout, expected] of [
      [A, { rollup: 4, raw: 0 }],
      [B, { rollup: 0, raw: 4 }],
      [C, { rollup: 3, raw: 1 }],
    ] as const) {
      const m = layout.fixture.manifest;
      const { filter } = filterOf(m, 'spans', null);
      // the run.id of the statistics keys: C's weak rollup (partition 0) does not hold it
      const split = splitFiles(m, 'spans', filter.files, new Set(['resource:run.id']), {
        durations: false,
        rawOnly: false,
      });
      expect({ rollup: split.rollup.length, raw: split.raw.length }, layout.name).toEqual(expected);
    }
  });

  test('a dimension of every rollup (the core facets) is answered from all of them, whatever the layout', () => {
    const m = layouts.C.fixture.manifest;
    const { filter } = filterOf(m, 'spans', null);
    const split = splitFiles(m, 'spans', filter.files, new Set(['service_name', 'status_code']), {
      durations: true,
      rawOnly: false,
    });
    expect(split.raw).toEqual([]);
    expect(split.rollup).toEqual(rollupPathsOf(m, 'span_rollups'));
  });

  test('an attribute no rollup holds sends every partition to raw', () => {
    const m = layouts.A.fixture.manifest;
    const { filter } = filterOf(m, 'spans', null);
    const split = splitFiles(m, 'spans', filter.files, new Set(['attr:http.route']), {
      durations: false,
      rawOnly: false,
    });
    expect(split.rollup).toEqual([]);
    expect(split.raw).toEqual(filter.files.files);
  });

  test('rawOnly sends every file to raw', () => {
    const m = layouts.A.fixture.manifest;
    const { filter } = filterOf(m, 'spans', null);
    const split = splitFiles(m, 'spans', filter.files, new Set(), { durations: false, rawOnly: true });
    expect(split).toEqual({ rollup: [], raw: filter.files.files });
  });

  test('a rollup without the duration-bucket rule does not answer a request for durations', () => {
    const m = structuredClone(layouts.A.fixture.manifest);
    for (const p of m.partitions) {
      const r = p.files.span_rollups;
      if (r?.rollup !== undefined) delete r.rollup.durationBuckets;
    }
    const { filter } = filterOf(m, 'spans', null);
    const reads = new Set(['service_name']);
    expect(splitFiles(m, 'spans', filter.files, reads, { durations: true, rawOnly: false }).rollup).toEqual(
      [],
    );
    expect(splitFiles(m, 'spans', filter.files, reads, { durations: false, rawOnly: false }).raw).toEqual([]);
  });

  test('statistics prune a rollup only once its dimensions are known to hold the key: "no value" never drops a partition', () => {
    const m = layouts.C.fixture.manifest;
    const weak = m.partitions.find((p) => p.files.span_rollups?.values['resource:run.id']?.length === 0);
    expect(weak, 'the mixed layout records "no value" for the key it lacks').toBeDefined();
    const { filter, hints } = filterOf(m, 'spans', 'resource.attributes["run.id"] == "r1"');
    const split = splitFiles(m, 'spans', filter.files, new Set(['resource:run.id']), {
      durations: false,
      rawOnly: false,
      prune: { hints, window: filter.window, long: true },
    });
    const base = weak?.files.spans?.path ?? '';
    // r1 is written in partition 0, which is the weak one: it is read raw although its rollup says no value
    expect(filter.files.files).toContain(base);
    expect(split.raw).toContain(base);
    // the others are pruned by their statistics, not read
    expect(split.rollup).toEqual([]);
    // the same hint on a rich rollup does prune by statistics
    const rich = layouts.A.fixture.manifest;
    const f2 = filterOf(rich, 'spans', 'resource.attributes["run.id"] == "r2"');
    const s2 = splitFiles(rich, 'spans', f2.filter.files, new Set(['resource:run.id']), {
      durations: false,
      rawOnly: false,
      prune: { hints: f2.hints, window: f2.filter.window, long: true },
    });
    expect(s2.raw).toEqual([]);
    expect(s2.rollup.length).toBeGreaterThan(0);
    expect(s2.rollup.length).toBeLessThan(rollupPathsOf(rich, 'span_rollups').length);
  });
});

describe('a rollup written before service.name was a dimension', () => {
  test('a condition on it reads the raw file; the other dimensions still answer from the rollup', () => {
    const m = structuredClone(layouts.A.fixture.manifest);
    for (const p of m.partitions) {
      const d = p.files.span_rollups?.rollup;
      if (d !== undefined) d.dimensions = d.dimensions.filter((x) => x !== 'resource:service.name');
    }
    const { filter } = filterOf(m, 'spans', null);
    const opts = { durations: false, rawOnly: false };
    const named = splitFiles(m, 'spans', filter.files, new Set(['resource:service.name']), opts);
    expect(named.rollup).toEqual([]);
    expect(named.raw).toEqual(filter.files.files);
    expect(splitFiles(m, 'spans', filter.files, new Set(['service_name']), opts).raw).toEqual([]);
  });
});

describe('measuresRelation', () => {
  const both = () => {
    const m = layouts.C.fixture.manifest;
    const { filter } = filterOf(m, 'spans', 'name == "GET /a"');
    const rollup = rollupPathsOf(m, 'span_rollups').slice(1);
    const raw = filter.files.files.filter((p) => !rollup.some((r) => r.includes(p.split('/')[2] ?? '#')));
    return { filter, split: { rollup, raw }, m };
  };

  test('applies the predicate in both branches', () => {
    const { filter, split } = both();
    const rel = measuresRelation(filter, 'spans', split, [SERVICE_KEY], true);
    expect(String(rel).match(/"name" = 'GET \/a'/g)).toHaveLength(2);
    expect(String(rel)).toContain('UNION ALL');
    expect(String(rel)).toContain('FROM "span_rollups"');
    expect(String(rel)).toContain('FROM "spans"');
  });

  test('has the same columns in both branches, durations when asked', () => {
    const { filter, split } = both();
    const text = String(measuresRelation(filter, 'spans', split, [SERVICE_KEY, STATUS_KEY], true));
    expect(text.match(/"duration_bucket"/g)?.length).toBeGreaterThanOrEqual(2);
    const lean = String(measuresRelation(filter, 'spans', split, [SERVICE_KEY], false));
    expect(lean).not.toContain('duration_');
    expect(lean).not.toContain('"duration_ns"');
  });

  test('a branch with no file is left out; no file at all reads nothing', () => {
    const { filter } = both();
    const onlyRaw = String(
      measuresRelation(filter, 'spans', { rollup: [], raw: filter.files.files }, [], false),
    );
    expect(onlyRaw).not.toContain('span_rollups');
    const onlyRollup = String(
      measuresRelation(filter, 'spans', { rollup: ['x/span_rollups.parquet'], raw: [] }, [], false),
    );
    expect(onlyRollup).not.toContain('FROM "spans"');
    const none = String(measuresRelation(filter, 'spans', { rollup: [], raw: [] }, [], false));
    expect(none).toMatch(/FALSE/);
  });

  test('refuses a window that is not long', () => {
    const { filter, split } = both();
    expect(() => measuresRelation({ ...filter, long: false }, 'spans', split, [], false)).toThrow(/long/);
  });

  test('the logs relation holds the keys and n', () => {
    const m = layouts.A.fixture.manifest;
    const { filter } = filterOf(m, 'logs', null);
    const rollup = rollupPathsOf(m, 'log_rollups');
    const text = String(
      measuresRelation(
        filter,
        'logs',
        { rollup, raw: [] },
        [timeKey('logs', BigInt(m.epochUnixNano)), BAND_KEY],
        false,
      ),
    );
    expect(text).toContain('FROM "log_rollups"');
    expect(text).not.toContain('duration');
  });
});

describe('the statements over a relation', () => {
  const [firstFacet] = CORE_SPAN_FACETS;
  if (firstFacet === undefined) throw new Error('no core facet');
  const rel = Query.from('m').select('*');
  const spec = bucketSpec({ start: 0, end: 10 * Number(GRAIN) }, null, undefined, { epoch: 0n });

  test('total, timeline, facets, groups and durations are aggregates of the relation', () => {
    expect(String(rollupTotalQuery(rel))).toMatch(/sum\(n\)/);
    expect(String(rollupTimelineQuery(rel, spec, 0n, null, { latency: false }))).not.toContain(
      'duration_bucket',
    );
    expect(String(rollupTimelineQuery(rel, spec, 0n, null))).toContain('duration_bucket');
    expect(String(rollupTimelineQuery(rel, spec, 0n, SERVICE_KEY, { only: ['a', "b'c"] }))).toContain(
      "'b''c'",
    );
    expect(String(rollupFacetsQuery(rel, [facetKeyOf(firstFacet)], 7))).toMatch(/<= 7/);
    expect(String(rollupGroupsQuery(rel, [groupKeyOf('service.name')], { limit: 4 }))).toMatch(/LIMIT 4/);
    expect(String(rollupDurationsQuery(rel))).toContain('quantiles');
    expect(String(rollupDurationBinsQuery(rel, []))).toContain('FALSE');
  });

  test('every core facet names what it reads', () => {
    expect(CORE_SPAN_FACETS.map((f) => f.reads)).toEqual([
      'service_name',
      'name',
      'kind',
      'status_code',
      'resource_name',
      'scope_name',
      'resource:host.name',
      'resource:deployment.environment.name',
    ]);
    expect(CORE_LOG_FACETS.map((f) => f.reads)).toEqual([
      'severity_number',
      'service_name',
      'host_name',
      'scope_name',
      'event_name',
      'has_trace',
    ]);
    expect(readsOf([SERVICE_KEY, timeKey('spans', 0n), BAND_KEY])).toEqual([
      'service_name',
      'severity_number',
    ]);
    expect(groupKeyOf('http.route').reads).toBe('attr:http.route');
    expect(groupKeyOf('service.name').reads).toBe('service_name');
  });
});

describe('the representative duration of a bucket', () => {
  test('the SQL of the percentiles is bucketValue, for every bucket', async () => {
    const db = await openTestDb();
    try {
      db.exec(
        'CREATE TABLE m (duration_bucket INTEGER, n BIGINT, duration_sum BIGINT, duration_min BIGINT, duration_max BIGINT)',
      );
      const buckets = Array.from({ length: 505 }, (_, i) => i - 1);
      // one bucket per statement: min and max wide enough not to clamp
      for (let i = 0; i < buckets.length; i += 100) {
        db.exec(
          `INSERT INTO m VALUES ${buckets
            .slice(i, i + 100)
            .map((b) => `(${b}, 1, 1, -9000000000000000000, 9000000000000000000)`)
            .join(', ')}`,
        );
      }
      const rel = Query.from('m').select('*');
      for (const b of [-1, 0, 1, 7, 8, 100, 159, 400, 503]) {
        db.exec(`CREATE OR REPLACE TABLE one AS SELECT * FROM m WHERE duration_bucket = ${b}`);
        const [row] = db.rows(String(rollupDurationsQuery(Query.from('one').select('*'))));
        const q = Array.from(Reflect.get(row ?? {}, 'quantiles') as ArrayLike<number>);
        for (const got of q)
          expect(got).toBeCloseTo(
            bucketValue(b),
            6 - Math.max(0, Math.floor(Math.log10(bucketValue(b) || 1))),
          );
      }
      void rel;
    } finally {
      db.close();
    }
  });
});
