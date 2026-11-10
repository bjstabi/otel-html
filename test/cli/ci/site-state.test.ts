import { describe, expect, test } from 'vitest';
import {
  DELETION_GRACE_MS,
  emptyState,
  parseStateName,
  readSiteState,
  type SiteState,
  scanFiles,
  stateArtifactName,
  writeSiteState,
} from '../../../src/cli/ci/site-state.js';
import { createMemoryFileSystem } from '../../../test-support/memory-fs.js';

const NOW = '2026-11-10T12:00:00.000Z';
const DIR = '/site/site-state';

const full = (): SiteState => ({
  applied: {
    version: 1,
    form: { kind: 'full', runId: 77 },
    updates: {
      '11': { outcome: 'applied', createdAt: '2026-11-10T11:30:00Z', pass: 3 },
      '12': { outcome: 'rejected', createdAt: '2026-11-10T11:45:00Z', pass: 3 },
    },
    floor: '2026-11-10T10:30:00Z',
    writtenAt: NOW,
  },
  removed: { version: 1, prs: { '5': { runId: 70, at: NOW } } },
  files: { version: 1, files: { 'index.json': 10, 'branch/main/data/manifest.js': 20 } },
  deletions: {
    version: 1,
    files: [
      { path: 'a/b', pass: 2 },
      { path: 'c', pass: 3, liveAt: NOW },
    ],
  },
  runs: {
    version: 1,
    runs: {
      'branch/main/runs/70': {
        next: 2,
        attempt: 1,
        jobs: { '9': { name: 'unit', attempt: 1, sequence: 1, sources: ['job:9#compact:0..1'] } },
      },
    },
  },
});

describe('site state files', () => {
  test('a state round-trips through the five files', async () => {
    const fs = createMemoryFileSystem();
    await writeSiteState(fs, DIR, full());
    expect([...fs.snapshot().keys()].sort()).toEqual(
      ['applied', 'deletions', 'files', 'removed', 'runs'].map((n) => `${DIR}/${n}.json`),
    );
    expect(await readSiteState(fs, DIR, () => {})).toEqual(full());
  });

  test('a missing directory reads as the empty state without a warning', async () => {
    const warnings: string[] = [];
    const state = await readSiteState(createMemoryFileSystem(), DIR, (m) => warnings.push(m));
    expect(state.applied.updates).toEqual({});
    expect(state.files.files).toEqual({});
    expect(state.applied.updates).toEqual({});
    expect(warnings).toEqual([]);
  });

  test('emptyState sets the floor an hour before now', () => {
    const s = emptyState(NOW);
    expect(s.applied.floor).toBe('2026-11-10T11:00:00.000Z');
    expect(s.applied.writtenAt).toBe(NOW);
    expect(DELETION_GRACE_MS).toBe(900_000);
  });

  test('a malformed applied.json warns and reads empty; the other files still read', async () => {
    const fs = createMemoryFileSystem();
    await writeSiteState(fs, DIR, full());
    await fs.writeTextAtomic(`${DIR}/applied.json`, '{"version":1,"bogus":true}');
    const warnings: string[] = [];
    const state = await readSiteState(fs, DIR, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('applied.json');
    expect(state.applied.updates).toEqual({});
    expect(state.files).toEqual(full().files);
  });

  test('unparsable JSON warns too', async () => {
    const fs = createMemoryFileSystem();
    await fs.mkdirp(DIR);
    await fs.writeTextAtomic(`${DIR}/runs.json`, 'not json');
    const warnings: string[] = [];
    const state = await readSiteState(fs, DIR, (m) => warnings.push(m));
    expect(warnings[0]).toContain('runs.json');
    expect(state.runs.runs).toEqual({});
  });

  test('a run entry with an unknown field is malformed', async () => {
    const fs = createMemoryFileSystem();
    await fs.mkdirp(DIR);
    await fs.writeTextAtomic(
      `${DIR}/runs.json`,
      JSON.stringify({ version: 1, runs: { r: { next: 0, attempt: 1, jobs: {}, extra: 1 } } }),
    );
    const warnings: string[] = [];
    await readSiteState(fs, DIR, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
  });

  test('writeSiteState drops applied.updates older than the floor', async () => {
    const fs = createMemoryFileSystem();
    const state = full();
    state.applied.floor = '2026-11-10T11:40:00Z';
    await writeSiteState(fs, DIR, state);
    const back = await readSiteState(fs, DIR, () => {});
    expect(Object.keys(back.applied.updates)).toEqual(['12']);
    expect(Object.keys(state.applied.updates)).toEqual(['11', '12']);
  });

  test('files.json is written last', async () => {
    const fs = createMemoryFileSystem();
    const order: string[] = [];
    const write = fs.writeTextAtomic.bind(fs);
    fs.writeTextAtomic = async (p, t) => {
      order.push(p.slice(p.lastIndexOf('/') + 1));
      await write(p, t);
    };
    await writeSiteState(fs, DIR, full());
    expect(order.at(-1)).toBe('files.json');
    expect(order).toHaveLength(5);
  });
});

describe('scanFiles', () => {
  test('lists site files with sizes and skips site-state/', async () => {
    const fs = createMemoryFileSystem();
    await fs.writeBytes('/site/index.json', new Uint8Array(7));
    await fs.writeBytes('/site/branch/main/data/manifest.js', new Uint8Array(12));
    await fs.writeBytes('/site/site-state/applied.json', new Uint8Array(3));
    expect(await scanFiles(fs, '/site')).toEqual({
      version: 1,
      files: { 'index.json': 7, 'branch/main/data/manifest.js': 12 },
    });
  });
});

describe('state artifact names', () => {
  test('both forms round-trip', () => {
    expect(stateArtifactName({ kind: 'full', runId: 123 })).toBe('otel-html-site-state-123');
    expect(stateArtifactName({ kind: 'consumed', base: 456 })).toBe('otel-html-site-state-base-456');
    for (const f of [
      { kind: 'full', runId: 123 },
      { kind: 'consumed', base: 456 },
    ] as const)
      expect(parseStateName(stateArtifactName(f))).toEqual(f);
  });

  test('other names do not parse', () => {
    for (const n of [
      'otel-html-site-state-',
      'otel-html-site-state-x',
      'otel-html-site-state-base-',
      'otel-html-update-5',
      'otel-html-site-state-1-2',
    ])
      expect(parseStateName(n)).toBeUndefined();
  });
});
