import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ManifestV4 } from '../../src/format/manifest.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import { recordedFacetKeys } from '../../src/viewer/data/recorded-keys.js';
import type { SpanQuery } from '../../src/viewer/data/results.js';
import { KEY_CAP, keyLogs, keySpans, keysConfig } from '../../test-support/attribute-key-fixture.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';

vi.setConfig({ testTimeout: 60_000 });

const SORT = {
  spans: { column: 'start', dir: 'desc' },
  logs: { column: 'time', dir: 'desc' },
} as const;
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

interface Opened {
  ds: DataSource;
  db: TestDb;
  prepared: string[];
}

async function open(f: Format4Fixture): Promise<Opened> {
  const db = await openFixtureDb(f);
  const prepared: string[] = [];
  const engine = mosaicQueryEngine(
    createCoordinator(db.connector, silentLogger),
    db,
    true,
    undefined,
    async (paths) => {
      prepared.push(...paths);
    },
  );
  return { ds: createDuckDbDataSource({ engine, manifest: f.manifest }), db, prepared };
}

/** What the empty state does without a record: every key, unfiltered (`facet-chart.tsx`). */
async function scanned(ds: DataSource, table: 'spans' | 'logs'): Promise<string[]> {
  const all = { limit: 1, condition: null, text: '', window: null, facetKeys: null } as const;
  const f =
    table === 'spans'
      ? (
          await ds.querySpans({
            ...all,
            mode: 'spans',
            sort: SORT.spans,
            groupBy: null,
            measureBy: null,
            needs: ['facets'],
          } satisfies SpanQuery)
        ).facets
      : (await ds.queryLogs({ ...all, mode: 'logs', sort: SORT.logs, needs: ['facets'] })).facets;
  return [...new Set([...f.keys(), ...f.pinned])];
}

/** The report with the record taken off `table`'s file of partition `n`. */
function without(f: Format4Fixture, table: 'spans' | 'logs', n: number): Format4Fixture {
  const manifest: ManifestV4 = {
    ...f.manifest,
    partitions: f.manifest.partitions.map((p) => {
      const file = p.files[table];
      if (p.n !== n || file === undefined) return p;
      const { attributeKeys: _dropped, ...kept } = file;
      return { ...p, files: { ...p.files, [table]: kept } };
    }),
  };
  return { ...f, manifest };
}

const requests = () => [keySpans(0), keyLogs(0), keySpans(1), keyLogs(1)];
let flushed: Format4Fixture;
let compacted: Format4Fixture;
const opened: Opened[] = [];
const track = async (f: Format4Fixture): Promise<Opened> => {
  const o = await open(f);
  opened.push(o);
  return o;
};

beforeAll(async () => {
  flushed = await buildFormat4Report(requests(), {
    config: keysConfig(),
    close: false,
    keepAttributeKeys: true,
  });
  compacted = await buildFormat4Report(requests(), {
    config: keysConfig(),
    close: true,
    keepAttributeKeys: true,
  });
});
afterAll(() => {
  for (const o of opened) o.db.close();
});

describe('the keys the manifest records are the keys the scan finds', () => {
  for (const [label, get] of [
    ['flushed partitions', () => flushed],
    ['a compacted partition', () => compacted],
  ] as const) {
    for (const table of ['spans', 'logs'] as const) {
      test(`${label}, ${table}: same list, with no ${table} file prepared or read`, async () => {
        const f = get();
        const o = await track(f);
        const sent = o.db.connector.requests.length;
        const recorded = recordedFacetKeys(f.manifest, table);
        expect(o.prepared).toEqual([]);
        expect(o.db.connector.requests).toHaveLength(sent);
        const scan = await scanned(o.ds, table);
        expect(o.prepared.some((p) => p.endsWith(`${table}.parquet`))).toBe(true);
        expect(recorded).not.toBeNull();
        expect(recorded).toEqual(scan);
      });
    }
  }

  test('the fixtures exceed the key cap, tie at it, and mix kinds', async () => {
    const keys = recordedFacetKeys(flushed.manifest, 'spans') ?? [];
    const core = new Set([
      'service.name',
      'span.name',
      'span.kind',
      'status.code',
      'resource',
      'instrumentation_scope.name',
      'host.name',
      'deployment.environment.name',
    ]);
    const attrs = keys.filter((k) => !core.has(k));
    expect(attrs).toHaveLength(KEY_CAP);
    const all = new Set(
      flushed.manifest.partitions.flatMap((p) => Object.keys(p.files.spans?.attributeKeys ?? {})),
    );
    expect(all.size).toBeGreaterThan(KEY_CAP * 2);
    expect(all.has('mx')).toBe(true);
    expect(all.has('nil')).toBe(false);
    expect(all.has('obj')).toBe(false);
    expect(all.has('arr')).toBe(false);
    expect(all.has('by')).toBe(false);
  });

  test('one file without the record: the scan answers, with the same list', async () => {
    for (const table of ['spans', 'logs'] as const) {
      const n = flushed.manifest.partitions.find((p) => p.files[table] !== undefined)?.n ?? -1;
      const f = without(flushed, table, n);
      expect(recordedFacetKeys(f.manifest, table)).toBeNull();
      const o = await track(f);
      expect(await scanned(o.ds, table)).toEqual(recordedFacetKeys(flushed.manifest, table));
    }
  });
});

describe('a report whose core keys have no values', () => {
  test('lists the same keys as the scan, the core keys that lack values last in the scan', async () => {
    const f = await buildFormat4Report([keySpans(0)], {
      config: keysConfig(),
      close: false,
      keepAttributeKeys: true,
    });
    const o = await track(f);
    const scan = await scanned(o.ds, 'spans');
    const recorded = recordedFacetKeys(f.manifest, 'spans') ?? [];
    expect([...recorded].sort()).toEqual([...scan].sort());
    expect(recorded.filter((k) => k.startsWith('k'))).toEqual(scan.filter((k) => k.startsWith('k')));
  });
});
