import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
import { runSource } from '../../../src/cli/ci/main-report.js';
import { mergeWithConfig } from '../../../src/cli/ci/publish-io.js';
import { BRANCH_KEY } from '../../../src/cli/ci/report-links.js';
import { readRunManifest } from '../../../src/cli/ci/run-report.js';
import type { SiteIndex, SiteRun } from '../../../src/cli/ci/site.js';
import { emptyState, readSiteState, writeSiteState } from '../../../src/cli/ci/site-state.js';
import {
  parseUpdateName,
  type UpdateJson,
  type UpdatePartition,
  updateName,
} from '../../../src/cli/ci/update.js';
import type { CliIo } from '../../../src/cli/io.js';
import { wrapDataFile } from '../../../src/format/data-file.js';
import { engineAssetNames } from '../../../src/format/engine.js';
import { type ManifestV4, manifestForWrite } from '../../../src/format/manifest.js';
import { TABLES } from '../../../src/format/parquet/columns.js';
import { MANIFEST_KEY } from '../../../src/format/paths.js';
import type { WriterDeps } from '../../../src/writer/session.js';
import { writeCiRunReport } from '../../../test-support/ci-run-fixture.js';
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
  recorded: Partial<UpdateJson> = {},
  planRun: Partial<SiteRun> = {},
): PendingUpdate {
  const manifest = edit({ ...fx.manifest, complete: true });
  const files: Record<string, Uint8Array | string> = {
    'report/index.html': '<!doctype html>',
    'report/.nojekyll': '',
    'report/data/manifest.js': wrapDataFile(MANIFEST_KEY, manifest),
  };
  for (const p of manifest.partitions)
    for (const f of Object.values(p.files)) files[`report/${f.path}`] = bytesOf(fx, f.path);
  const u: UpdateJson = {
    version: 1,
    kind: 'run',
    runId,
    runAttempt: attempt,
    createdAt: minutesBefore(2),
    ...recorded,
  };
  const pending = add(u, files, {}, channel);
  return pending.run === null ? pending : { ...pending, run: { ...pending.run, ...planRun } };
}

const filesUnder = (root: string, rel = ''): string[] =>
  readdirSync(join(root, rel)).flatMap((n) => {
    const r = rel === '' ? n : `${rel}/${n}`;
    return statSync(join(root, r)).isDirectory() ? filesUnder(root, r) : [r];
  });

/** A `run` update of a real CI run report (CI spans, test spans, a log and a gauge), as `ci report` leaves it. */
async function addCiRun(
  runId: number,
  o: { attempt?: number; completedMin?: number; channel?: Placement } = {},
): Promise<PendingUpdate> {
  const attempt = o.attempt ?? 1;
  const channel = o.channel ?? MAIN_CHANNEL;
  const out = join(dir, `ci-run-${runId}-${attempt}`);
  await writeCiRunReport(deps, out, {
    repository: 'o/r',
    runId,
    attempt,
    branch: channel.channel.headBranch,
    startMs: Date.parse(NOW) - (o.completedMin ?? 1) * MIN,
  });
  const files: Record<string, Uint8Array | string> = {};
  for (const f of filesUnder(out).filter((x) => !x.startsWith('assets/') && !x.startsWith('data/state/')))
    files[`report/${f}`] = readFileSync(join(out, f));
  const u: UpdateJson = { version: 1, kind: 'run', runId, runAttempt: attempt, createdAt: minutesBefore(2) };
  const pending = add(u, files, {}, channel);
  return pending.run === null
    ? pending
    : { ...pending, run: { ...pending.run, completedAt: minutesBefore(o.completedMin ?? 1) } };
}

const removalOf = (pr: number, runId: number, at: number, kind: 'remove-pr' | 'reopen-pr' = 'remove-pr') =>
  add(
    { version: 1, kind, runId, runAttempt: 1, createdAt: minutesBefore(at), pr },
    {},
    { channel: null, run: null },
  );
const runsOf = (key: string) => indexOf().channels[key]?.runs ?? [];
const partitionsOf = async (runId: number) =>
  (await manifestOf(MAIN)).partitions.filter((p) => p.source.startsWith(`run:${runId}#`));

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
  defaultBranch: 'main',
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
      slimRetention: 100,
      prSlimRetention: 100,
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
    expect(existsSync(join(site, 'assets/viewer.abc123.js'))).toBe(true);
    const state = await stateOf();
    expect(state.runs.runs[RUN42]?.next).toBe(3);
    expect(state.applied.updates[p.id]?.outcome).toBe('applied');
    expect(state.applied.form).toEqual({ kind: 'full', runId: 100, runAttempt: 1 });
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
    writeFileSync(join(site, RUN42, 'data/manifest.js'), wrapDataFile(MANIFEST_KEY, manifestForWrite(huge)));
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

describe('run', { timeout: 30_000 }, () => {
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

  describe('a run update of a run that was unfinished when planned', () => {
    const endedAt = minutesBefore(3);
    const recorded = { conclusion: 'failure', completedAt: endedAt };
    const entry = () => indexOf().channels[MAIN]?.runs.find((r) => r.runId === 42);

    test("the recorded conclusion and end stand in for the API run's unknown", async () => {
      await apply([addRun(42, 1, (m) => m, MAIN_CHANNEL, closed, recorded, { conclusion: 'unknown' })]);
      expect(entry()).toMatchObject({ conclusion: 'failure', completedAt: endedAt });
      expect(readJson<{ message: string }>(join(site, MAIN, 'badge-ci.json')).message).not.toMatch(/^✓/);
    });

    test("recorded values win over a completed API run, and the attempt is the update's", async () => {
      await apply([
        addRun(42, 2, (m) => m, MAIN_CHANNEL, closed, recorded, { conclusion: 'success', attempt: 3 }),
      ]);
      expect(entry()).toMatchObject({ conclusion: 'failure', completedAt: endedAt, attempt: 2 });
    });

    test("without recorded fields a completed API run's values stand", async () => {
      await apply([addRun(42, 1, (m) => m, MAIN_CHANNEL, closed, {}, { conclusion: 'success' })]);
      expect(entry()).toMatchObject({ conclusion: 'success' });
      expect(entry()?.completedAt).not.toBe(endedAt);
    });

    test("an update without the fields keeps the plan's values", async () => {
      await apply([addRun(42, 1, (m) => m, MAIN_CHANNEL, closed, {}, { conclusion: 'unknown' })]);
      expect(entry()).toMatchObject({ conclusion: 'unknown' });
    });
  });

  test('a run update adds its partitions to branch/main under run:<id>#<attempt>, indexes it full with its reportUrl, and previews main', async () => {
    const p = await addCiRun(42);
    const url = 'https://example.org/report/42/';
    writeFileSync(
      join(updates, p.name, 'update.json'),
      JSON.stringify({ ...readJson<UpdateJson>(join(updates, p.name, 'update.json')), reportUrl: url }),
    );
    const r = await apply([p]);
    expect(r).toMatchObject({ changed: true, consumed: 1, previews: [MAIN], rejected: 0 });
    const m = await manifestOf(MAIN);
    expect(sources(m)).toEqual(m.partitions.map(() => runSource(42, 1)));
    expect(m.partitions.length).toBeGreaterThan(0);
    expect(m.complete).toBe(true);
    expect(m.engine.assetsBase).toBe('../../assets/');
    expect(runsOf(MAIN)[0]).toMatchObject({ runId: 42, reportPath: MAIN, detail: 'full', reportUrl: url });
    expect(existsSync(join(site, MAIN, 'runs'))).toBe(false);
    expect(readJson<{ message: string }>(join(site, MAIN, 'badge-ci.json')).message).toMatch(/^✓/);
    expect(existsSync(join(site, 'assets'))).toBe(true);
  });

  test('a pull request run goes into the same report under its pr channel', async () => {
    const r = await apply([await addCiRun(42, { channel: PR_CHANNEL })]);
    expect(r).toMatchObject({ changed: true, previews: [MAIN] });
    expect(runsOf('pr/5')[0]).toMatchObject({ runId: 42, reportPath: MAIN, detail: 'full' });
    expect(indexOf().channels[MAIN]).toBeUndefined();
    expect(existsSync(join(site, 'pr'))).toBe(false);
    expect((await partitionsOf(42)).length).toBeGreaterThan(0);
  });

  test('a re-run replaces the earlier attempt: its partitions are scheduled, numbers go up', async () => {
    await apply([await addCiRun(42)]);
    const first = await partitionsOf(42);
    const oldFiles = first.flatMap((p) => Object.values(p.files).map((f) => `${MAIN}/${f.path}`));
    await apply([await addCiRun(42, { attempt: 2 })], { passRunId: 200 });
    const again = await partitionsOf(42);
    expect(again.map((p) => p.source)).toEqual(again.map(() => runSource(42, 2)));
    expect(Math.min(...again.map((p) => p.n))).toBeGreaterThan(Math.max(...first.map((p) => p.n)));
    const state = await stateOf();
    for (const f of oldFiles) {
      expect(state.deletions.files).toContainEqual({ path: f, pass: 200 });
      expect(existsSync(join(site, f))).toBe(true);
    }
    expect(runsOf(MAIN)).toHaveLength(1);
    expect(runsOf(MAIN)[0]).toMatchObject({ attempt: 2 });
  });

  test('a re-run of a run already slim comes back full and its slim partition is scheduled', async () => {
    await apply([await addCiRun(1, { completedMin: 30 })]);
    await apply([await addCiRun(2, { completedMin: 20 })], { retention: 1, passRunId: 101 });
    expect(runsOf(MAIN).find((r) => r.runId === 1)?.detail).toBe('slim');
    const slim = (await partitionsOf(1)).flatMap((p) =>
      Object.values(p.files).map((f) => `${MAIN}/${f.path}`),
    );
    expect(slim.length).toBeGreaterThan(0);
    await apply([await addCiRun(1, { attempt: 2, completedMin: 5 })], { retention: 1, passRunId: 102 });
    const entry = runsOf(MAIN).find((r) => r.runId === 1);
    expect(entry).toMatchObject({ attempt: 2, detail: 'full' });
    expect((await partitionsOf(1)).some((p) => p.files.logs !== undefined)).toBe(true);
    const state = await stateOf();
    for (const f of slim) expect(state.deletions.files.map((d) => d.path)).toContain(f);
  });

  test('tiers: the newest run stays full, the next is trimmed (spans only), the oldest is dropped; the index says so', async () => {
    const tiers = { retention: 1, slimRetention: 2 };
    await apply([await addCiRun(1, { completedMin: 30 })], { ...tiers, passRunId: 101 });
    await apply([await addCiRun(2, { completedMin: 20 })], { ...tiers, passRunId: 102 });
    expect(runsOf(MAIN).map((r) => [r.runId, r.detail])).toEqual([
      [2, 'full'],
      [1, 'slim'],
    ]);
    const full = await partitionsOf(1);
    const oldFiles = full.flatMap((p) => Object.values(p.files).map((f) => `${MAIN}/${f.path}`));
    await apply([await addCiRun(3, { completedMin: 10 })], { ...tiers, passRunId: 103 });
    expect(runsOf(MAIN).map((r) => [r.runId, r.detail])).toEqual([
      [3, 'full'],
      [2, 'slim'],
    ]);
    expect(await partitionsOf(1)).toEqual([]);
    const two = await partitionsOf(2);
    expect(two.length).toBeGreaterThan(0);
    expect(two.every((p) => p.files.logs === undefined && p.files.spans !== undefined)).toBe(true);
    expect((await partitionsOf(3)).some((p) => p.files.logs !== undefined)).toBe(true);
    const state = await stateOf();
    for (const f of oldFiles) expect(state.deletions.files.map((d) => d.path)).toContain(f);
    expect(existsSync(join(site, oldFiles[0] ?? ''))).toBe(true);
  });

  test('a trimming failure warns, keeps the run full and the pass goes on', async () => {
    await apply([await addCiRun(1, { completedMin: 30 })], { passRunId: 101 });
    for (const p of await partitionsOf(1)) {
      const f = p.files.spans;
      if (f !== undefined) writeFileSync(join(site, MAIN, f.path), 'not parquet');
    }
    const r = await apply([await addCiRun(2, { completedMin: 20 })], { retention: 1, passRunId: 102 });
    expect(r).toMatchObject({ changed: true, rejected: 0 });
    expect(out.join('')).toMatch(/warning|::warning/i);
    expect(runsOf(MAIN).map((x) => [x.runId, x.detail])).toEqual([
      [2, 'full'],
      [1, 'full'],
    ]);
    expect((await partitionsOf(2)).length).toBeGreaterThan(0);
  });

  test('a staging folder of the run (push updates) is scheduled when the run update applies', async () => {
    await provisional();
    const staged = [0, 1, 2].map((n) => `${RUN42}/data/partitions/00000${n}/spans.parquet`);
    await apply([addRun(42)], { passRunId: 200 });
    const state = await stateOf();
    for (const p of staged) {
      expect(state.deletions.files).toContainEqual({ path: p, pass: 200 });
      expect(existsSync(join(site, p))).toBe(true);
    }
    expect(state.runs.runs[RUN42]).toBeUndefined();
    expect(state.runs.runs[MAIN]).toMatchObject({ attempt: 0 });
    expect(runsOf(MAIN)[0]).toMatchObject({ runId: 42, reportPath: MAIN, conclusion: 'success' });
    expect((await manifestOf(MAIN)).partitions.map((p) => p.source)).toEqual(
      closed.manifest.partitions.map(() => runSource(42, 1)),
    );
  });

  test('a run the state does not know numbers from one above the highest folder on disk', async () => {
    for (let n = 0; n < 5; n++) {
      mkdirSync(join(site, MAIN, `data/partitions/00000${n}`), { recursive: true });
      writeFileSync(join(site, MAIN, `data/partitions/00000${n}/spans.parquet`), 'x');
    }
    await apply([addRun(42)]);
    expect((await manifestOf(MAIN)).partitions[0]?.n).toBe(5);
  });

  const rerunPush = (job: number, name: string, part: number, sequence = 1): PendingUpdate =>
    addPush(
      { sequence, job, jobName: name, attempt: 2, parts: [[`job:${job}#flush:0`, part, true]] },
      { jobAttempt: 2, run: { ...siteRunOf(42, { attempt: 2 }), event: 'push' } },
    );

  test('a push after the run for the same attempt is superseded; a re-run pushes into a fresh staging folder', async () => {
    await apply([
      addPush({ sequence: 1, job: 7, jobName: 'build', parts: [['job:7#flush:0', 0, true]] }),
      addPush({ sequence: 1, job: 8, jobName: 'test', parts: [['job:8#flush:0', 1, true]] }),
    ]);
    await apply([addRun(42)], { passRunId: 200 });

    const late = addPush({ sequence: 2, job: 7, jobName: 'build', parts: [['job:7#flush:0', 0, false]] });
    const r1 = await apply([late], { passRunId: 201 });
    expect(r1).toMatchObject({ changed: false, consumed: 1 });
    expect((await stateOf()).applied.updates[late.id]?.outcome).toBe('superseded');

    const r2 = await apply([rerunPush(17, 'build', 2)], { passRunId: 202 });
    expect(r2.changed).toBe(true);
    const m = await manifestOf(RUN42);
    expect(m.complete).toBe(false);
    expect(sources(m)).toEqual(['job:17#flush:0']);
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

  test('a run update older than the indexed attempt is superseded', async () => {
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

describe('pull requests', { timeout: 30_000 }, () => {
  test('remove-pr marks the channel closed and trims its runs; a push or run for it is removed-pr until reopen-pr', async () => {
    await apply([await addCiRun(42, { channel: PR_CHANNEL })]);
    expect(runsOf('pr/5')[0]?.detail).toBe('full');
    const r = await apply([removalOf(5, 50, 4)], { passRunId: 200 });
    expect(r.changed).toBe(true);
    expect(indexOf().channels['pr/5']).toMatchObject({ closedAt: NOW });
    expect(runsOf('pr/5')[0]).toMatchObject({ runId: 42, detail: 'slim' });
    expect((await partitionsOf(42)).every((p) => p.files.logs === undefined)).toBe(true);
    const state = await stateOf();
    expect(state.removed.prs['5']).toEqual({ runId: 50, at: NOW });

    const blocked = addPush({ sequence: 2, parts: [['job:7#flush:0', 0, true]] }, {}, PR_CHANNEL);
    const blockedRun = await addCiRun(43, { channel: PR_CHANNEL });
    await apply([blocked, blockedRun], { passRunId: 201 });
    const after = await stateOf();
    expect(after.applied.updates[blocked.id]?.outcome).toBe('removed-pr');
    expect(after.applied.updates[blockedRun.id]?.outcome).toBe('removed-pr');
    expect(runsOf('pr/5').map((x) => x.runId)).toEqual([42]);
  });

  test('a legacy pr/<n> folder still on disk is scheduled by remove-pr', async () => {
    mkdirSync(join(site, 'pr/5/runs/1'), { recursive: true });
    writeFileSync(join(site, 'pr/5/runs/1/index.html'), 'x');
    await apply([removalOf(5, 50, 4)], { passRunId: 200 });
    expect((await stateOf()).deletions.files).toContainEqual({ path: 'pr/5/runs/1/index.html', pass: 200 });
    expect(existsSync(join(site, 'pr/5/runs/1/index.html'))).toBe(true);
  });

  test('reopen-pr clears closedAt; a new run arrives full while the old ones stay slim', async () => {
    await apply([await addCiRun(42, { channel: PR_CHANNEL, completedMin: 30 })]);
    await apply([removalOf(5, 50, 4)], { passRunId: 200 });
    await apply(
      [removalOf(5, 51, 3, 'reopen-pr'), await addCiRun(43, { channel: PR_CHANNEL, completedMin: 10 })],
      {
        passRunId: 201,
      },
    );
    const ch = indexOf().channels['pr/5'];
    expect(ch?.closedAt).toBeUndefined();
    expect(ch?.runs.map((x) => [x.runId, x.detail])).toEqual([
      [43, 'full'],
      [42, 'slim'],
    ]);
    expect((await stateOf()).removed.prs['5']).toBeUndefined();
  });

  test('the pool drops the oldest slim pull request runs across channels and removes an emptied channel', async () => {
    const pr6: Placement = { key: 'pr/6', channel: { kind: 'pr', title: '#6 other', headBranch: 'other' } };
    await apply([await addCiRun(42, { channel: PR_CHANNEL, completedMin: 30 })], { passRunId: 101 });
    await apply([await addCiRun(43, { channel: pr6, completedMin: 20 })], { passRunId: 102 });
    const old = (await partitionsOf(42)).flatMap((p) =>
      Object.values(p.files).map((f) => `${MAIN}/${f.path}`),
    );
    await apply([removalOf(5, 50, 4), removalOf(6, 51, 3)], { passRunId: 200, prSlimRetention: 1 });
    const ix = indexOf();
    expect(ix.channels['pr/5']).toBeUndefined();
    expect(ix.channels['pr/6']?.runs.map((x) => [x.runId, x.detail])).toEqual([[43, 'slim']]);
    expect(await partitionsOf(42)).toEqual([]);
    const state = await stateOf();
    for (const f of old) expect(state.deletions.files.map((d) => d.path)).toContain(f);
  });
});

describe('removed runs', () => {
  test('after remove-pr and reopen-pr, the same push is applied', async () => {
    const same = (): PendingUpdate =>
      addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] }, {}, PR_CHANNEL);
    await apply([same()]);
    await apply([removalOf(5, 50, 4)], { passRunId: 200 });
    expect((await stateOf()).runs.runs['pr/5/runs/42']).toBeUndefined();
    await apply([removalOf(5, 51, 3, 'reopen-pr')], { passRunId: 201 });
    const again = same();
    await apply([again], { passRunId: 202 });
    expect((await stateOf()).applied.updates[again.id]?.outcome).toBe('applied');
  });
});

describe('assets on the deletion list', () => {
  test('an asset file scheduled while nothing referenced it leaves deletions.json once a report references it', async () => {
    await apply([addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] })]);
    const referenced = 'assets/viewer.abc123.js';
    expect(existsSync(join(site, referenced))).toBe(true);
    const state = await stateOf();
    state.deletions.files.push({ path: referenced, pass: 5 }, { path: 'assets/unused.js', pass: 5 });
    await writeSiteState(deps.fs, join(site, 'site-state'), state);
    await apply([addPush({ sequence: 1, job: 8, parts: [['job:8#flush:0', 1, true]] })], { passRunId: 101 });
    const left = (await stateOf()).deletions.files.map((f) => f.path);
    expect(left).not.toContain(referenced);
    expect(left).toContain('assets/unused.js');
  });
});

describe('migration', { timeout: 30_000 }, () => {
  test('the first pass renames merge: partitions, schedules the run and pr folders and migrates the assets base', async () => {
    const START = Date.parse('2026-10-01T10:00:00Z');
    const inputs: string[] = [];
    for (const id of [1, 2]) {
      const d = join(dir, `old-${id}`);
      await writeCiRunReport(deps, d, { repository: 'o/r', runId: id, attempt: 1, startMs: START + id });
      inputs.push(d);
    }
    const merge = mergeWithConfig(deps, undefined, {
      format: 'site',
      assetsBase: '../../assets/9.9.9/',
      compact: true,
    });
    await merge(inputs, join(site, MAIN), false);
    for (const n of engineAssetNames('site').concat(['viewer.abc123.js', 'viewer.abc123.css'])) {
      mkdirSync(join(site, 'assets/9.9.9'), { recursive: true });
      writeFileSync(join(site, 'assets/9.9.9', n), n);
    }
    for (const id of [1, 2]) {
      mkdirSync(join(site, MAIN, 'runs', String(id)), { recursive: true });
      writeFileSync(join(site, MAIN, 'runs', String(id), 'index.html'), 'x');
    }
    mkdirSync(join(site, 'pr/362/runs/9'), { recursive: true });
    writeFileSync(join(site, 'pr/362/runs/9/index.html'), 'x');
    const legacy = (id: number, reportPath: string): SiteRun =>
      siteRunOf(id, { completedAt: minutesBefore(40 - id), reportPath });
    const index: SiteIndex = {
      version: 1,
      channels: {
        [MAIN]: {
          ...MAIN_CHANNEL.channel,
          runs: [legacy(2, `${MAIN}/runs/2`), legacy(1, `${MAIN}/runs/1`)],
        },
        'pr/362': {
          kind: 'pr',
          title: '#362 x',
          headBranch: 'x',
          runs: [legacy(9, 'pr/362/runs/9')],
        },
      },
    };
    writeFileSync(join(site, 'index.json'), JSON.stringify(index));
    const r = await apply([], { passRunId: 300 });
    expect(r.changed).toBe(true);
    const m = await manifestOf(MAIN);
    expect(new Set(sources(m))).toEqual(new Set([runSource(1, 1), runSource(2, 1)]));
    expect(m.engine.assetsBase).toBe('../../assets/');
    expect(runsOf('pr/362')[0]).toMatchObject({ reportPath: MAIN, detail: 'full' });
    expect(runsOf(MAIN).map((x) => [x.reportPath, x.detail])).toEqual([
      [MAIN, 'full'],
      [MAIN, 'full'],
    ]);
    const state = await stateOf();
    const scheduled = state.deletions.files.map((d) => d.path);
    expect(scheduled).toEqual(
      expect.arrayContaining([
        `${MAIN}/runs/1/index.html`,
        `${MAIN}/runs/2/index.html`,
        'pr/362/runs/9/index.html',
      ]),
    );
    expect(scheduled.some((p) => p.startsWith('assets/9.9.9/'))).toBe(true);
    expect(existsSync(join(site, 'pr/362/runs/9/index.html'))).toBe(true);
    // a second pass changes nothing and schedules nothing more
    const again = await apply([], { passRunId: 301 });
    expect(again.changed).toBe(false);
    expect((await stateOf()).deletions.files).toEqual(state.deletions.files);
  });
});

test("the one report's manifest config carries the branch variable default and the deployer's version", {
  timeout: 30_000,
}, async () => {
  const config = join(import.meta.dirname, '../../../.github/otel-html-ci.yaml');
  await apply([await addCiRun(42)], { config });
  const m = await manifestOf(MAIN);
  const variable = m.config?.dashboards[0]?.dashboard.variables.find((v) => v.key === BRANCH_KEY);
  expect(variable?.default).toBe('main');
  expect(m.otelHtmlVersion).toBe(deps.version);
  await apply([await addCiRun(43, { completedMin: 5 })], { config, passRunId: 101 });
  expect((await manifestOf(MAIN)).config).toEqual(m.config);
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
    expect(applied.form).toEqual({ kind: 'consumed', base: 77, runAttempt: 1 });
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
      runAttempt: 1,
    });
  });

  test('the full state names the pass attempt', async () => {
    await apply([addPush({ sequence: 1, parts: [['job:7#flush:0', 0, true]] })], { passRunAttempt: 3 });
    expect((await stateOf()).applied.form).toEqual({ kind: 'full', runId: 100, runAttempt: 3 });
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
        slimRetention: 100,
        prSlimRetention: 100,
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
