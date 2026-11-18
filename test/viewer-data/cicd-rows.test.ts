import { afterEach, describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isPartitioned, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { TABLES } from '../../src/format/parquet/columns.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { combineRuns } from '../../src/viewer/cicd/runs.js';
import type { CicdQuery, CicdRow } from '../../src/viewer/data/cicd-query.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import { openSession } from '../../src/writer/session.js';
import { type Format4Fixture, openFixtureDb } from '../../test-support/format4-fixture.js';
import { withoutCicd } from '../../test-support/format6.js';
import type { JsonObject } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const T0 = 1_700_000_000_000_000_000n;
const SEC = 1_000_000_000n;
const hex = (k: number, width: number): string => k.toString(16).padStart(width, '0');
const str = (key: string, value: string): JsonObject => ({ key, value: { stringValue: value } });

interface Run {
  /** The trace; also the run's span ids. */
  t: number;
  run: string;
  attempt: number;
  /** Seconds after `T0`. */
  at: number;
  result: 'success' | 'failure' | 'cancellation';
  trigger: string;
  branch: string;
  jobs: readonly string[];
}

/** A run as the CI publisher writes it: the root span (run resource), job spans (own resource) with a `queued` child. */
function runSpans(r: Run): JsonObject[] {
  const start = T0 + BigInt(r.at) * SEC;
  const trace = hex(r.t, 32);
  const root = hex(r.t * 100, 16);
  const resourceSpans: JsonObject[] = [
    {
      resource: {
        attributes: [
          str('cicd.pipeline.name', 'ci'),
          str('cicd.pipeline.run.id', r.run),
          str('cicd.pipeline.trigger', r.trigger),
          str('vcs.ref.head.name', r.branch),
          str('vcs.ref.head.revision', `rev${r.t}`),
          str('vcs.ref.head.title', `title ${r.t}`),
        ],
      },
      scopeSpans: [
        {
          scope: { name: 'otel-html-ci' },
          spans: [
            {
              traceId: trace,
              spanId: root,
              name: 'ci',
              kind: 1,
              startTimeUnixNano: String(start),
              endTimeUnixNano: String(start + 50n * SEC),
              attributes: [
                str('cicd.pipeline.result', r.result),
                { key: 'github.run_attempt', value: { intValue: String(r.attempt) } },
              ],
            },
          ],
        },
      ],
    },
  ];
  r.jobs.forEach((job, k) => {
    const id = hex(r.t * 100 + 1 + k * 2, 16);
    resourceSpans.push({
      resource: {
        attributes: [
          str('cicd.pipeline.name', 'ci'),
          str('cicd.pipeline.run.id', `${r.run}-job`),
          str('cicd.worker.labels', 'ubuntu'),
        ],
      },
      scopeSpans: [
        {
          scope: { name: 'otel-html-ci' },
          spans: [
            {
              traceId: trace,
              spanId: id,
              parentSpanId: root,
              name: job,
              kind: 1,
              startTimeUnixNano: String(start + SEC),
              endTimeUnixNano: String(start + BigInt(10 + k * 10) * SEC),
              attributes: [
                str('cicd.pipeline.task.name', job),
                str('cicd.pipeline.task.run.id', `${r.run}-${job}`),
                str('cicd.pipeline.task.run.result', r.result === 'success' ? 'success' : 'failure'),
              ],
            },
            {
              traceId: trace,
              spanId: hex(r.t * 100 + 2 + k * 2, 16),
              parentSpanId: id,
              name: 'queued',
              kind: 1,
              startTimeUnixNano: String(start + SEC),
              endTimeUnixNano: String(start + 3n * SEC),
              attributes: [str('cicd.pipeline.task.name', job)],
            },
          ],
        },
      ],
    });
  });
  return resourceSpans;
}

/** Mise task spans of a run's trace: `replayed` skipped and `ran` executed. */
function miseSpans(t: number, at: number, replayed: number, ran: number): JsonObject[] {
  const spans = Array.from({ length: replayed + ran }, (_, k) => ({
    traceId: hex(t, 32),
    spanId: hex(t * 100 + 50 + k, 16),
    parentSpanId: hex(t * 100 + 1, 16),
    name: `task-${k}`,
    kind: 1,
    startTimeUnixNano: String(T0 + BigInt(at + k) * SEC),
    endTimeUnixNano: String(T0 + BigInt(at + k + 1) * SEC),
    attributes: [{ key: 'mise.task.skipped', value: { boolValue: k < replayed } }],
  }));
  return [
    {
      resource: { attributes: [str('service.name', 'mise')] },
      scopeSpans: [{ scope: { name: 'mise.tasks' }, spans }],
    },
  ];
}

const other: JsonObject[] = [
  {
    resource: { attributes: [str('service.name', 'web')] },
    scopeSpans: [
      {
        scope: { name: 'web' },
        spans: [
          {
            traceId: hex(9999, 32),
            spanId: hex(9999, 16),
            name: 'GET /',
            kind: 2,
            startTimeUnixNano: String(T0 + 5n * SEC),
            endTimeUnixNano: String(T0 + 6n * SEC),
          },
        ],
      },
    ],
  },
];

const A1: Run = {
  t: 1,
  run: 'A',
  attempt: 1,
  at: 10,
  result: 'failure',
  trigger: 'push',
  branch: 'main',
  jobs: ['build', 'test'],
};
const A2: Run = {
  t: 2,
  run: 'A',
  attempt: 2,
  at: 4000,
  result: 'success',
  trigger: 'push',
  branch: 'main',
  jobs: ['build', 'test'],
};
const B: Run = {
  t: 3,
  run: 'B',
  attempt: 1,
  at: 20,
  result: 'success',
  trigger: 'pull_request',
  branch: 'feat',
  jobs: ['build'],
};
const C: Run = {
  t: 4,
  run: 'C',
  attempt: 1,
  at: 8000,
  result: 'cancellation',
  trigger: 'schedule',
  branch: 'main',
  jobs: ['build'],
};

/** Four partitions, one flush each: A1 and B with their tasks; A2; C's root; C's mise spans (a run split across partitions). */
const PARTITIONS: JsonObject[][] = [
  [...runSpans(A1), ...runSpans(B), ...miseSpans(1, 12, 1, 2), ...other],
  runSpans(A2),
  runSpans(C),
  miseSpans(4, 8002, 2, 1),
];

/** The report the writer makes of `PARTITIONS` (every partition derived: flag and file), in memory. */
async function writtenReport(): Promise<Format4Fixture> {
  const w = createTestWriter();
  const config = testConfig({ writer: { format: 'site' } });
  const session = await openSession(w.deps, { out: 'r', config, mode: 'replace' });
  let i = 0;
  for (const resourceSpans of PARTITIONS) {
    await session.add(otlp({ resourceSpans }), `cicd:${i++}`);
    await session.flush();
  }
  const text = w.fs.snapshot().get('r/data/manifest.js');
  if (text === undefined) throw new Error('no manifest');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isPartitioned(manifest)) throw new Error('not a partition manifest');
  const files = new Map<string, Uint8Array>();
  for (const p of manifest.partitions)
    for (const table of TABLES) {
      const file = p.files[table];
      if (file !== undefined) files.set(file.path, await w.fs.readBytes(`r/${file.path}`));
    }
  return { manifest, files, epoch: BigInt(manifest.epochUnixNano) };
}

/** `f` with the `cicd` flag and file taken away from the partitions numbered `from` (an upgraded report, or one written before format 8). */
function without(f: Format4Fixture, from: (n: number) => boolean, version?: number): Format4Fixture {
  const manifest: ManifestV4 = {
    ...f.manifest,
    ...(version === undefined ? {} : { formatVersion: version as ManifestV4['formatVersion'] }),
    partitions: f.manifest.partitions.map((p) => (from(p.n) ? (withoutCicd([p])[0] ?? p) : p)),
  };
  const files = new Map(f.files);
  for (const p of f.manifest.partitions) {
    const path = p.files.cicd?.path;
    if (from(p.n) && path !== undefined) files.delete(path);
  }
  return { manifest, files, epoch: f.epoch };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** A data source over `f` that records the files its statements prepared. */
async function open(f: Format4Fixture) {
  const db = await openFixtureDb(f);
  const engine = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
  const prepared: string[] = [];
  const spy = {
    ...engine,
    prepare: (paths: readonly string[], signal?: AbortSignal) => {
      prepared.push(...paths);
      return engine.prepare(paths, signal);
    },
  };
  const ds = createDuckDbDataSource({ engine: spy, manifest: f.manifest });
  closers.push(async () => {
    await ds.close();
    db.close();
  });
  return { ds, prepared, epoch: f.epoch };
}

const ALL: CicdQuery = { window: { start: 0, end: 1e14 }, bindings: [], pipeline: null };
const isSpans = (p: string): boolean => p.endsWith('/spans.parquet');
const traces = (rows: readonly CicdRow[]): string[] => [...new Set(rows.map((r) => r.traceId))].sort();

describe('cicdRows over a report the writer derived', () => {
  test('returns the runs, jobs and task counts of every run, reading no spans file', async () => {
    const f = await writtenReport();
    expect(f.manifest.partitions.every((p) => p.cicd === true)).toBe(true);
    const { ds, prepared } = await open(f);
    const rows = await ds.cicdRows(ALL);
    expect(rows.filter((r) => r.kind === 'run')).toHaveLength(4);
    expect(rows.filter((r) => r.kind === 'job')).toHaveLength(2 + 1 + 2 + 1);
    // C's tasks row sits in a later partition than its root and job
    expect(
      rows.filter((r) => r.kind === 'tasks').map((r) => [r.traceId, r.tasksReplayed, r.tasksRun]),
    ).toEqual([
      [hex(1, 32), 1, 2],
      [hex(4, 32), 2, 1],
    ]);
    expect(rows.every((r) => r.traceId !== hex(9999, 32))).toBe(true);
    expect(prepared.some(isSpans)).toBe(false);
    expect(prepared.length).toBeGreaterThan(0);
    const run = rows.find((r) => r.kind === 'run' && r.runId === 'B');
    expect(run).toMatchObject({
      pipeline: 'ci',
      attempt: 1,
      trigger: 'pull_request',
      branch: 'feat',
      title: 'title 3',
      start: Number(T0 + 20n * SEC - f.epoch),
    });
  });

  test('a window selects traces by their run row, then returns all their rows from any partition', async () => {
    const { ds, epoch } = await open(await writtenReport());
    const at = (s: number) => Number(T0 + BigInt(s) * SEC - epoch);
    // only C's root starts in this window; its tasks row is in the next partition
    const rows = await ds.cicdRows({ ...ALL, window: { start: at(7000), end: at(9000) } });
    expect(traces(rows)).toEqual([hex(4, 32)]);
    expect(rows.map((r) => r.kind).sort()).toEqual(['job', 'run', 'tasks']);
    // a window holding only mise spans selects nothing: the trace starts before it
    expect(await ds.cicdRows({ ...ALL, window: { start: at(8001), end: at(9000) } })).toEqual([]);
  });

  test('the run-level bindings and the pipeline narrow the runs and keep all their jobs; others are ignored', async () => {
    const { ds } = await open(await writtenReport());
    const push = await ds.cicdRows({
      ...ALL,
      bindings: [
        { key: 'cicd.pipeline.trigger', value: 'push' },
        { key: 'cicd.pipeline.task.name', value: 'test' },
        { key: 'cicd.worker.labels', value: 'nothing' },
      ],
    });
    expect(traces(push)).toEqual([hex(1, 32), hex(2, 32)]);
    expect(push.filter((r) => r.kind === 'job')).toHaveLength(2 + 2);
    const both = await ds.cicdRows({
      ...ALL,
      bindings: [
        { key: 'cicd.pipeline.trigger', value: 'push' },
        { key: 'vcs.ref.head.name', value: 'feat' },
      ],
    });
    expect(both).toEqual([]);
    expect(traces(await ds.cicdRows({ ...ALL, pipeline: 'ci' }))).toHaveLength(4);
    expect(await ds.cicdRows({ ...ALL, pipeline: 'other' })).toEqual([]);
  });
});

describe('cicdRows over partitions without the table', () => {
  test('a format-7 half, an upgraded half and a fully scanned report give the derived rows', {
    timeout: 60_000,
  }, async () => {
    const written = await writtenReport();
    const want = await (await open(written)).ds.cicdRows(ALL);
    expect(want.length).toBeGreaterThan(0);

    const half = without(written, (n) => n >= 2, 7);
    const mixed = await open(half);
    expect(await mixed.ds.cicdRows(ALL)).toEqual(want);
    // the flagged half is read from its files, the other half is scanned
    const spans = (n: number) => written.manifest.partitions[n]?.files.spans?.path ?? '';
    expect(mixed.prepared).toContain(spans(2));
    expect(mixed.prepared).toContain(spans(3));
    expect(mixed.prepared).not.toContain(spans(0));
    expect(mixed.prepared).not.toContain(spans(1));

    const upgraded = await open(without(written, (n) => n >= 2));
    expect(await upgraded.ds.cicdRows(ALL)).toEqual(want);

    const scanned = await open(without(written, () => true));
    expect(await scanned.ds.cicdRows(ALL)).toEqual(want);
    expect(scanned.prepared.filter(isSpans)).toHaveLength(written.manifest.partitions.length);

    // an all-derived rewrite and a mixed one combine to the same runs (Review Focus 1)
    expect(combineRuns(await mixed.ds.cicdRows(ALL))).toEqual(combineRuns(want));
  });

  test.each([
    ['the flagged half', (n: number) => n >= 2],
    ['the other half', (n: number) => n < 2],
    // C's root and job are scanned and its tasks row is stored, and the other way round
    ['only the partition of a root', (n: number) => n === 2],
    ['only the partition of the tasks', (n: number) => n === 3],
  ])(
    'a window and a binding hold across the flagged and scanned partitions (%s scanned)',
    async (_n, scan) => {
      const written = await writtenReport();
      const derived = await open(written);
      const mixed = await open(without(written, scan));
      const at = (s: number) => Number(T0 + BigInt(s) * SEC - written.epoch);
      for (const q of [
        { ...ALL, window: { start: at(7000), end: at(9000) } },
        { ...ALL, window: { start: at(0), end: at(100) } },
        { ...ALL, bindings: [{ key: 'vcs.ref.head.name', value: 'main' }] },
        { ...ALL, bindings: [{ key: 'cicd.pipeline.trigger', value: 'schedule' }] },
      ]) {
        expect(await mixed.ds.cicdRows(q), JSON.stringify(q)).toEqual(await derived.ds.cicdRows(q));
      }
    },
  );

  test('a report with no CI spans gives no rows, scanned or not', async () => {
    const w = createTestWriter();
    const session = await openSession(w.deps, {
      out: 'r',
      config: testConfig({ writer: { format: 'site' } }),
      mode: 'replace',
    });
    await session.add(otlp({ resourceSpans: other }), 'x');
    await session.close();
    const text = w.fs.snapshot().get('r/data/manifest.js') ?? '';
    const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
    if (!isPartitioned(manifest)) throw new Error('not a partition manifest');
    const files = new Map<string, Uint8Array>();
    for (const p of manifest.partitions)
      for (const table of TABLES) {
        const file = p.files[table];
        if (file !== undefined) files.set(file.path, await w.fs.readBytes(`r/${file.path}`));
      }
    const f = { manifest, files, epoch: BigInt(manifest.epochUnixNano) };
    expect(await (await open(f)).ds.cicdRows(ALL)).toEqual([]);
    expect(await (await open(without(f, () => true))).ds.cicdRows(ALL)).toEqual([]);
  });
});
