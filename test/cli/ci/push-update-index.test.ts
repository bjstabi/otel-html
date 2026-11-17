import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { createReportWith, resolveDeps } from '../../../src/api/report.js';
import { buildPushUpdate } from '../../../src/cli/ci/push-update.js';
import { emptyRunState, newRunManifest, planSync } from '../../../src/cli/ci/run-report.js';
import { readUpdate, UpdateJsonSchema } from '../../../src/cli/ci/update.js';
import { resolveConfig } from '../../../src/config/resolve.js';
import { isPartitioned, manifestForWrite, parseAnyManifest } from '../../../src/format/manifest.js';
import type { WriterDeps } from '../../../src/writer/session.js';
import { span, traceRequest } from '../../../test-support/otlp-builders.js';
import { fakeViewerAssets } from '../../../test-support/writer-deps.js';

const CI_CONFIG = '.github/otel-html-ci.yaml';
let dir: string;
let deps: WriterDeps;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'push-index-'));
  deps = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a push update of a report written with the CI config', () => {
  test('carries widget_traces, readUpdate accepts it, planSync lists it', async () => {
    const report = join(dir, 'report');
    mkdirSync(dir, { recursive: true });
    const w = await createReportWith(
      { out: report, format: 'local', assetsBase: 'assets/', config: CI_CONFIG },
      deps,
    );
    await w.addSpans(
      traceRequest(
        [1, 2].map((n) =>
          span({
            spanId: n.toString(16).padStart(16, '0'),
            name: 'run',
            attributes: [{ key: 'github.job.step.number', value: { intValue: String(n) } }],
          }),
        ),
        [],
      ),
    );
    await w.close();

    const out = join(dir, 'update');
    const built = await buildPushUpdate({
      deps,
      report,
      ledger: { sequence: 0, shipped: [], uploads: [] },
      out,
      runId: 42,
      runAttempt: 1,
      jobId: 7,
      jobName: 'build',
      sequence: 1,
      createdAt: '2026-11-10T12:00:00.000Z',
    });
    const files = built?.update.partitions?.flatMap((p) => Object.keys(p.files)) ?? [];
    expect(files).toContain('widget_traces');
    const indexed = built?.update.partitions?.flatMap((p) => p.files.widget_traces ?? []) ?? [];
    expect(indexed.length).toBeGreaterThan(0);
    for (const entry of indexed) expect(entry.widgetIndex).toBeDefined();

    const u = await readUpdate(deps.fs, out);
    const parsed = resolveConfig({
      file: parse(await readFile(CI_CONFIG, 'utf8')),
      env: {},
      fileLabel: CI_CONFIG,
    }).config;
    const manifest = newRunManifest({
      title: 'run 42',
      createdAt: '2026-11-10T00:00:00.000Z',
      assetsBase: '../../../assets/0.4.0/',
      config: parsed,
      version: '0.4.0',
    });
    const plan = planSync({
      manifest,
      state: emptyRunState(1),
      jobKey: '7',
      jobName: 'build',
      attempt: 1,
      updates: [{ dir: out, update: u }],
      now: '2026-11-10T12:00:00.000Z',
    });
    expect(plan.manifest.partitions.some((e) => e.files.widget_traces !== undefined)).toBe(true);
    const back = parseAnyManifest(manifestForWrite(plan.manifest));
    expect(isPartitioned(back) ? back.partitions : undefined).toEqual(plan.manifest.partitions);
  });
});

describe('the update schema', () => {
  const base = {
    version: 1,
    kind: 'push',
    runId: 42,
    runAttempt: 1,
    createdAt: '2026-11-10T12:00:00.000Z',
    jobId: 7,
    jobName: 'build',
    sequence: 1,
  };
  const file = {
    path: 'partitions/0/span_rollups.parquet',
    bytes: 10,
    rows: 1,
    timeMin: '1',
    timeMax: '2',
    values: {},
  };
  const rollup = { grainNs: 65_536_000_000, dimensions: ['name'] };
  const update = (rollupDescription: object) => ({
    ...base,
    partitions: [
      {
        source: 'job:7#flush:0',
        carried: true,
        files: { span_rollups: { ...file, rollup: rollupDescription } },
      },
    ],
  });
  test('accepts refused keys on a rollup, and a rollup without them (format 5 and 6)', () => {
    expect(UpdateJsonSchema.safeParse(update({ ...rollup, refused: ['attr:a'] })).success).toBe(true);
    expect(UpdateJsonSchema.safeParse(update(rollup)).success).toBe(true);
  });
});
