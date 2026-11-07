import { DuckDBDataProtocol } from '@duckdb/duckdb-wasm';
import { expect, test } from 'vitest';
import type { ManifestV4 } from '../../src/format/manifest.js';
import type { Table } from '../../src/format/parquet/columns.js';
import { toBase64 } from '../../src/viewer/data/engine/bytes.js';
import { type RegisterProgress, registerPartitions } from '../../src/viewer/data/engine/files.js';
import type { Engine } from '../../src/viewer/data/engine/start.js';
import type { ScriptLoader } from '../../src/viewer/data/script-loader.js';

const file = (n: number, table: Table) => ({
  path: `data/partitions/${String(n).padStart(6, '0')}/${table}.parquet`,
  bytes: 1,
  rows: 1,
  timeMin: null,
  timeMax: null,
  values: {},
});

const twoPartitionManifest = {
  partitions: [0, 1].map((n) => ({
    n,
    source: `flush:${n}`,
    files: { spans: file(n, 'spans'), logs: file(n, 'logs') },
  })),
} as unknown as ManifestV4;

const PARQUET_BYTES = new Uint8Array([80, 65, 82, 49]);

interface FakeEngine extends Engine {
  calls: { registerFileURL: unknown[][]; registerFileBuffer: unknown[][]; exec: string[] };
}

function fakeEngine(format: 'local' | 'site'): FakeEngine {
  const calls = {
    registerFileURL: [] as unknown[][],
    registerFileBuffer: [] as unknown[][],
    exec: [] as string[],
  };
  const db = {
    registerFileURL: async (...a: unknown[]) => void calls.registerFileURL.push(a),
    registerFileBuffer: async (...a: unknown[]) => void calls.registerFileBuffer.push(a),
  };
  const connection = { query: async (s: string) => void calls.exec.push(s) };
  return { db, connection, format, calls } as unknown as FakeEngine;
}

function scriptedLoader(payloads: Record<string, string>): ScriptLoader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    load: async (path, key) => {
      calls.push(path);
      return payloads[key];
    },
  };
}

test('site registers each file by URL with range reads and creates the views', async () => {
  const engine = fakeEngine('site');
  const loader = scriptedLoader({});
  await registerPartitions(engine, twoPartitionManifest, { loader, baseUrl: 'https://h/r/index.html' });
  const entry = (n: string, t: string) => [
    `data/partitions/${n}/${t}.parquet`,
    `https://h/r/data/partitions/${n}/${t}.parquet`,
    DuckDBDataProtocol.HTTP,
    false,
  ];
  expect(engine.calls.registerFileURL).toEqual([
    entry('000000', 'spans'),
    entry('000000', 'logs'),
    entry('000001', 'spans'),
    entry('000001', 'logs'),
  ]);
  expect(loader.calls).toEqual([]);
  expect(engine.calls.exec.filter((s) => s.startsWith('CREATE OR REPLACE VIEW'))).toHaveLength(5);
});

test('local loads each wrapper under its partition key and registers the bytes, reporting progress', async () => {
  const loader = scriptedLoader({
    'partitions/000000/spans': toBase64(PARQUET_BYTES),
    'partitions/000000/logs': toBase64(PARQUET_BYTES),
    'partitions/000001/spans': toBase64(PARQUET_BYTES),
    'partitions/000001/logs': toBase64(PARQUET_BYTES),
  });
  const progress: RegisterProgress[] = [];
  const engine = fakeEngine('local');
  await registerPartitions(engine, twoPartitionManifest, { loader, baseUrl: 'file:///r/index.html' }, (p) =>
    progress.push(p),
  );
  expect(loader.calls).toContain('file:///r/data/partitions/000000/spans.parquet.js');
  expect(progress.at(-1)).toEqual({ done: 4, total: 4 });
  expect(progress).toHaveLength(4);
  expect(engine.calls.registerFileBuffer.map((c) => c[0]).sort()).toEqual([
    'data/partitions/000000/logs.parquet',
    'data/partitions/000000/spans.parquet',
    'data/partitions/000001/logs.parquet',
    'data/partitions/000001/spans.parquet',
  ]);
  expect(engine.calls.registerFileBuffer[0]?.[1]).toEqual(PARQUET_BYTES);
  expect(engine.calls.exec).toHaveLength(5);
});

test('local keeps at most four loads in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const loader: ScriptLoader = {
    load: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return toBase64(PARQUET_BYTES);
    },
  };
  const many = {
    partitions: Array.from({ length: 10 }, (_, n) => ({
      n,
      source: `flush:${n}`,
      files: { spans: file(n, 'spans') },
    })),
  } as unknown as ManifestV4;
  await registerPartitions(fakeEngine('local'), many, { loader, baseUrl: 'file:///r/index.html' });
  expect(peak).toBe(4);
});

test('a non-string wrapper payload is an invalid-report naming the wrapper', async () => {
  const loader: ScriptLoader = { load: async () => 42 };
  await expect(
    registerPartitions(fakeEngine('local'), twoPartitionManifest, {
      loader,
      baseUrl: 'file:///r/index.html',
    }),
  ).rejects.toMatchObject({ code: 'invalid-report' });
});
