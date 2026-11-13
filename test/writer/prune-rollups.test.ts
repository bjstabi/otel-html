import { expect, test } from 'vitest';
import type { PartitionEntry } from '../../src/format/manifest.js';
import { prunePartitions } from '../../src/writer/prune.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

const file = (path: string) => ({ path, bytes: 1, rows: 1, timeMin: null, timeMax: null, values: {} });

test('pruning a partition removes its rollup files, and keeps the listed ones', async () => {
  const fs = createMemoryFileSystem();
  const dir = (n: string) => `/out/data/partitions/${n}`;
  for (const n of ['000000', '000001']) {
    await fs.mkdirp(dir(n));
    for (const t of ['spans', 'span_rollups', 'log_rollups'])
      await fs.writeBytes(`${dir(n)}/${t}.parquet`, new Uint8Array([1]));
  }
  // Partition 1 is listed with its spans and span rollup only; partition 0 is not listed at all.
  const listed: PartitionEntry[] = [
    {
      n: 1,
      source: 'flush:1',
      files: {
        spans: file('data/partitions/000001/spans.parquet'),
        span_rollups: {
          ...file('data/partitions/000001/span_rollups.parquet'),
          rollup: { grainNs: 65_536_000_000, dimensions: [], durationBuckets: 'log2x8' },
        },
      },
    },
  ];
  await prunePartitions(fs, '/out', listed);
  expect(await fs.exists(dir('000000'))).toBe(false);
  expect((await fs.list(dir('000001'))).sort()).toEqual(['span_rollups.parquet', 'spans.parquet']);
});
