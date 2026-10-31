/// <reference types="vite/client" />
import { describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { parseManifest } from '../../src/format/manifest.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { createDataSource } from '../../src/viewer/data/data-source.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';

const BUDGET = 64_000_000;

/** Every file of the frozen reports, keyed by path from `fixtures/reports/` (`format-1/data/manifest.js`). */
const ALL_FILES = import.meta.glob('../../fixtures/reports/*/data/**', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** One frozen report's files keyed by report-relative path (`data/manifest.js`), as the viewer's loader asks for them. */
function reportFiles(name: string): Map<string, string> {
  const prefix = `../../fixtures/reports/${name}/`;
  return new Map(
    Object.entries(ALL_FILES)
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, text]) => [path.slice(prefix.length), text]),
  );
}

describe.each([
  ['format-1', 1],
  ['format-2', 2],
])('the viewer opens frozen %s', (name, version) => {
  test('reads spans and every metric level', async () => {
    const files = reportFiles(name);
    const text = files.get('data/manifest.js');
    if (text === undefined) throw new Error('no manifest');
    const manifest = parseManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
    expect(manifest.formatVersion).toBe(version);

    const ds = await createDataSource(createScriptedLoader(files), manifest, BUDGET);
    const landing = await ds.landing();
    expect(landing.facets).toBeDefined();
    const result = await ds.querySpans({
      condition: null,
      text: '',
      window: null,
      mode: 'spans',
      sort: { column: 'start', dir: 'asc' },
      limit: 1000,
      groupBy: null,
      scanAll: false,
    });
    expect(result.total).toBe(manifest.totals.spans);

    const catalog = await ds.metricCatalog();
    expect(catalog.entries().length).toBeGreaterThan(0);
    for (const [id] of catalog.entries().entries()) {
      const metric = await ds.metric(id);
      expect(metric.levels.length).toBeGreaterThan(0);
      for (const l of metric.levels) {
        const level = await metric.level(l.level);
        expect(level.series.size).toBeGreaterThan(0);
      }
      // Format 1 has no point gaps in series.js: the viewer measures them on level 0 instead.
      if (version === 1) expect(metric.gaps).toBeNull();
    }
  });
});
