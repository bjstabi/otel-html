import { describe, expect, test } from 'vitest';
import {
  ENGINE_ASSET_RE,
  ENGINE_VERSION_RE,
  PARTITION_FILE_RE,
  partitionDir,
  partitionFilePath,
  partitionKey,
  partitionWrapperPath,
} from '../../src/format/paths.js';
import {
  CHUNK_READABLE_FORMAT_VERSIONS,
  PARTITION_FORMAT_VERSION,
  READABLE_FORMAT_VERSIONS,
} from '../../src/format/version.js';

describe('partition paths', () => {
  test('versions', () => {
    expect(PARTITION_FORMAT_VERSION).toBe(5);
    expect(CHUNK_READABLE_FORMAT_VERSIONS).toEqual([1, 2, 3]);
    expect(READABLE_FORMAT_VERSIONS).toEqual([1, 2, 3, 4, 5]);
  });

  test('helpers zero-pad to six digits and widen past it', () => {
    expect(partitionDir(7)).toBe('data/partitions/000007');
    expect(partitionFilePath(7, 'spans')).toBe('data/partitions/000007/spans.parquet');
    expect(partitionWrapperPath(7, 'points')).toBe('data/partitions/000007/points.parquet.js');
    expect(partitionKey(7, 'traces')).toBe('partitions/000007/traces');
    expect(partitionDir(1234567)).toBe('data/partitions/1234567');
  });

  test('rejects a negative or fractional partition number', () => {
    expect(() => partitionDir(-1)).toThrow();
    expect(() => partitionDir(1.5)).toThrow();
  });

  test('PARTITION_FILE_RE', () => {
    expect(PARTITION_FILE_RE.test('data/partitions/000007/spans.parquet')).toBe(true);
    expect(PARTITION_FILE_RE.test('data/partitions/1234567/patterns.parquet')).toBe(true);
    expect(PARTITION_FILE_RE.test('data/partitions/00007/spans.parquet')).toBe(false);
    expect(PARTITION_FILE_RE.test('data/partitions/000007/../spans.parquet')).toBe(false);
    expect(PARTITION_FILE_RE.test('data/partitions/../spans.parquet')).toBe(false);
    expect(PARTITION_FILE_RE.test('data/partitions/000007/other.parquet')).toBe(false);
    expect(PARTITION_FILE_RE.test('data/partitions/000007/spans.parquet.js')).toBe(false);
  });

  test('ENGINE_ASSET_RE', () => {
    for (const s of ['wasm', 'worker.js', 'wasm.gz.b64.js', 'worker.b64.js', 'node.cjs', 'node.worker.cjs']) {
      expect(ENGINE_ASSET_RE.test(`assets/duckdb.1.4.1-abc.${s}`)).toBe(true);
    }
    for (const e of ['parquet', 'json']) {
      expect(ENGINE_ASSET_RE.test(`assets/duckdb.1.4.1.${e}.ext.gz.b64.js`)).toBe(true);
      expect(ENGINE_ASSET_RE.test(`assets/${e}.1.4.1.duckdb_extension.wasm`)).toBe(true);
    }
    expect(ENGINE_ASSET_RE.test('assets/other.1.4.1.duckdb_extension.wasm')).toBe(false);
    expect(ENGINE_ASSET_RE.test('assets/../parquet.1.4.1.duckdb_extension.wasm')).toBe(false);
    expect(ENGINE_ASSET_RE.test('assets/duckdb.1.4.1.exe')).toBe(false);
    expect(ENGINE_ASSET_RE.test('assets/duckdb..wasm')).toBe(false);
    expect(ENGINE_ASSET_RE.test('assets/../duckdb.1.wasm')).toBe(false);
    expect(ENGINE_ASSET_RE.test('assets/_duckdb.1.wasm')).toBe(false);
  });

  test('ENGINE_VERSION_RE', () => {
    for (const ok of ['1.4.1', '1.4.1-abc']) expect(ENGINE_VERSION_RE.test(ok)).toBe(true);
    for (const bad of ['x/../../', '1/2', '', '.1', '_1']) expect(ENGINE_VERSION_RE.test(bad)).toBe(false);
  });
});
