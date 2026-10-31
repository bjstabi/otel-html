import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { merge } from '../../src/api/convert.js';
import { FORMAT_VERSION } from '../../src/format/version.js';
import { createTestWriter, type TestWriter } from '../../test-support/writer-deps.js';
import { manifestOf } from '../writer/helpers.js';

const REPORTS = join(import.meta.dirname, '../../fixtures/reports');

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1));
}

/** Copies `fixtures/reports/<name>/data/**` from disk into the writer's file system at `<name>/data/`; returns its manifest. */
async function copyFixtureReport(w: TestWriter, name: string) {
  const root = join(REPORTS, name, 'data');
  for (const rel of filesUnder(root)) {
    await w.deps.fs.writeBytes(`${name}/data/${rel}`, readFileSync(join(root, rel)));
  }
  return manifestOf(w, name);
}

describe.each(['format-1', 'format-2'])('%s', (name) => {
  test('merge reads it and the totals survive', async () => {
    const w = createTestWriter();
    const expected = await copyFixtureReport(w, name);
    const summary = await merge({ inputs: [name], out: 'm' }, w.deps);
    expect(summary.totals).toEqual(expected.totals);
    expect(summary.totals.spans).toBeGreaterThan(0);
    expect(summary.totals.metrics).toBeGreaterThan(0);
    expect(manifestOf(w, 'm').formatVersion).toBe(FORMAT_VERSION);
  });
});
