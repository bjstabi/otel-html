import { describe, expect, test } from 'vitest';
import { readRunManifest } from '../../src/cli/ci/run-report.js';
import { wrapDataFile } from '../../src/format/data-file.js';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { MANIFEST_KEY, MANIFEST_PATH } from '../../src/format/paths.js';
import { readHostManifest } from '../../src/host/manifest.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { loadPartitionCheckpoint } from '../../src/writer/checkpoint.js';
import { readMergeInput } from '../../src/writer/merge.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

const manifest = (formatVersion: 4 | 5): ManifestV4 => ({
  formatVersion,
  otelHtmlVersion: '0.3.0',
  title: 't',
  epochUnixNano: '1700000000000000000',
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:01.000Z',
  complete: true,
  range: { start: '1700000000000000005', end: '1700000000000000010' },
  totals: { spans: 0, logs: 0, metrics: 0 },
  partitions: [],
  statisticsKeys: { spans: [], logs: [], points: [], traces: [], patterns: [] },
  engine: { version: '1.4.1', format: 'site', assetsBase: 'assets/' },
  config: {
    viewer: { listCap: 10_000, theme: 'system', defaultDashboard: 'fusion', home: 'traces' },
    dashboards: [],
    views: [],
  },
});

async function reportWith(m: ManifestV4): Promise<ReturnType<typeof createMemoryFileSystem>> {
  const fs = createMemoryFileSystem();
  await fs.mkdirp('/r/data');
  await fs.writeTextAtomic(`/r/${MANIFEST_PATH}`, wrapDataFile(MANIFEST_KEY, m));
  return fs;
}

const GATES: readonly [string, (m: ManifestV4) => Promise<unknown>][] = [
  ['readHostManifest', async (m) => readHostManifest(await reportWith(m), '/r')],
  ['readRunManifest', async (m) => readRunManifest(await reportWith(m), '/r')],
  ['readMergeInput', async (m) => readMergeInput(await reportWith(m), '/r')],
  [
    'loadPartitionCheckpoint',
    async (m) => {
      // No state slot is written, so it passes the format gate and fails on the missing state: only that failure is expected.
      await loadPartitionCheckpoint(await reportWith(m), '/r', m.otelHtmlVersion, 'site').catch(
        (e: unknown) => {
          if (e instanceof OtelHtmlError && e.code === 'invalid-report' && e.path === 'data/state') return;
          throw e;
        },
      );
    },
  ],
];

describe('the gates', () => {
  test.each(GATES)('%s accepts a format-5 manifest and still accepts format 4', async (_name, gate) => {
    await expect(gate(manifest(4))).resolves.not.toThrow();
    await expect(gate(manifest(5))).resolves.not.toThrow();
  });
});
