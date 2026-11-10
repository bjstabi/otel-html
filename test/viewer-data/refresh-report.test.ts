import { describe, expect, test } from 'vitest';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { partitionFilePath, partitionWrapperPath } from '../../src/format/paths.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { toBase64 } from '../../src/viewer/data/engine/bytes.js';
import type { Engine } from '../../src/viewer/data/engine/start.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';
import { isGoneFile, refreshReport } from '../../src/viewer/data/refresh-report.js';
import type { ScriptLoader } from '../../src/viewer/data/script-loader.js';

const BASE = 'https://site.example/report/';
const file = (n: number, table: 'spans' | 'logs') => ({
  path: partitionFilePath(n, table),
  bytes: 1,
  rows: 1,
  timeMin: null,
  timeMax: null,
  values: {},
});

const config = {
  viewer: { listCap: 10_000, theme: 'system', defaultDashboard: 'fusion', home: 'traces' },
  dashboards: [],
  views: [],
};

/** A manifest listing the given partitions, each with a spans and a logs file. */
const manifestOf = (ns: number[], format: 'local' | 'site' = 'site'): ManifestV4 =>
  ({
    formatVersion: 4,
    otelHtmlVersion: '0.3.0',
    title: 't',
    epochUnixNano: '1700000000000000000',
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:01.000Z',
    complete: false,
    range: null,
    totals: { spans: 3, logs: 2, metrics: 0 },
    partitions: ns.map((n) => ({
      n,
      source: `job:${n}`,
      files: { spans: file(n, 'spans'), logs: file(n, 'logs') },
    })),
    statisticsKeys: { spans: [], logs: [], points: [], traces: [], patterns: [] },
    engine: { version: '1.32.0', format, assetsBase: 'assets/' },
    config,
  }) as unknown as ManifestV4;

interface Calls {
  url: [string, string][];
  buffer: string[];
  drop: string[];
  statements: string[];
  clearCache: number;
  queries: number;
}

function fakes(format: 'local' | 'site', failStatement?: (statement: string, nth: number) => boolean) {
  const calls: Calls = { url: [], buffer: [], drop: [], statements: [], clearCache: 0, queries: 0 };
  const engine = {
    format,
    db: {
      registerFileURL: async (name: string, url: string) => void calls.url.push([name, url]),
      registerFileBuffer: async (name: string) => void calls.buffer.push(name),
      dropFile: async (name: string) => void calls.drop.push(name),
    },
    connection: {
      query: async (s: string) => {
        calls.statements.push(s);
        if (failStatement?.(s, calls.statements.length)) throw new Error('view failed');
      },
    },
  } as unknown as Engine;
  const queryEngine = {
    tempTables: true,
    query: async () => {
      calls.queries += 1;
      return { numRows: 0, toArray: () => [] };
    },
    exec: async () => {},
    registerText: async () => {},
    close: async () => {},
    clearCache() {
      calls.clearCache += 1;
    },
  } as unknown as QueryEngine;
  return { calls, engine, queryEngine };
}

function loaderOf(manifest: unknown): ScriptLoader & { paths: string[] } {
  const paths: string[] = [];
  const payload = (key: string): unknown =>
    key === 'manifest' ? manifest : toBase64(new Uint8Array([80, 65, 82, 49]));
  return {
    paths,
    load: async (path, key) => {
      paths.push(path);
      return payload(key);
    },
  };
}

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const run = (
  f: ReturnType<typeof fakes>,
  previous: ManifestV4,
  next: unknown,
  loader = loaderOf(next),
  now = 1234,
) => refreshReport(f.engine, f.queryEngine, previous, { loader, baseUrl: BASE, logger }, () => now);

describe('refreshReport', () => {
  test('registers only the new partition files by URL, drops nothing, recreates the views, clears the cache once', async () => {
    const f = fakes('site');
    const next = manifestOf([0, 1]);
    const { dataSource, manifest } = await run(f, manifestOf([0]), next);
    expect(f.calls.url.map(([name]) => name)).toEqual([
      partitionFilePath(1, 'spans'),
      partitionFilePath(1, 'logs'),
    ]);
    expect(f.calls.url[0]?.[1]).toBe(new URL(partitionFilePath(1, 'spans'), BASE).href);
    expect(f.calls.drop).toEqual([]);
    expect(f.calls.statements).toHaveLength(5);
    expect(f.calls.clearCache).toBe(1);
    expect(manifest.partitions.map((p) => p.n)).toEqual([0, 1]);
    expect(dataSource?.manifest).toBe(manifest);
    await dataSource?.resourceValues('service.name').catch(() => undefined);
    expect(f.calls.queries).toBeGreaterThan(0);
  });

  test('asks the loader for data/manifest.js?r=<now>', async () => {
    const f = fakes('site');
    const loader = loaderOf(manifestOf([0]));
    await run(f, manifestOf([0]), manifestOf([0]), loader, 987);
    expect(loader.paths[0]).toBe('data/manifest.js?r=987');
  });

  test('a compaction registers the new partition and drops the paths gone', async () => {
    const f = fakes('site');
    await run(f, manifestOf([0, 1]), manifestOf([2]));
    expect(f.calls.url.map(([name]) => name)).toEqual([
      partitionFilePath(2, 'spans'),
      partitionFilePath(2, 'logs'),
    ]);
    expect(f.calls.drop.sort()).toEqual(
      [0, 1].flatMap((n) => [partitionFilePath(n, 'spans'), partitionFilePath(n, 'logs')]).sort(),
    );
  });

  test('a local report registers buffers loaded through the wrappers', async () => {
    const f = fakes('local');
    const loader = loaderOf(manifestOf([0, 1], 'local'));
    await run(f, manifestOf([0], 'local'), manifestOf([0, 1], 'local'), loader);
    expect(f.calls.buffer).toEqual([partitionFilePath(1, 'spans'), partitionFilePath(1, 'logs')]);
    expect(loader.paths).toContain(new URL(partitionWrapperPath(1, 'spans'), BASE).href);
  });

  test('a format 3 manifest rejects with the D12 message and changes nothing', async () => {
    const f = fakes('site');
    await expect(run(f, manifestOf([0]), manifestV3())).rejects.toThrow(/format 3/i);
    expect(f.calls.url).toEqual([]);
    expect(f.calls.drop).toEqual([]);
    expect(f.calls.statements).toEqual([]);
    expect(f.calls.clearCache).toBe(0);
  });
});

function manifestV3() {
  return {
    formatVersion: 3,
    otelHtmlVersion: '0.2.0',
    title: 't',
    epochUnixNano: '1700000000000000000',
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:01.000Z',
    complete: true,
    range: null,
    totals: { spans: 0, logs: 0, metrics: 0 },
    decodedBytes: 0,
    chunks: [],
    rollups: [],
    traceShards: [],
    metricFiles: [],
    config: { ...config, viewer: { ...config.viewer, eagerBudgetBytes: 75_000_000 } },
  };
}

describe('refreshReport failures', () => {
  test('a failing dropFile is logged and the refresh still succeeds', async () => {
    const f = fakes('site');
    (f.engine.db as unknown as { dropFile: () => Promise<void> }).dropFile = async () => {
      throw new Error('drop failed');
    };
    const warnings: unknown[][] = [];
    const next = manifestOf([2]);
    const { manifest } = await refreshReport(
      f.engine,
      f.queryEngine,
      manifestOf([0]),
      {
        loader: loaderOf(next),
        baseUrl: BASE,
        logger: { ...logger, warn: (...a: unknown[]) => void warnings.push(a) },
      },
      () => 1,
    );
    expect(manifest.partitions.map((p) => p.n)).toEqual([2]);
    expect(warnings).toHaveLength(2);
    expect(f.calls.statements).toHaveLength(5);
    expect(f.calls.clearCache).toBe(1);
  });

  test('a failing registration rejects before any view or cache clear, and drops what this refresh added', async () => {
    const f = fakes('site');
    (f.engine.db as unknown as { registerFileURL: () => Promise<void> }).registerFileURL = async () => {
      throw new Error('register failed');
    };
    await expect(run(f, manifestOf([0]), manifestOf([1]))).rejects.toThrow('register failed');
    expect(f.calls.drop.sort()).toEqual([partitionFilePath(1, 'spans'), partitionFilePath(1, 'logs')].sort());
    expect(f.calls.statements).toHaveLength(5);
    expect(f.calls.clearCache).toBe(0);
  });
});

describe('refreshReport unchanged and rollback', () => {
  test('an unchanged manifest (same updatedAt, same files) touches nothing and returns no data source', async () => {
    const f = fakes('site');
    const previous = manifestOf([0, 1]);
    const result = await run(f, previous, manifestOf([0, 1]));
    expect(result.dataSource).toBeNull();
    expect(result.manifest).toBe(previous);
    expect(f.calls.url).toEqual([]);
    expect(f.calls.drop).toEqual([]);
    expect(f.calls.statements).toEqual([]);
    expect(f.calls.clearCache).toBe(0);
  });

  test('a later updatedAt over the same files is a change', async () => {
    const f = fakes('site');
    const next = { ...manifestOf([0]), updatedAt: '2026-11-06T00:00:09.000Z' };
    const result = await run(f, manifestOf([0]), next);
    expect(result.dataSource).not.toBeNull();
    expect(f.calls.statements).toHaveLength(5);
  });

  test('a view that fails restores the previous views, drops the new files and rethrows', async () => {
    const f = fakes('site', (_s, nth) => nth === 3);
    await expect(run(f, manifestOf([0]), manifestOf([1]))).rejects.toThrow('view failed');
    // 3 statements of the new manifest (the third failed), then the previous manifest's five views.
    expect(f.calls.statements).toHaveLength(8);
    const restored = f.calls.statements.slice(3);
    expect(restored.filter((s) => s.includes('000000'))).toHaveLength(2);
    expect(restored.some((s) => s.includes('000001'))).toBe(false);
    expect(f.calls.drop.sort()).toEqual([partitionFilePath(1, 'spans'), partitionFilePath(1, 'logs')].sort());
    expect(f.calls.clearCache).toBe(0);
  });

  test('a rollback that fails too is logged and the original error is the one thrown', async () => {
    const f = fakes('site', (_s, nth) => nth >= 3);
    const errors: unknown[][] = [];
    await expect(
      refreshReport(
        f.engine,
        f.queryEngine,
        manifestOf([0]),
        {
          loader: loaderOf(manifestOf([1])),
          baseUrl: BASE,
          logger: { ...logger, error: (...a: unknown[]) => void errors.push(a) },
        },
        () => 1,
      ),
    ).rejects.toThrow('view failed');
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('isGoneFile', () => {
  test('matches the engine message for a registered URL that answers 404', () => {
    expect(isGoneFile(new Error('HTTP error 404 Not Found: data/partitions/000000/spans.parquet'))).toBe(
      true,
    );
  });
  test('matches an OtelHtmlError built the way the query engine builds it', () => {
    const wrapped = new OtelHtmlError('invalid-report', {
      path: 'query',
      expected: 'a query the engine accepts',
      actual: 'HTTP error 404 Not Found: data/partitions/000000/spans.parquet',
      hint: 'SELECT 1',
    });
    expect(isGoneFile(wrapped)).toBe(true);
  });
  // Chromium's wording, measured in e2e/refresh.spec.ts: DuckDB-WASM reports neither the status nor "HTTP".
  test('matches the message Chromium produces for a registered file the site no longer serves', () => {
    const opened =
      "Invalid Error: Opening file 'data/partitions/000001/spans.parquet' failed with error: Failed to open file: data/partitions/000001/spans.parquet\n\nLINE 1: CREATE OR REPLACE VIEW \"spans\" AS SELECT * FROM read_parquet(['data/partitions/000000/spans.parquet', 'data...\n                                                        ^";
    expect(isGoneFile(new Error(opened))).toBe(true);
    const missing =
      'IO Error: No files found that match the pattern "data/partitions/000001/spans.parquet"\n\nLINE 1: SELECT "key", "value", "n" FROM (SELECT CASE...';
    expect(isGoneFile(new Error(missing))).toBe(true);
  });
  test('does not match a failed open for another reason, or a pattern named only in the SQL', () => {
    expect(isGoneFile(new Error("Opening file 'x' failed with error: Permission denied"))).toBe(false);
    expect(
      isGoneFile(
        new OtelHtmlError('invalid-report', {
          path: 'query',
          expected: 'a query the engine accepts',
          actual: 'Parser Error: syntax error',
          hint: "SELECT 'No files found that match the pattern'",
        }),
      ),
    ).toBe(false);
  });
  test('does not match a binder not-found, an HTTP 500, or a 404 inside the SQL', () => {
    expect(isGoneFile(new Error("Binder Error: Referenced column 'x' not found in FROM clause"))).toBe(false);
    expect(isGoneFile(new Error('Catalog Error: Function foo not found'))).toBe(false);
    expect(isGoneFile(new Error('HTTP error 500 Internal Server Error: data/x.parquet'))).toBe(false);
    expect(
      isGoneFile(
        new OtelHtmlError('invalid-report', {
          path: 'query',
          expected: 'a query the engine accepts',
          actual: 'Parser Error: syntax error',
          hint: "SELECT * FROM spans WHERE name = 'HTTP 404 Not Found'",
        }),
      ),
    ).toBe(false);
  });
  test('does not match a parser error or a non-error', () => {
    expect(isGoneFile(new Error('Parser Error: syntax error at or near "FROM"'))).toBe(false);
    expect(isGoneFile('nope')).toBe(false);
    expect(isGoneFile(undefined)).toBe(false);
  });
});
