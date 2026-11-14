import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { CATALOGUE, type CatalogueContext, type CatalogueEntry } from '../../src/viewer/data/catalogue.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import type { LogNeed, SpanNeed } from '../../src/viewer/data/results.js';
import { openCountingEngine } from '../../test-support/scaling/counting-engine.js';
import { BASE, buildScalingReport, type ScalingReport } from '../../test-support/scaling/generator.js';

const SQL_DIR = 'src/query/sql';

/** The names of the exported builders; hoisted because the mock factories below run before the module body. */
const BUILDER = vi.hoisted(() => /(Query|Statement|Queries)$/);
/** Every builder the data layer calls through a `src/query/sql` module, by exported name. */
const recorded = vi.hoisted(() => new Set<string>());

async function recording<T extends object>(load: () => Promise<T>): Promise<T> {
  const mod = await load();
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mod)) {
    out[name] =
      typeof value === 'function' && BUILDER.test(name)
        ? (...args: unknown[]) => {
            recorded.add(name);
            return value(...args);
          }
        : value;
  }
  return out as T;
}

vi.mock('../../src/query/sql/spans.js', () =>
  recording(() => vi.importActual('../../src/query/sql/spans.js')),
);
vi.mock('../../src/query/sql/logs.js', () => recording(() => vi.importActual('../../src/query/sql/logs.js')));
vi.mock('../../src/query/sql/points.js', () =>
  recording(() => vi.importActual('../../src/query/sql/points.js')),
);
vi.mock('../../src/query/sql/facets.js', () =>
  recording(() => vi.importActual('../../src/query/sql/facets.js')),
);
vi.mock('../../src/query/sql/rollup.js', () =>
  recording(() => vi.importActual('../../src/query/sql/rollup.js')),
);
vi.mock('../../src/query/sql/residual.js', () =>
  recording(() => vi.importActual('../../src/query/sql/residual.js')),
);

const SPAN_NEEDS: Record<SpanNeed, true> = {
  rows: true,
  facets: true,
  timeline: true,
  buckets: true,
  total: true,
  durations: true,
  groups: true,
};
const LOG_NEEDS: Record<LogNeed, true> = { rows: true, facets: true, timeline: true, total: true };

const SPAN_GROUPS = [
  'total',
  'buckets',
  'timeline',
  'facets.core',
  'facets.attr',
  'groups',
  'durations',
  'services',
];
const SPAN_CONDITIONS = ['sortkey', 'statkey', 'attr', 'text'];
const LOG_GROUPS = ['timeline', 'facets.core', 'facets.attr', 'rows', 'traces', 'timeline.statkey'];
const both = (id: string): string[] => [`${id}.short`, `${id}.long`];
const PLAN_IDS = [
  ...SPAN_GROUPS.flatMap((g) => both(`spans.${g}`)),
  ...SPAN_CONDITIONS.flatMap((c) => both(`spans.total.${c}`)),
  'spans.total.traces.long',
  'spans.rows.short',
  'spans.rows.long',
  'spans.rows.all',
  'percentile.short',
  'percentile.long',
  'traces.list.all',
  'traces.list.all.long',
  'traces.list.short',
  'traces.list.long',
  'traces.list.statkey.long',
  'traces.list.attr.long',
  'trace.get',
  'trace.share',
  'trace.has',
  'trace.logs',
  'log.get',
  'log.surrounding',
  ...LOG_GROUPS.flatMap((g) => both(`logs.${g}`)),
  'logs.timeline.text.long',
  'logs.total.short',
  'logs.total.long',
  'logs.total.traces.long',
  'resourceValues.all',
  'resourceValues.all.short',
  'resourceValues.short',
  'resourceValues.long',
  'patterns',
  'metrics.catalog',
  'metrics.showOptions',
  'metrics.query.short',
  'metrics.query.long',
  'metrics.query.summary',
  'metrics.runQuery',
  'metrics.forResources',
  'metrics.points',
];

describe('the catalogue', () => {
  test('ids are unique and every id of the plan table exists', () => {
    const ids = CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PLAN_IDS.filter((id) => !ids.includes(id))).toEqual([]);
  });

  test('every SpanNeed and LogNeed is asked by an entry', () => {
    const asked = new Set(CATALOGUE.flatMap((e) => e.needs ?? []));
    expect(Object.keys(SPAN_NEEDS).filter((n) => !asked.has(n as SpanNeed))).toEqual([]);
    expect(Object.keys(LOG_NEEDS).filter((n) => !asked.has(n as LogNeed))).toEqual([]);
  });

  test('every exported builder of src/query/sql is named by an entry', async () => {
    const named = new Set(CATALOGUE.flatMap((e) => e.builders));
    const exported: string[] = [];
    for (const file of readdirSync(SQL_DIR).filter((f) => f.endsWith('.ts'))) {
      const mod: Record<string, unknown> = await vi.importActual(
        `../../${SQL_DIR}/${file.replace(/\.ts$/, '.js')}`,
      );
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === 'function' && BUILDER.test(name)) exported.push(`${file}:${name}`);
      }
    }
    const missing = exported.filter((n) => !named.has(n.split(':')[1] ?? ''));
    expect(missing).toEqual([]);
  });

  // The scan sees only `Query.*(` calls: a raw SQL string is invisible to it. The one left, `DROP TABLE` in
  // src/viewer/data/residual.ts, is an engine statement that frees a temp table, not a request.
  test('no statement is built outside src/query/sql', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          /\.tsx?$/.test(e.name) &&
          /\bQuery\.(from|select|with|union)\(/.test(readFileSync(p, 'utf8'))
        )
          offenders.push(p);
      }
    };
    walk('src/viewer');
    walk('src/host');
    expect(offenders).toEqual([]);
  });

  test('the catalogue names no CI key, widget kind or dashboard', () => {
    const text = JSON.stringify(CATALOGUE.map((e) => [e.id, e.needs, e.builders]));
    expect(text).not.toMatch(/cicd|widget|dashboard/i);
    expect(readFileSync('src/viewer/data/catalogue.ts', 'utf8')).not.toMatch(/cicd|widget|dashboard/i);
  });
});

describe('each entry runs exactly the builders it names', () => {
  // a long window needs the sparse spacing (a window of two partitions six hours apart); the others use the dense one
  const reports = new Map<'dense' | 'sparse', ScalingReport>();
  let close: () => Promise<void>;
  let make: (spacing: 'dense' | 'sparse') => ReturnType<typeof createDuckDbDataSource>;

  beforeAll(async () => {
    const closers: (() => Promise<void>)[] = [];
    const engines = new Map<'dense' | 'sparse', Awaited<ReturnType<typeof openCountingEngine>>>();
    for (const spacing of ['dense', 'sparse'] as const) {
      const report = await buildScalingReport({ ...BASE, spacing });
      reports.set(spacing, report);
      const counting = await openCountingEngine(report.dir, report.manifest);
      engines.set(spacing, counting);
      closers.push(async () => {
        await counting.close();
        await report.close();
      });
    }
    close = async () => {
      for (const c of closers) await c();
    };
    make = (spacing) => {
      const report = reports.get(spacing);
      const counting = engines.get(spacing);
      if (report === undefined || counting === undefined) throw new Error(`no ${spacing} report`);
      return createDuckDbDataSource({ engine: counting.engine, manifest: report.manifest });
    };
  }, 180_000);
  afterAll(async () => {
    await close();
  });

  test.each(CATALOGUE.map((e): [string, CatalogueEntry] => [e.id, e]))(
    '%s',
    async (_id, entry) => {
      recorded.clear();
      // a fresh data source per entry: the metric catalog and the trace are memoised per source
      const ds = make(entry.spacing);
      const report = reports.get(entry.spacing);
      if (report === undefined) throw new Error(`no ${entry.spacing} report`);
      const ctx: CatalogueContext = { window: entry.window ? report.window : null, ids: report.ids };
      await entry.run(ds, ctx);
      expect([...recorded].sort()).toEqual([...entry.builders].sort());
    },
    60_000,
  );
});
