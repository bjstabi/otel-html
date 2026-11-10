import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  emptyRunState,
  type JobUpdate,
  newRunManifest,
  planSync,
  type RunReportState,
  readRunManifest,
  renumbered,
  writeRunReport,
} from '../../../src/cli/ci/run-report.js';
import type { UpdateJson, UpdatePartition } from '../../../src/cli/ci/update.js';
import { resolveConfig } from '../../../src/config/resolve.js';
import type { ResolvedConfig } from '../../../src/config/schema.js';
import { ENGINE_VERSION } from '../../../src/format/engine.js';
import { type ManifestV4, parseAnyManifest } from '../../../src/format/manifest.js';
import { createTestWriter } from '../../../test-support/writer-deps.js';

const CI_CONFIG = '.github/actions/otel-html-publish/otel-html-ci.yaml';
const config = async (): Promise<ResolvedConfig> =>
  resolveConfig({ file: parse(await readFile(CI_CONFIG, 'utf8')), env: {}, fileLabel: CI_CONFIG }).config;

const NOW = '2026-11-10T12:00:00.000Z';
const newManifest = async (): Promise<ManifestV4> =>
  newRunManifest({
    title: 'run 42',
    epochUnixNano: '1700000000000000000',
    createdAt: '2026-11-10T00:00:00.000Z',
    assetsBase: '../../../assets/0.4.0/',
    config: await config(),
    version: '0.4.0',
  });

const file = (path: string, rows: number, timeMin: string, timeMax: string, values = {}) => ({
  path,
  bytes: 10,
  rows,
  timeMin,
  timeMax,
  values,
});
const part = (
  source: string,
  path: string,
  rows: number,
  timeMin: string,
  timeMax: string,
  carried = true,
  values = {},
): UpdatePartition => ({ source, files: { spans: file(path, rows, timeMin, timeMax, values) }, carried });
const ci = (carried = true, rows = 1): UpdatePartition => ({
  source: 'ci:7',
  files: {
    spans: file('ci/spans.parquet', rows, '5', '6'),
    logs: file('ci/logs.parquet', 2, '7', '9'),
  },
  carried,
});
const push = (
  sequence: number,
  partitions: UpdatePartition[],
  ciPart: UpdatePartition = ci(),
): UpdateJson => ({
  version: 1,
  kind: 'push',
  runId: 42,
  runAttempt: 1,
  createdAt: NOW,
  jobId: 7,
  jobName: 'build',
  sequence,
  partitions,
  ci: ciPart,
});
const ju = (update: UpdateJson, dir = `/u/${update.sequence}`): JobUpdate => ({ dir, update });
const first = (): UpdateJson =>
  push(1, [
    part('job:7#flush:0', 'partitions/0/spans.parquet', 3, '10', '20', true, {
      'resource:cicd.pipeline.run.id': ['42'],
      extra: ['x'],
    }),
    part('job:7#flush:1', 'partitions/1/spans.parquet', 4, '15', '30'),
  ]);
const sync = (
  manifest: ManifestV4,
  state: RunReportState,
  updates: JobUpdate[],
  over: { jobKey?: string; jobName?: string; attempt?: number } = {},
) => planSync({ manifest, state, jobKey: '7', jobName: 'build', attempt: 1, updates, now: NOW, ...over });

describe('newRunManifest', () => {
  test('is an empty incomplete v4 site manifest with the CI statistics keys', async () => {
    const m = await newManifest();
    expect(parseAnyManifest(m)).toEqual(m);
    expect(m.complete).toBe(false);
    expect(m.engine).toEqual({
      version: ENGINE_VERSION,
      format: 'site',
      assetsBase: '../../../assets/0.4.0/',
    });
    expect(m.statisticsKeys.spans).toContain('resource:cicd.pipeline.run.id');
    expect(m.partitions).toEqual([]);
    expect(m.range).toBeNull();
  });
});

describe('planSync', () => {
  test('the first update numbers its partitions and ci from zero', async () => {
    const m = await newManifest();
    const plan = sync(m, emptyRunState(1), [ju(first())]);
    expect(plan.pending).toBe(false);
    expect(plan.manifest.partitions.map((p) => [p.n, p.source])).toEqual([
      [0, 'job:7#flush:0'],
      [1, 'job:7#flush:1'],
      [2, 'ci:7'],
    ]);
    expect(plan.drops).toEqual([]);
    expect(plan.state.next).toBe(3);
    expect(plan.state.jobs['7']).toEqual({
      name: 'build',
      sequence: 1,
      sources: ['job:7#flush:0', 'job:7#flush:1', 'ci:7'],
    });
    expect(plan.copies).toContainEqual({
      fromDir: '/u/1',
      from: 'partitions/0/spans.parquet',
      to: 'data/partitions/000000/spans.parquet',
    });
    expect(plan.copies).toContainEqual({
      fromDir: '/u/1',
      from: 'ci/logs.parquet',
      to: 'data/partitions/000002/logs.parquet',
    });
    expect(plan.copies).toHaveLength(4);
    expect(plan.manifest.totals).toEqual({ spans: 3 + 4 + 1, logs: 2, metrics: 0 });
    expect(plan.manifest.range).toEqual({ start: '5', end: '30' });
    expect(plan.manifest.complete).toBe(false);
    expect(plan.manifest.updatedAt).toBe(NOW);
    const v = plan.manifest.partitions[0]?.files.spans?.values;
    expect(Object.keys(v ?? {}).sort()).toEqual([...m.statisticsKeys.spans].sort());
    expect(v?.['resource:cicd.pipeline.run.id']).toEqual(['42']);
    expect(v).not.toHaveProperty('extra');
    expect(plan.manifest.partitions[1]?.files.spans?.values['resource:cicd.pipeline.run.id']).toBeNull();
    expect(parseAnyManifest(plan.manifest)).toEqual(plan.manifest);
  });

  test('a compaction update replaces the flushes and the old ci, and numbers are never reused', async () => {
    const m = await newManifest();
    const one = sync(m, emptyRunState(1), [ju(first())]);
    const two = push(2, [part('job:7#compact:0..1', 'partitions/0/spans.parquet', 7, '10', '30')]);
    const plan = sync(one.manifest, one.state, [ju(two)]);
    expect(plan.drops.sort()).toEqual(
      [0, 1, 2]
        .flatMap((n) => {
          const p = `data/partitions/${String(n).padStart(6, '0')}`;
          return n === 2 ? [`${p}/spans.parquet`, `${p}/logs.parquet`] : [`${p}/spans.parquet`];
        })
        .sort(),
    );
    expect(plan.manifest.partitions.map((p) => [p.n, p.source])).toEqual([
      [3, 'job:7#compact:0..1'],
      [4, 'ci:7'],
    ]);
    expect(plan.state.next).toBe(5);
    expect(plan.state.jobs['7']?.sequence).toBe(2);
  });

  test('a replayed or older update changes nothing', async () => {
    const m = await newManifest();
    const one = sync(m, emptyRunState(1), [ju(first())]);
    const two = push(2, [part('job:7#compact:0..1', 'partitions/0/spans.parquet', 7, '10', '30')]);
    const applied = sync(one.manifest, one.state, [ju(two)]);
    for (const updates of [[ju(two)], [ju(first())], [ju(first()), ju(two)]]) {
      const again = sync(applied.manifest, applied.state, updates);
      expect(again.pending).toBe(false);
      expect(again.manifest).toEqual(applied.manifest);
      expect(again.state).toEqual(applied.state);
      expect(again.copies).toEqual([]);
      expect(again.drops).toEqual([]);
    }
  });

  test('two updates at once converge on the highest one', async () => {
    const m = await newManifest();
    const two = push(2, [part('job:7#compact:0..1', 'partitions/0/spans.parquet', 7, '10', '30')]);
    const plan = sync(m, emptyRunState(1), [ju(first()), ju(two)]);
    expect(plan.manifest.partitions.map((p) => p.source)).toEqual(['job:7#compact:0..1', 'ci:7']);
    expect(plan.copies.every((c) => c.fromDir === '/u/2')).toBe(true);
  });

  test('a listed partition nobody carries leaves everything pending and unchanged', async () => {
    const m = await newManifest();
    const state = emptyRunState(1);
    const lone = push(2, [part('job:7#compact:0..1', 'partitions/0/spans.parquet', 7, '10', '30', false)]);
    const plan = sync(m, state, [ju(lone)]);
    expect(plan).toEqual({ manifest: m, state, copies: [], drops: [], pending: true });
  });

  test('an older update that carries the missing partition completes it, copying from its dir', async () => {
    const m = await newManifest();
    const carrier = push(1, [part('job:7#compact:0..1', 'partitions/0/spans.parquet', 7, '10', '30')]);
    const lone = push(2, [part('job:7#compact:0..1', 'partitions/0/spans.parquet', 7, '10', '30', false)]);
    const plan = sync(m, emptyRunState(1), [ju(lone), ju(carrier)]);
    expect(plan.pending).toBe(false);
    expect(plan.manifest.partitions.map((p) => p.source)).toEqual(['job:7#compact:0..1', 'ci:7']);
    expect(plan.copies.find((c) => c.to.endsWith('000000/spans.parquet'))?.fromDir).toBe('/u/1');
    expect(plan.copies.find((c) => c.to.endsWith('000001/logs.parquet'))?.fromDir).toBe('/u/2');
    expect(plan.state.jobs['7']?.sequence).toBe(2);
  });

  test('a partition already in the manifest is kept when the update does not carry it', async () => {
    const m = await newManifest();
    const one = sync(m, emptyRunState(1), [ju(first())]);
    const next = push(
      2,
      [
        part('job:7#flush:0', 'partitions/0/spans.parquet', 3, '10', '20', false),
        part('job:7#flush:2', 'partitions/1/spans.parquet', 1, '40', '50'),
      ],
      ci(false),
    );
    const plan = sync(one.manifest, one.state, [ju(next)]);
    expect(plan.manifest.partitions.map((p) => [p.n, p.source])).toEqual([
      [0, 'job:7#flush:0'],
      [2, 'ci:7'],
      [3, 'job:7#flush:2'],
    ]);
    expect(plan.drops).toEqual(['data/partitions/000001/spans.parquet']);
    expect(plan.copies.map((c) => c.from)).toEqual(['partitions/1/spans.parquet']);
  });

  test('jobs leave each other alone', async () => {
    const m = await newManifest();
    const a = sync(m, emptyRunState(1), [ju(first())]);
    const other: UpdateJson = {
      ...push(1, [part('job:8#flush:0', 'partitions/0/spans.parquet', 2, '1', '2')], {
        ...ci(),
        source: 'ci:8',
      }),
      jobId: 8,
      jobName: 'test',
    };
    const b = sync(a.manifest, a.state, [ju(other, '/o/1')], { jobKey: '8', jobName: 'test' });
    expect(b.manifest.partitions.map((p) => p.source)).toEqual([
      'job:7#flush:0',
      'job:7#flush:1',
      'ci:7',
      'job:8#flush:0',
      'ci:8',
    ]);
    expect(b.drops).toEqual([]);
    expect(b.state.next).toBe(5);
    expect(Object.keys(b.state.jobs)).toEqual(['7', '8']);
  });

  test('an older attempt is ignored; a newer one drops the sources of the same-named job and resets complete', async () => {
    const m = await newManifest();
    const a = sync(m, emptyRunState(1), [ju(first())]);
    const old = sync(a.manifest, { ...a.state, attempt: 2 }, [
      ju(push(5, [part('job:7#x', 'partitions/0/spans.parquet', 1, '1', '2')])),
    ]);
    expect(old.pending).toBe(false);
    expect(old.manifest).toEqual(a.manifest);

    const other: UpdateJson = {
      ...push(1, [part('job:8#flush:0', 'partitions/0/spans.parquet', 2, '1', '2')], {
        ...ci(),
        source: 'ci:8',
      }),
      jobId: 8,
      jobName: 'test',
    };
    const b = sync(a.manifest, a.state, [ju(other)], { jobKey: '8', jobName: 'test' });
    const rerun: UpdateJson = {
      ...push(1, [part('job:9#flush:0', 'partitions/0/spans.parquet', 5, '100', '200')], {
        ...ci(),
        source: 'ci:9',
      }),
      runAttempt: 2,
      jobId: 9,
    };
    const done = { ...b.manifest, complete: true };
    const plan = sync(done, b.state, [ju(rerun)], { jobKey: '9', attempt: 2 });
    expect(plan.state.attempt).toBe(2);
    expect(Object.keys(plan.state.jobs)).toEqual(['8', '9']);
    expect(plan.manifest.partitions.map((p) => p.source)).toEqual([
      'job:8#flush:0',
      'ci:8',
      'job:9#flush:0',
      'ci:9',
    ]);
    expect(plan.drops).toHaveLength(4);
    expect(plan.manifest.complete).toBe(false);
  });
});

describe('renumbered', () => {
  test('moves every partition to numbers from the given one', async () => {
    const m = await newManifest();
    const a = sync(m, emptyRunState(1), [ju(first())]);
    const two = { ...a.manifest, partitions: a.manifest.partitions.slice(0, 2) };
    const r = renumbered(two, 10);
    expect(r.manifest.partitions.map((p) => p.n)).toEqual([10, 11]);
    expect(r.manifest.partitions[0]?.files.spans?.path).toBe('data/partitions/000010/spans.parquet');
    expect(r.moves).toEqual([
      { from: 'data/partitions/000000/spans.parquet', to: 'data/partitions/000010/spans.parquet' },
      { from: 'data/partitions/000001/spans.parquet', to: 'data/partitions/000011/spans.parquet' },
    ]);
    expect(parseAnyManifest(r.manifest)).toEqual(r.manifest);
  });
});

describe('writeRunReport', () => {
  test('writes the manifest, the index and .nojekyll, and reads the manifest back', async () => {
    const w = createTestWriter();
    const m = await newManifest();
    expect(await readRunManifest(w.fs, 'site/run')).toBeNull();
    await writeRunReport(w.deps, 'site/run', m);
    expect(await readRunManifest(w.fs, 'site/run')).toEqual(m);
    const html = w.fs.snapshot().get('site/run/index.html') ?? '';
    expect(html).toContain('../../../assets/0.4.0/');
    expect(html).not.toContain('otel-html-host');
    expect(w.fs.snapshot().has('site/run/.nojekyll')).toBe(true);
  });
});
