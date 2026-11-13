import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { resolveDeps } from '../../../src/api/report.js';
import {
  type ApplyOptions,
  applyUpdates,
  MAX_RUN_PARTITION_BYTES,
  scheduleDeletion,
} from '../../../src/cli/ci/deploy-apply.js';
import { runDeployApply } from '../../../src/cli/ci/deploy-main.js';
import type { PendingPlan, PendingUpdate } from '../../../src/cli/ci/deploy-plan.js';
import { readRunManifest } from '../../../src/cli/ci/run-report.js';
import type { SiteIndex, SiteRun } from '../../../src/cli/ci/site.js';
import { emptyState, readSiteState } from '../../../src/cli/ci/site-state.js';
import {
  parseUpdateName,
  type UpdateJson,
  type UpdatePartition,
  updateName,
} from '../../../src/cli/ci/update.js';
import type { CliIo } from '../../../src/cli/io.js';
import { wrapDataFile } from '../../../src/format/data-file.js';
import type { ManifestV4 } from '../../../src/format/manifest.js';
import { TABLES } from '../../../src/format/parquet/columns.js';
import { MANIFEST_KEY } from '../../../src/format/paths.js';
import type { WriterDeps } from '../../../src/writer/session.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  spansOnlyRequest,
} from '../../../test-support/format4-fixture.js';
import { writePushUpdate, writeUpdateDir } from '../../../test-support/update-dir.js';
import { fakeViewerAssets } from '../../../test-support/writer-deps.js';

const NOW = '2026-11-10T12:00:00.000Z';
const MIN = 60_000;
const minutesBefore = (n: number): string => new Date(Date.parse(NOW) - n * MIN).toISOString();
const MAIN = 'branch/main';
const MAIN_CHANNEL: Placement = {
  key: MAIN,
  channel: { kind: 'branch' as const, title: 'main', headBranch: 'main' },
};
const PR_CHANNEL: Placement = {
  key: 'pr/5',
  channel: { kind: 'pr' as const, title: '#5 fix', headBranch: 'fix' },
};

type Placement = NonNullable<PendingUpdate['channel']>;
let dir: string;
let site: string;
let updates: string;
let out: string[];
let deps: WriterDeps;
let flush: Format4Fixture; // three uncompacted partitions
let closed: Format4Fixture; // a closed (compacted) report
let nextId = 1000;

const io = (): CliIo =>
  ({
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => out.push(s),
    env: {},
    cwd: dir,
  }) as unknown as CliIo;

beforeAll(async () => {
  flush = await buildFormat4Report([spansOnlyRequest(4), spansOnlyRequest(4), spansOnlyRequest(4)], {
    close: false,
  });
  closed = await buildFormat4Report([spansOnlyRequest(6), spansOnlyRequest(6)]);
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deploy-apply-'));
  site = join(dir, 'site');
  updates = join(dir, 'updates');
  mkdirSync(site);
  mkdirSync(updates);
  out = [];
  deps = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytesOf = (f: Format4Fixture, path: string): Uint8Array => {
  const b = f.files.get(path);
  if (b === undefined) throw new Error(`fixture has no ${path}`);
  return b;
};

/** Fixture partition `i` as an update's partition at update-relative folder `at` (`partitions/<k>` or `ci`). */
function partitionOf(
  f: Format4Fixture,
  i: number,
  source: string,
  at: string,
  carried: boolean,
): { part: UpdatePartition; files: Record<string, Uint8Array> } {
  const entry = f.manifest.partitions[i];
  if (entry === undefined) throw new Error(`fixture has no partition ${i}`);
  const part: UpdatePartition = { source, files: {}, carried };
  const files: Record<string, Uint8Array> = {};
  for (const t of TABLES) {
    const file = entry.files[t];
    if (file === undefined) continue;
    const bytes = bytesOf(f, file.path);
    const path = `${at}/${t}.parquet`;
    part.files[t] = { ...file, path, bytes: bytes.length };
    if (carried) files[path] = bytes;
  }
  return { part, files };
}

interface PushSpec {
  job?: number;
  jobName?: string;
  runId?: number;
  attempt?: number;
  sequence: number;
  /** [source, fixture partition, carried] per listed partition. */
  parts: [string, number, boolean][];
  ci?: boolean;
  createdAt?: string;
}
function push(s: PushSpec): { u: UpdateJson; files: Record<string, Uint8Array> } {
  const files: Record<string, Uint8Array> = {};
  const partitions = s.parts.map(([source, i, carried], k) => {
    const p = partitionOf(flush, i, source, `partitions/${k}`, carried);
    Object.assign(files, p.files);
    return p.part;
  });
  const job = s.job ?? 7;
  const u: UpdateJson = {
    version: 1,
    kind: 'push',
    runId: s.runId ?? 42,
    runAttempt: s.attempt ?? 1,
    createdAt: s.createdAt ?? minutesBefore(5),
    jobId: job,
    jobName: s.jobName ?? 'build',
    sequence: s.sequence,
    partitions,
  };
  if (s.ci === true) {
    const c = partitionOf(flush, 2, `ci:${job}`, 'ci', true);
    Object.assign(files, c.files);
    u.ci = { ...c.part, carried: true };
  }
  return { u, files };
}

const siteRunOf = (runId: number, over: Partial<SiteRun> = {}): SiteRun => ({
  runId,
  attempt: 1,
  conclusion: 'success',
  headSha: 'abc',
  headBranch: 'main',
  startedAt: minutesBefore(30),
  completedAt: minutesBefore(1),
  runUrl: `https://github.com/o/r/actions/runs/${runId}`,
  reportPath: '',
  workflow: 'ci',
  ...over,
});

/** Writes the update's folder and returns the matching `pending.json` entry. */
function add(
  u: UpdateJson,
  files: Record<string, Uint8Array | string>,
  over: Partial<PendingUpdate> = {},
  channel = MAIN_CHANNEL,
): PendingUpdate {
  const name = updateName(u);
  const parsed = parseUpdateName(name);
  if (parsed === undefined) throw new Error(`bad name ${name}`);
  writeUpdateDir(join(updates, name), u, files);
  const isRun = u.kind === 'run';
  return {
    id: nextId++,
    name,
    parsed,
    createdAt: u.createdAt,
    sizeBytes: 1,
    uploader: {
      runId: isRun || u.kind === 'push' ? u.runId : u.runId,
      path: '.github/workflows/ci.yml',
      event: 'push',
      headBranch: 'main',
      sameRepo: true,
    },
    run: { ...siteRunOf(u.runId, { attempt: u.runAttempt }), event: isRun ? 'workflow_run' : 'push' },
    channel,
    ...(u.kind === 'push' ? { jobName: u.jobName } : {}),
    accepted: true,
    ...over,
  };
}
const addPush = (s: PushSpec, over: Partial<PendingUpdate> = {}, channel = MAIN_CHANNEL): PendingUpdate => {
  const { u, files } = push(s);
  return add(u, files, over, channel);
};

/** A `run` update: a fixture (the closed one) as `report/`, its manifest edited by `edit`. */
function addRun(
  runId: number,
  attempt = 1,
  edit: (m: ManifestV4) => ManifestV4 = (m) => m,
  channel = MAIN_CHANNEL,
  fx: Format4Fixture = closed,
): PendingUpdate {
  const manifest = edit({ ...fx.manifest, complete: true });
  const files: Record<string, Uint8Array | string> = {
    'report/index.html': '<!doctype html>',
    'report/.nojekyll': '',
    'report/data/manifest.js': wrapDataFile(MANIFEST_KEY, manifest),
  };
  for (const p of manifest.partitions)
    for (const f of Object.values(p.files)) files[`report/${f.path}`] = bytesOf(fx, f.path);
  const u: UpdateJson = { version: 1, kind: 'run', runId, runAttempt: attempt, createdAt: minutesBefore(2) };
  return add(u, files, {}, channel);
}

const pendingOf = (
  list: PendingUpdate[],
  base: PendingPlan['base'] = { kind: 'live', deploymentId: 9 },
): PendingPlan => ({
  version: 1,
  base,
  state: null,
  updates: list,
  deletionsDue: 0,
  floor: minutesBefore(65),
  now: NOW,
});

const apply = (list: PendingUpdate[], over: Partial<ApplyOptions> = {}) =>
  applyUpdates(
    {
      site,
      updates,
      pending: pendingOf(list),
      repository: 'o/r',
      retention: 30,
      prRetention: 10,
      passRunId: 100,
      now: NOW,
      ...over,
    },
    deps,
    io(),
  );

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const indexOf = (): SiteIndex => readJson(join(site, 'index.json'));
const manifestOf = async (path: string): Promise<ManifestV4> => {
  const m = await readRunManifest(deps.fs, join(site, path));
  if (m === null) throw new Error(`no manifest at ${path}`);
  return m;
};
const stateOf = () => readSiteState(deps.fs, join(site, 'site-state'), () => {});
const sources = (m: ManifestV4): string[] => m.partitions.map((p) => p.source);
const RUN42 = `${MAIN}/runs/42`;

describe('push', () => {
  test('on an empty base: the run folder, an in-progress index entry, the assets, the state', async () => {
    const p = addPush({
      sequence: 1,
      parts: [
        ['job:7#flush:0', 0, true],
        ['job:7#flush:1', 1, true],
      ],
      ci: true,
    });
    const r = await apply([p]);
    expect(r).toMatchObject({ changed: true, consumed: 1, deployed: true, previews: [], rejected: 0 });
    const m = await manifestOf(RUN42);
    expect(sources(m)).toEqual(['job:7#flush:0', 'job:7#flush:1', 'ci:7']);
    expect(m.complete).toBe(false);
    expect(existsSync(join(site, RUN42, 'data/partitions/000000/spans.parquet'))).toBe(true);
    const run = indexOf().channels[MAIN]?.runs[0];
    expect(run).toMatchObject({ runId: 42, conclusion: 'in_progress', reportPath: RUN42 });
    expect(existsSync(join(site, 'assets/9.9.9'))).toBe(true);
    const state = await stateOf();
    expect(state.runs.runs[RUN42]?.next).toBe(3);
    expect(state.applied.updates[p.id]?.outcome).toBe('applied');
    expect(state.applied.form).toEqual({ kind: 'full', runId: 100 });
    expect(Object.keys(state.files.files).some((f) => f.startsWith('site-state/'))).toBe(false);
    expect(state.files.files[`${RUN42}/data/manifest.js`]).toBeGreaterThan(0);
  });

  test('the epoch and range of a new run report come from the base tables, not a rollup grain floor', async () => {
    const { u, files } = push({ sequence: 1, parts: [['job:7#flush:0', 0, true]] });
    const part = u.partitions?.[0];
    const spans = part?.files.spans;
    if (part === undefined || spans === undefined) throw new Error('fixture has no spans');
    const path = 'partitions/0/span_rollups.parquet';
    const { timeEndMax: _end, ...base } = spans;
    part.files.span_rollups = {
      ...base,
      path,
      timeMin: '1000',
      rollup: { grainNs: 65_536_000_000, dimensions: [] },
    };
    files[path] = files['partitions/0/spans.parquet'] ?? new Uint8Array();
    const r = await apply([add(u, files)]);
    expect(r).toMatchObject({ changed: true, rejected: 0 });
    const m = await manifestOf(RUN42);
    expect(m.epochUnixNano).toBe(spans.timeMin);
    expect(m.range?.start).toBe(spans.timeMin);
  });

  test('on an old-publisher site without site-state: the other runs stay', async () => {
    mkdirSync(join(site, MAIN, 'runs/41'), { recursive: true });
    writeFileSync(join(site, MAIN, 'runs/41/index.html'), 'old');
    const old: SiteIndex = {
      version: 1,
      channels: {
        [MAIN]: { ...MAIN_CHANNEL.channel, runs: [siteRunOf(41, { reportPath: `${MAIN}/runs/41` })] },
      },
    };
    writeFileSync(join(site, 'index.json'), JSON.stringify(old));
    const r = await apply([addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]], ci: true })]);
    expect(r.changed).toBe(true);
    expect(indexOf().channels[MAIN]?.runs.map((x) => [x.runId, x.conclusion])).toEqual([
      [42, 'in_progress'],
      [41, 'success'],
    ]);
    expect(readFileSync(join(site, MAIN, 'runs/41/index.html'), 'utf8')).toBe('old');
    expect(sources(await manifestOf(RUN42))).toEqual(['job:7#flush:0', 'ci:7']);
  });

  test('the same pending again changes and consumes nothing', async () => {
    const p = addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] });
    await apply([p]);
    const before = readFileSync(join(site, 'site-state/applied.json'), 'utf8');
    const r = await apply([p]);
    expect(r).toMatchObject({ changed: false, consumed: 0, deployed: false });
    expect(readFileSync(join(site, 'site-state/applied.json'), 'utf8')).toBe(before);
  });

  test('a compacting update drops the flush partitions from the manifest and schedules their files', async () => {
    const first = addPush({
      sequence: 1,
      parts: [
        ['job:7#flush:0', 0, true],
        ['job:7#flush:1', 1, true],
      ],
    });
    await apply([first]);
    const second = addPush({ sequence: 2, parts: [['job:7#compact:0..1', 2, true]] });
    const r = await apply([second], { passRunId: 200 });
    expect(r.changed).toBe(true);
    const m = await manifestOf(RUN42);
    expect(sources(m)).toEqual(['job:7#compact:0..1']);
    expect(m.partitions[0]?.n).toBe(2);
    const dropped = ['000000', '000001'].map((p) => `${RUN42}/data/partitions/${p}/spans.parquet`);
    for (const d of dropped) expect(existsSync(join(site, d))).toBe(true);
    const state = await stateOf();
    for (const d of dropped) expect(state.deletions.files).toContainEqual({ path: d, pass: 200 });

    // a third pass: the drop went live 16 minutes ago, or 14
    const young = join(dir, 'young');
    cpSync(site, young, { recursive: true });
    const base = (liveAt: string): PendingPlan['base'] => ({
      kind: 'artifact',
      runId: 200,
      deploymentId: 10,
      liveAt,
    });
    const old = await apply([], { pending: pendingOf([], base(minutesBefore(16))), passRunId: 300 });
    expect(old.changed).toBe(true);
    for (const d of dropped) expect(existsSync(join(site, d))).toBe(false);
    expect(existsSync(join(site, RUN42, 'data/partitions/000002/spans.parquet'))).toBe(true);
    expect((await stateOf()).deletions.files).toEqual([]);
    const fresh = await apply([], {
      site: young,
      pending: pendingOf([], base(minutesBefore(14))),
      passRunId: 300,
    });
    expect(fresh.changed).toBe(false);
    for (const d of dropped) expect(existsSync(join(young, d))).toBe(true);
  });

  test('a listed partition whose file is nowhere keeps the job pending and the manifest as it was', async () => {
    await apply([addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] })]);
    const before = readFileSync(join(site, RUN42, 'data/manifest.js'), 'utf8');
    const waiting = addPush({
      sequence: 2,
      parts: [
        ['job:7#flush:0', 0, false],
        ['job:7#compact:3..5', 1, false],
      ],
    });
    const r = await apply([waiting], { passRunId: 101 });
    expect(r).toMatchObject({ changed: false, consumed: 0, pendingJobs: ['7'] });
    expect(readFileSync(join(site, RUN42, 'data/manifest.js'), 'utf8')).toBe(before);
    expect((await stateOf()).applied.updates[waiting.id]).toBeUndefined();
  });

  test('forged updates are rejected and recorded; the rest of the pass is applied', async () => {
    const good = addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] });
    // update.json names sequence 3, the artifact name says 2
    const named = push({ sequence: 3, job: 8, parts: [['job:8#flush:0', 1, true]] });
    const mismatched = add({ ...named.u, sequence: 2 }, named.files);
    writeUpdateDir(join(updates, mismatched.name), { ...named.u, sequence: 3 }, named.files);
    // the artifact was uploaded by another run
    const other = addPush(
      { sequence: 1, job: 9, parts: [['job:9#flush:0', 1, true]] },
      {
        uploader: {
          runId: 43,
          path: '.github/workflows/ci.yml',
          event: 'push',
          headBranch: 'x',
          sameRepo: true,
        },
      },
    );
    // a symlink in the tree
    const linked = addPush({ sequence: 1, job: 10, parts: [['job:10#flush:0', 1, true]] });
    symlinkSync('/etc/passwd', join(updates, linked.name, 'partitions/link.parquet'));
    // the plan's own rejection
    const refused = addPush(
      { sequence: 1, job: 11, parts: [['job:11#flush:0', 1, true]] },
      { accepted: false, reason: 'not a ci workflow' },
    );
    const r = await apply([good, mismatched, other, linked, refused]);
    expect(r).toMatchObject({ changed: true, consumed: 5, rejected: 4 });
    const state = await stateOf();
    for (const p of [mismatched, other, linked, refused])
      expect(state.applied.updates[p.id]?.outcome).toBe('rejected');
    expect(state.applied.updates[good.id]?.outcome).toBe('applied');
    expect(sources(await manifestOf(RUN42))).toEqual(['job:7#flush:0']);
  });

  test('an update.json that fails readUpdate is rejected with a warning', async () => {
    const bad = addPush({ sequence: 1, job: 8, parts: [['job:8#flush:0', 1, true]] });
    const json = readJson<UpdateJson>(join(updates, bad.name, 'update.json'));
    const p0 = json.partitions?.[0];
    if (p0 === undefined) throw new Error('no partition');
    const spans = p0.files.spans;
    if (spans === undefined) throw new Error('no spans');
    writeFileSync(
      join(updates, bad.name, 'update.json'),
      JSON.stringify({
        ...json,
        partitions: [{ ...p0, files: { spans: { ...spans, path: '../../index.html' } } }],
      }),
    );
    const good = addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] });
    const r = await apply([bad, good]);
    expect(r).toMatchObject({ consumed: 2, rejected: 1, changed: true });
    expect(out.join('')).toContain('::warning::');
    expect((await stateOf()).applied.updates[bad.id]?.outcome).toBe('rejected');
  });

  test('a run past the partition byte limit is rejected as too large', async () => {
    await apply([addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] })]);
    const m = await manifestOf(RUN42);
    const first = m.partitions[0];
    const spans = first?.files.spans;
    if (first === undefined || spans === undefined) throw new Error('no partition');
    const huge = {
      ...m,
      partitions: [{ ...first, files: { ...first.files, spans: { ...spans, bytes: 600 * 1024 * 1024 } } }],
    };
    writeFileSync(join(site, RUN42, 'data/manifest.js'), wrapDataFile(MANIFEST_KEY, huge));
    const p = addPush({
      sequence: 2,
      parts: [
        ['job:7#flush:0', 0, false],
        ['job:7#flush:9', 1, true],
      ],
    });
    const r = await apply([p], { passRunId: 101 });
    expect(r).toMatchObject({ changed: false, consumed: 1, rejected: 1 });
    expect((await stateOf()).applied.updates[p.id]?.outcome).toBe('rejected');
    expect(out.join('')).toContain('too large');
  });
});

describe('run', () => {
  const provisional = async (): Promise<void> => {
    await apply([
      addPush({
        sequence: 1,
        parts: [
          ['job:7#flush:0', 0, true],
          ['job:7#flush:1', 1, true],
          ['job:7#flush:2', 2, true],
        ],
      }),
    ]);
  };

  test('replaces provisional partitions by renumbered ones and defers the deletion of the old files', async () => {
    await provisional();
    const old = [0, 1, 2].map((n) => `${RUN42}/data/partitions/00000${n}/spans.parquet`);
    const bytes = old.map((p) => readFileSync(join(site, p)));
    const r = await apply([addRun(42)], { passRunId: 200 });
    expect(r).toMatchObject({ changed: true, consumed: 1, previews: [MAIN], rejected: 0 });
    const m = await manifestOf(RUN42);
    expect(m.complete).toBe(true);
    expect(m.partitions.map((p) => p.n)).toEqual(closed.manifest.partitions.map((_, i) => 3 + i));
    expect(m.engine.assetsBase).toBe('../../../../assets/9.9.9/');
    for (const [i, p] of old.entries())
      expect(readFileSync(join(site, p)).equals(bytes[i] ?? Buffer.alloc(0))).toBe(true);
    const state = await stateOf();
    for (const p of old) expect(state.deletions.files).toContainEqual({ path: p, pass: 200 });
    for (const p of m.partitions)
      for (const f of Object.values(p.files))
        expect(state.deletions.files.map((d) => d.path)).not.toContain(`${RUN42}/${f.path}`);
    expect(existsSync(join(site, MAIN, 'data/manifest.js'))).toBe(true);
    const badge = readJson<{ message: string }>(join(site, MAIN, 'badge-ci.json'));
    expect(badge.message).toMatch(/^✓/);
    expect(indexOf().channels[MAIN]?.runs[0]).toMatchObject({ runId: 42, conclusion: 'success' });
    expect(state.runs.runs[RUN42]?.next).toBe(3 + closed.manifest.partitions.length);
    expect(existsSync(join(site, 'assets'))).toBe(true);
  });

  test('a run update for a pull request channel previews nothing', async () => {
    const r = await apply([addRun(42, 1, (m) => m, PR_CHANNEL)]);
    expect(r).toMatchObject({ changed: true, previews: [] });
    expect(existsSync(join(site, 'pr/5/runs/42/data/manifest.js'))).toBe(true);
  });

  test('a run the state does not know numbers from one above the highest folder on disk', async () => {
    for (let n = 0; n < 5; n++) {
      mkdirSync(join(site, RUN42, `data/partitions/00000${n}`), { recursive: true });
      writeFileSync(join(site, RUN42, `data/partitions/00000${n}/spans.parquet`), 'x');
    }
    await apply([addRun(42)]);
    expect((await manifestOf(RUN42)).partitions[0]?.n).toBe(5);
  });

  test('retention drops the oldest runs: their files are scheduled and stay on disk', async () => {
    const runs = Array.from({ length: 31 }, (_, i) =>
      siteRunOf(i + 1, {
        completedAt: new Date(Date.parse(NOW) - (100 - i) * MIN).toISOString(),
        reportPath: `${MAIN}/runs/${i + 1}`,
      }),
    );
    for (const r of runs) {
      mkdirSync(join(site, r.reportPath), { recursive: true });
      writeFileSync(join(site, r.reportPath, 'index.html'), 'x');
    }
    const index: SiteIndex = {
      version: 1,
      channels: { [MAIN]: { ...MAIN_CHANNEL.channel, runs: [...runs].reverse() } },
    };
    writeFileSync(join(site, 'index.json'), JSON.stringify(index));
    await apply([addRun(42)], { passRunId: 200 });
    const state = await stateOf();
    expect(state.deletions.files).toContainEqual({ path: `${MAIN}/runs/1/index.html`, pass: 200 });
    expect(state.deletions.files).toContainEqual({ path: `${MAIN}/runs/2/index.html`, pass: 200 });
    expect(existsSync(join(site, MAIN, 'runs/1/index.html'))).toBe(true);
    expect(indexOf().channels[MAIN]?.runs.some((r) => r.runId === 1)).toBe(false);
    expect(indexOf().channels[MAIN]?.runs.some((r) => r.runId === 3)).toBe(true);
  });

  const rerunPush = (job: number, name: string, part: number, sequence = 1): PendingUpdate =>
    addPush(
      { sequence, job, jobName: name, attempt: 2, parts: [[`job:${job}#flush:0`, part, true]] },
      { jobAttempt: 2, run: { ...siteRunOf(42, { attempt: 2 }), event: 'push' } },
    );

  test('a push after the run for the same attempt is superseded; a re-run keeps the compacted partitions and adds its own', async () => {
    await apply([
      addPush({ sequence: 1, job: 7, jobName: 'build', parts: [['job:7#flush:0', 0, true]] }),
      addPush({ sequence: 1, job: 8, jobName: 'test', parts: [['job:8#flush:0', 1, true]] }),
    ]);
    await apply([addRun(42)], { passRunId: 200 });
    const finalSources = sources(await manifestOf(RUN42));
    expect(finalSources.every((x) => /^(compact|merge):/.test(x))).toBe(true);

    const late = addPush({ sequence: 2, job: 7, jobName: 'build', parts: [['job:7#flush:0', 0, false]] });
    const r1 = await apply([late], { passRunId: 201 });
    expect(r1).toMatchObject({ changed: false, consumed: 1 });
    expect((await stateOf()).applied.updates[late.id]?.outcome).toBe('superseded');

    const r2 = await apply([rerunPush(17, 'build', 2)], { passRunId: 202 });
    expect(r2.changed).toBe(true);
    const m = await manifestOf(RUN42);
    expect(m.complete).toBe(false);
    expect(sources(m)).toEqual([...finalSources, 'job:17#flush:0']);
    expect(indexOf().channels[MAIN]?.runs[0]).toMatchObject({ attempt: 2, conclusion: 'in_progress' });
  });

  test('in a push-only run, a re-run of one job drops its attempt-1 partitions (scheduled, still on disk) and keeps the others', async () => {
    await apply([
      addPush({ sequence: 1, job: 7, jobName: 'build', parts: [['job:7#flush:0', 0, true]] }),
      addPush({ sequence: 1, job: 8, jobName: 'test', parts: [['job:8#flush:0', 1, true]] }),
    ]);
    const before = await manifestOf(RUN42);
    const buildFile = before.partitions.find((p) => p.source === 'job:7#flush:0')?.files.spans?.path;
    if (buildFile === undefined) throw new Error('no build partition');
    await apply([rerunPush(17, 'build', 2)], { passRunId: 201 });
    const m = await manifestOf(RUN42);
    expect(sources(m)).toEqual(['job:8#flush:0', 'job:17#flush:0']);
    expect(existsSync(join(site, RUN42, buildFile))).toBe(true);
    expect((await stateOf()).deletions.files).toContainEqual({ path: `${RUN42}/${buildFile}`, pass: 201 });
  });

  test('a run update older than the report attempt is superseded', async () => {
    await apply([addRun(42, 2)]);
    const r = await apply([addRun(42, 1)], { passRunId: 101 });
    expect(r).toMatchObject({ changed: false, consumed: 1 });
  });
});

describe('run update failures and checks', () => {
  test('a run update whose report has no manifest is rejected, schedules nothing, and the pass goes on', async () => {
    await apply([addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] })]);
    const bad = addRun(42);
    rmSync(join(updates, bad.name, 'report/data/manifest.js'));
    const good = addPush({ sequence: 1, job: 8, parts: [['job:8#flush:0', 1, true]] });
    const r = await apply([bad, good], { passRunId: 200 });
    expect(r).toMatchObject({ consumed: 2, rejected: 1, changed: true });
    const state = await stateOf();
    expect(state.applied.updates[bad.id]?.outcome).toBe('rejected');
    expect(state.applied.updates[good.id]?.outcome).toBe('applied');
    expect(state.deletions.files).toEqual([]);
  });

  test('a run update naming a later attempt than the run has is rejected', async () => {
    const p = addRun(42, 3);
    const r = await apply([{ ...p, run: p.run && { ...p.run, attempt: 2 } }]);
    expect(r).toMatchObject({ rejected: 1, changed: false });
  });

  test('a push naming a later attempt than the run, or than its job, is rejected', async () => {
    const tooNew = addPush(
      { sequence: 1, attempt: 3, parts: [['job:7#flush:0', 0, true]] },
      { run: { ...siteRunOf(42, { attempt: 2 }), event: 'push' } },
    );
    const wrongJob = addPush(
      { sequence: 1, job: 8, attempt: 2, parts: [['job:8#flush:0', 1, true]] },
      { jobAttempt: 1, run: { ...siteRunOf(42, { attempt: 2 }), event: 'push' } },
    );
    const r = await apply([tooNew, wrongJob]);
    expect(r).toMatchObject({ rejected: 2, consumed: 2, changed: false });
    expect(out.join('')).toContain('names attempt 3');
    expect(out.join('')).toContain('belongs to attempt 1');
  });
});

describe('pull requests', () => {
  test('remove-pr schedules the folder, a push for it is removed-pr until reopen-pr', async () => {
    await apply([addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] }, {}, PR_CHANNEL)]);
    expect(existsSync(join(site, 'pr/5/runs/42/data/manifest.js'))).toBe(true);
    const removal: UpdateJson = {
      version: 1,
      kind: 'remove-pr',
      runId: 50,
      runAttempt: 1,
      createdAt: minutesBefore(4),
      pr: 5,
    };
    const removed = add(removal, {}, { channel: null, run: null });
    const r = await apply([removed], { passRunId: 200 });
    expect(r.changed).toBe(true);
    expect(indexOf().channels['pr/5']).toBeUndefined();
    const state = await stateOf();
    expect(state.deletions.files.map((d) => d.path)).toContain('pr/5/runs/42/data/manifest.js');
    expect(existsSync(join(site, 'pr/5/runs/42/data/manifest.js'))).toBe(true);
    expect(state.removed.prs['5']).toEqual({ runId: 50, at: NOW });

    const blocked = addPush({ sequence: 2, parts: [['job:7#flush:0', 0, true]] }, {}, PR_CHANNEL);
    await apply([blocked], { passRunId: 201 });
    expect((await stateOf()).applied.updates[blocked.id]?.outcome).toBe('removed-pr');
    expect(indexOf().channels['pr/5']).toBeUndefined();

    const reopen: UpdateJson = {
      version: 1,
      kind: 'reopen-pr',
      runId: 51,
      runAttempt: 1,
      createdAt: minutesBefore(3),
      pr: 5,
    };
    const again = addPush({ sequence: 3, job: 8, parts: [['job:8#flush:0', 1, true]] }, {}, PR_CHANNEL);
    await apply([add(reopen, {}, { channel: null, run: null }), again], { passRunId: 202 });
    const state2 = await stateOf();
    expect(state2.removed.prs['5']).toBeUndefined();
    expect(state2.applied.updates[again.id]?.outcome).toBe('applied');
    expect(indexOf().channels['pr/5']?.runs[0]?.conclusion).toBe('in_progress');
    // the run folder written again is live again
    expect(state2.deletions.files.map((d) => d.path)).not.toContain('pr/5/runs/42/data/manifest.js');
  });
});

describe('removed runs', () => {
  test('after remove-pr and reopen-pr, the same push is applied to a fresh manifest', async () => {
    const same = (): PendingUpdate =>
      addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] }, {}, PR_CHANNEL);
    await apply([same()]);
    const removal: UpdateJson = {
      version: 1,
      kind: 'remove-pr',
      runId: 50,
      runAttempt: 1,
      createdAt: minutesBefore(4),
      pr: 5,
    };
    const reopen: UpdateJson = {
      version: 1,
      kind: 'reopen-pr',
      runId: 51,
      runAttempt: 1,
      createdAt: minutesBefore(3),
      pr: 5,
    };
    await apply([add(removal, {}, { channel: null, run: null })], { passRunId: 200 });
    expect((await stateOf()).runs.runs['pr/5/runs/42']).toBeUndefined();
    await apply([add(reopen, {}, { channel: null, run: null })], { passRunId: 201 });
    const again = same();
    await apply([again], { passRunId: 202 });
    expect(sources(await manifestOf('pr/5/runs/42'))).toEqual(['job:7#flush:0']);
    expect((await stateOf()).applied.updates[again.id]?.outcome).toBe('applied');
  });
});

describe('the pass', () => {
  test('a pass whose updates are all superseded records the consumed-only form', async () => {
    await apply([addRun(42)]);
    const late = [
      addPush({ sequence: 1, job: 7, parts: [['job:7#flush:0', 0, true]] }),
      addPush({ sequence: 1, job: 8, parts: [['job:8#flush:0', 1, true]] }),
    ];
    const r = await apply(late, {
      passRunId: 101,
      pending: pendingOf(late, { kind: 'live', deploymentId: 77, runId: 100 }),
    });
    expect(r).toMatchObject({ changed: false, consumed: 2, deployed: false });
    const { applied } = await stateOf();
    expect(applied.form).toEqual({ kind: 'consumed', base: 77 });
    expect(late.map((p) => applied.updates[p.id]?.outcome)).toEqual(['superseded', 'superseded']);
  });

  test('retry updates stay pending and are not recorded', async () => {
    const p = addPush(
      { sequence: 1, parts: [['job:7#flush:0', 0, true]] },
      { accepted: false, retry: true, reason: 'download failed' },
    );
    const r = await apply([p]);
    expect(r).toMatchObject({ changed: false, consumed: 0 });
    expect(existsSync(join(site, 'site-state'))).toBe(false);
  });

  test('the chosen state overwrites the base tarball site-state', async () => {
    mkdirSync(join(site, 'site-state'), { recursive: true });
    writeFileSync(join(site, 'site-state/applied.json'), 'garbage');
    const chosen = join(dir, 'chosen');
    const first = await apply([addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] })]);
    expect(first.changed).toBe(true);
    cpSync(join(site, 'site-state'), chosen, { recursive: true });
    writeFileSync(join(site, 'site-state/applied.json'), 'garbage');
    const again = await apply([], { state: chosen, passRunId: 101 });
    expect(again.consumed).toBe(0);
    expect(readJson<{ form: unknown }>(join(site, 'site-state/applied.json')).form).toEqual({
      kind: 'full',
      runId: 100,
    });
  });

  test('a --state folder that does not exist leaves the base site-state in place', async () => {
    const first = await apply([addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] })]);
    expect(first.changed).toBe(true);
    const before = readFileSync(join(site, 'site-state/applied.json'), 'utf8');
    const again = await apply([], { state: join(dir, 'no-such-state'), passRunId: 101 });
    expect(again.consumed).toBe(0);
    expect(readFileSync(join(site, 'site-state/applied.json'), 'utf8')).toBe(before);
  });

  test('--trust-updates applies update folders without pending.json entries', async () => {
    const a = push({ sequence: 1, job: 7, parts: [['job:7#flush:0', 0, true]] });
    const b = push({ sequence: 1, job: 8, parts: [['job:8#flush:0', 1, true]] });
    for (const x of [a, b]) writePushUpdate(join(updates, updateName(x.u)), x.u, x.files);
    const r = await apply([], { trust: { channel: 'branch/smoke' } });
    expect(r).toMatchObject({ changed: true, consumed: 2, rejected: 0 });
    const m = await manifestOf('branch/smoke/runs/42');
    expect(sources(m)).toEqual(['job:7#flush:0', 'job:8#flush:0']);
    expect(indexOf().channels['branch/smoke']?.runs[0]?.conclusion).toBe('in_progress');
  });
});

describe('scheduleDeletion', () => {
  test("lists a folder's files recursively and a file itself, removes nothing, keeps an earlier entry", async () => {
    mkdirSync(join(site, 'a/b'), { recursive: true });
    writeFileSync(join(site, 'a/one'), '1');
    writeFileSync(join(site, 'a/b/two'), '2');
    writeFileSync(join(site, 'three'), '3');
    const state = emptyState(NOW);
    state.deletions.files.push({ path: 'a/one', pass: 5, liveAt: NOW });
    await scheduleDeletion(state, site, ['a', 'three', 'missing'], 9);
    expect(state.deletions.files).toEqual([
      { path: 'a/one', pass: 5, liveAt: NOW },
      { path: 'a/b/two', pass: 9 },
      { path: 'three', pass: 9 },
    ]);
    expect(existsSync(join(site, 'a/b/two'))).toBe(true);
    await expect(scheduleDeletion(state, site, ['../x'], 9)).rejects.toThrow(/not inside/);
  });

  test('a run report holds at most 512 MiB of partitions', () => {
    expect(MAX_RUN_PARTITION_BYTES).toBe(512 * 1024 * 1024);
  });
});

describe('runDeployApply', () => {
  test('applies trusted folders without pending.json and prints the step outputs', async () => {
    const a = push({ sequence: 1, job: 7, parts: [['job:7#flush:0', 0, true]] });
    writePushUpdate(join(updates, updateName(a.u)), a.u, a.files);
    const result = await runDeployApply(
      {
        site,
        updates,
        repository: 'o/r',
        retention: 30,
        prRetention: 10,
        passRunId: 5,
        trust: { channel: 'branch/smoke' },
        now: NOW,
      },
      io(),
      deps,
    );
    expect(result).toMatchObject({ changed: true, consumed: 1 });
    const text = out.join('');
    expect(text).toContain('changed=true');
    expect(text).toContain('consumed=1');
    expect(text).toContain('deploy=true');
    expect(text).toContain('pending_jobs=\n');
  });
});
