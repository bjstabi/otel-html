import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { resolveApiConfig, resolveDeps } from '../../../src/api/report.js';
import { addRunReport, ensureMainReport, runSource } from '../../../src/cli/ci/main-report.js';
import { readRunManifest } from '../../../src/cli/ci/run-report.js';
import { CI_SCOPE, trimRun } from '../../../src/cli/ci/trim-run.js';
import type { ResolvedConfig } from '../../../src/config/schema.js';
import { TABLE_COLUMNS } from '../../../src/format/parquet/columns.js';
import { readColumns } from '../../../src/format/parquet/stream.js';
import type { WriterDeps } from '../../../src/writer/session.js';
import { writeCiRunReport } from '../../../test-support/ci-run-fixture.js';
import { fakeViewerAssets } from '../../../test-support/writer-deps.js';

const NOW = '2026-11-10T12:00:00.000Z';
const START = Date.parse('2026-10-01T10:00:00Z');
let deps: WriterDeps;
let config: ResolvedConfig;
let root: string;
let main: string;

beforeAll(async () => {
  deps = await resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' });
  config = await resolveApiConfig(deps, undefined, undefined, {
    format: 'site',
    assetsBase: '../../assets/',
  });
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trim-run-test-'));
  main = join(root, 'main');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The main report holding the given runs in full, and the next free partition number. */
async function mainWith(runs: number[]): Promise<number> {
  await ensureMainReport(deps, main, config, { now: NOW, assetsBase: '../../assets/' });
  let next = 0;
  for (const runId of runs) {
    const dir = join(root, `run-${runId}`);
    await writeCiRunReport(deps, dir, { repository: 'o/r', runId, attempt: 1, startMs: START + runId });
    next = (await addRunReport(deps, main, dir, { runId, attempt: 1 }, { now: NOW, next })).next;
  }
  return next;
}

const manifestOf = async (): Promise<NonNullable<Awaited<ReturnType<typeof readRunManifest>>>> => {
  const m = await readRunManifest(deps.fs, main);
  if (m === null) throw new Error('no manifest');
  return m;
};

async function cicdRows(path: string): Promise<Record<string, unknown>[]> {
  const names = TABLE_COLUMNS.cicd.map((c) => c.name);
  const bytes = await deps.fs.readBytes(path);
  const out: Record<string, unknown>[] = [];
  for await (const cols of readColumns('cicd', new Blob([new Uint8Array(bytes)]), path)) {
    for (let r = 0; r < (cols[0]?.length ?? 0); r++) {
      out.push(Object.fromEntries(names.map((n, c) => [n, cols[c]?.[r] ?? null])));
    }
  }
  return out;
}

const bySpan = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
  rows
    .filter((r) => Reflect.get(r, 'kind') !== 'tasks')
    .sort((a, b) => String(Reflect.get(a, 'span_id')).localeCompare(String(Reflect.get(b, 'span_id'))));

describe('trimRun', () => {
  test('keeps exactly the otel-html-ci spans and writes no logs or points file', async () => {
    const next = await mainWith([1]);
    const before = (await manifestOf()).partitions.filter((p) => p.source === runSource(1, 1));
    expect(before[0]?.files.logs).toBeDefined();
    const r = await trimRun(deps, main, { runId: 1, attempt: 1 }, config, { now: NOW, next });
    const after = (await manifestOf()).partitions.filter((p) => p.source === runSource(1, 1));
    expect(after).toHaveLength(1);
    const files = after[0]?.files;
    expect(files?.spans?.rows).toBe(3);
    expect(files?.logs).toBeUndefined();
    expect(files?.points).toBeUndefined();
    expect(files?.cicd).toBeDefined();
    const old = before.flatMap((p) =>
      Object.values(p.files).flatMap((f) => (f === undefined ? [] : [f.path])),
    );
    expect(r.dropped.sort()).toEqual(old.sort());
    for (const p of old) expect(existsSync(join(main, p))).toBe(true);
    expect(r.written).toContain(files?.spans?.path);
    expect(CI_SCOPE).toBe('otel-html-ci');
  });

  test("cicd run and job rows equal the full partition's; the tasks row is gone", async () => {
    const next = await mainWith([1]);
    const full = (await manifestOf()).partitions[0]?.files.cicd?.path ?? '';
    const fullRows = await cicdRows(join(main, full));
    expect(fullRows.some((r) => Reflect.get(r, 'kind') === 'tasks')).toBe(true);
    await trimRun(deps, main, { runId: 1, attempt: 1 }, config, { now: NOW, next });
    const slim =
      (await manifestOf()).partitions.find((p) => p.source === runSource(1, 1))?.files.cicd?.path ?? '';
    const slimRows = await cicdRows(join(main, slim));
    expect(slimRows.some((r) => Reflect.get(r, 'kind') === 'tasks')).toBe(false);
    expect(bySpan(slimRows)).toEqual(bySpan(fullRows));
    expect(
      bySpan(slimRows)
        .map((r) => Reflect.get(r, 'kind'))
        .sort(),
    ).toEqual(['job', 'run']);
  });

  test('numbers from next and leaves other runs untouched', async () => {
    const next = await mainWith([1, 2]);
    const before = await manifestOf();
    const other = before.partitions.filter((p) => p.source === runSource(2, 1));
    const r = await trimRun(deps, main, { runId: 1, attempt: 1 }, config, { now: NOW, next: next + 10 });
    const after = await manifestOf();
    expect(after.partitions.filter((p) => p.source === runSource(2, 1))).toEqual(other);
    const slim = after.partitions.filter((p) => p.source === runSource(1, 1));
    expect(slim.map((p) => p.n)).toEqual([next + 10]);
    expect(r.next).toBe(next + 11);
  });

  test('a run with no partition changes nothing', async () => {
    const next = await mainWith([1]);
    const before = await manifestOf();
    const r = await trimRun(deps, main, { runId: 99, attempt: 1 }, config, { now: NOW, next });
    expect(r).toEqual({ written: [], dropped: [], next });
    expect(await manifestOf()).toEqual(before);
  });
});
