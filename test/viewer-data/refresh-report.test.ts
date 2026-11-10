import { describe, expect, test } from 'vitest';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { partitionFilePath, partitionKey, partitionWrapperPath } from '../../src/format/paths.js';
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

function fakes(format: 'local' | 'site') {
  const calls: Calls = { url: [], buffer: [], drop: [], statements: [], clearCache: 0, queries: 0 };
  const engine = {
    format,
    db: {
      registerFileURL: async (name: string, url: string) => void calls.url.push([name, url]),
      registerFileBuffer: async (name: string) => void calls.buffer.push(name),
      dropFile: async (name: string) => void calls.drop.push(name),
    },
    connection: { query: async (s: string) => void calls.statements.push(s) },
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
  const registry = {
    take: async (key: string) => (key === 'manifest' ? manifest : toBase64(new Uint8Array([80, 65, 82, 49]))),
  };
  return {
    paths,
    load: async (path, key) => {
      paths.push(path);
      return registry.take(key);
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
) =>
  refreshReport(
    f.engine,
    f.queryEngine,
    previous,
    { loader, registry: { take: async () => next }, baseUrl: BASE, logger },
    () => now,
  );

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
    expect(dataSource.manifest).toBe(manifest);
    await dataSource.resourceValues('service.name').catch(() => undefined);
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
    expect(partitionKey(1, 'spans')).toBeTruthy();
  });

  test('a format 3 manifest rejects with the D12 message and changes nothing', async () => {
    const f = fakes('site');
    const v3 = { formatVersion: 3 };
    await expect(run(f, manifestOf([0]), { ...manifestV3() })).rejects.toThrow(/format 3/i);
    expect(f.calls.url).toEqual([]);
    expect(f.calls.drop).toEqual([]);
    expect(f.calls.statements).toEqual([]);
    expect(f.calls.clearCache).toBe(0);
    expect(v3.formatVersion).toBe(3);
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

describe('isGoneFile', () => {
  test('matches the engine message for a registered URL that answers 404', () => {
    expect(isGoneFile(new Error('HTTP error 404 Not Found: data/partitions/000000/spans.parquet'))).toBe(
      true,
    );
  });
  test('does not match a parser error or a non-error', () => {
    expect(isGoneFile(new Error('Parser Error: syntax error at or near "FROM"'))).toBe(false);
    expect(isGoneFile('nope')).toBe(false);
    expect(isGoneFile(undefined)).toBe(false);
  });
});
