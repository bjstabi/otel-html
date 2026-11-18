import { tableFromIPC } from 'apache-arrow';
import { expect, it, vi } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import type { ConfigInput } from '../../src/config/schema.js';
import { startHostEngine } from '../../src/host/engine.js';
import { widgetIndexRelation } from '../../src/query/sql/widget-index.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { buildFormat4Report } from '../../test-support/format4-fixture.js';
import { packageHostEngineFiles } from '../../test-support/host-engine-files.js';
import { writeReportDir } from '../../test-support/report-dir.js';
import { ciRequest, filler } from '../writer/widget-index-helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const logger = { debug() {}, info() {}, warn() {}, error() {} };

it('a routed statement reads the widget_traces files the host allows', async () => {
  const input = (await loadConfigFile(
    createNodeFileSystem(),
    'test-support/legacy-ci.otel-html.yaml',
  )) as ConfigInput;
  const fixture = await buildFormat4Report(
    [ciRequest([{ i: 1 }, { i: 2, job: 'success', task: 'build' }, ...filler(400)])],
    { config: input, close: false },
  );
  const entry = fixture.manifest.partitions[0]?.files.widget_traces;
  expect(entry?.widgetIndex?.conditions).toHaveLength(1);
  const condition = entry?.widgetIndex?.conditions[0] ?? '';
  expect(condition).toMatch(/^[0-9a-f]{16}$/);
  const report = await writeReportDir(fixture);
  const engine = await startHostEngine({
    report: report.dir,
    manifest: fixture.manifest,
    files: packageHostEngineFiles(),
    fs: createNodeFileSystem(),
    logger,
    timeoutMs: 30_000,
    maxResultBytes: 64 * 1024 * 1024,
  });
  try {
    const route = {
      files: [entry?.path ?? ''],
      condition,
      bindings: [{ key: 'cicd.pipeline.task.name', value: 'build' }],
    };
    const table = tableFromIPC(await engine.query(String(widgetIndexRelation(route))));
    expect(table.numRows).toBe(1);
  } finally {
    await engine.close();
    await report.close();
  }
});
