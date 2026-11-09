import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, parseAnyManifest } from '../../src/format/manifest.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { buildFormat4Report, spansOnlyRequest } from '../../test-support/format4-fixture.js';
import { writeReportDir } from '../../test-support/report-dir.js';

test('writeReportDir writes the manifest and every listed file, and close removes the folder', async () => {
  const f = await buildFormat4Report([spansOnlyRequest(3)]);
  const { dir, close } = await writeReportDir(f);
  try {
    const manifest = parseAnyManifest(
      reviveDataJson(unwrapDataFile(readFileSync(join(dir, 'data/manifest.js'), 'utf8'), MANIFEST_KEY)),
    );
    if (!isV4(manifest)) throw new Error('not a v4 manifest');
    expect(manifest.partitions).toHaveLength(1);
    expect(f.files.size).toBeGreaterThan(0);
    for (const [path, bytes] of f.files) {
      expect(readFileSync(join(dir, path))).toEqual(Buffer.from(bytes));
    }
    expect([...f.files.keys()].some((p) => p.endsWith('spans.parquet'))).toBe(true);
  } finally {
    await close();
  }
  expect(existsSync(dir)).toBe(false);
});
