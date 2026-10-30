import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { openSession, type WriterSession } from '../../src/writer/session.js';
import { logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import {
  allSpans,
  counterRequest,
  levelsOf,
  logRollupsOf,
  manifestOf,
  metricFilesOnDisk,
  spansRequest,
} from './helpers.js';

const OUT = 'r';
const SMALL_CHUNKS = testConfig({ writer: { chunkTargetBytes: 1 } });

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

function open(w: TestWriter, mode: 'replace' | 'append', config = SMALL_CHUNKS): Promise<WriterSession> {
  return openSession(w.deps, { out: OUT, config, mode });
}

async function closedReportWithTwoChunks(w: TestWriter): Promise<void> {
  const a = await open(w, 'replace');
  await a.add(otlp(spansRequest(1, 0, 0)), 'a.json');
  await a.add(otlp(spansRequest(1, 0, 1)), 'b.json');
  await a.close();
}

describe('append', () => {
  test('continues chunk numbering and totals add up', async () => {
    const w = createTestWriter();
    await closedReportWithTwoChunks(w);
    expect(manifestOf(w, OUT).chunks.map((c) => c.path)).toEqual([
      'data/chunks/spans/000000.js',
      'data/chunks/spans/000001.js',
    ]);
    const b = await open(w, 'append');
    await b.add(otlp(spansRequest(1, 0, 2)), 'c.json');
    const summary = await b.close();
    expect(summary.totals.spans).toBe(3);
    const m = manifestOf(w, OUT);
    expect(m.chunks.map((c) => c.path)).toContain('data/chunks/spans/000002.js');
    expect(m.chunks.map((c) => c.n)).toEqual([0, 1, 2]);
    expect(m.totals.spans).toBe(3);
    expect(allSpans(w, OUT)).toHaveLength(3);
    expect(w.fs.snapshot().has('r/data/chunks/spans/000002.js')).toBe(true);
  });

  test('continues log pattern ids from the checkpoint', async () => {
    const w = createTestWriter();
    const logs = (bodies: readonly string[]): ReturnType<typeof logsRequest> =>
      logsRequest(bodies.map((body) => logRecord({ body: { stringValue: body } })));
    const a = await open(w, 'replace');
    await a.add(otlp(logs(['user 1 logged in', 'disk full on /dev/sda'])), 'a.json');
    await a.close();
    const before = logRollupsOf(w, OUT).patterns.clusters();
    expect(before.map((c) => c.id)).toEqual([0, 1]);
    const b = await open(w, 'append');
    await b.add(otlp(logs(['user 2 logged in', 'brand new shape of message here'])), 'b.json');
    await b.close();
    const after = logRollupsOf(w, OUT).patterns.clusters();
    expect(after.map((c) => [c.id, c.count])).toEqual([
      [0, 2],
      [1, 1],
      [2, 1],
    ]);
  });

  describe('dashboards', () => {
    const ops = {
      dashboards: [
        { id: 'ops', title: 'Ops', widgets: [{ type: 'traces' as const, x: 0, y: 0, w: 6, h: 6 }] },
      ],
      views: [{ id: 'v', title: 'V', page: 'traces' as const }],
    };
    const other = {
      dashboards: [
        { id: 'other', title: 'Other', widgets: [{ type: 'logs' as const, x: 0, y: 0, w: 6, h: 6 }] },
      ],
    };
    test('append without config keeps them, and the default dashboard', async () => {
      const w = createTestWriter();
      await (await open(w, 'replace', testConfig({ ...ops, viewer: { defaultDashboard: 'ops' } }))).close();
      await (await open(w, 'append', testConfig())).close();
      const m = manifestOf(w, OUT).config;
      expect(m.dashboards.map((d) => d.dashboard.id)).toEqual(['ops']);
      expect(m.views).toHaveLength(1);
      expect(m.viewer.defaultDashboard).toBe('ops');
    });
    test('append without config keeps the home page; a config that sets another one wins', async () => {
      const w = createTestWriter();
      await (await open(w, 'replace', testConfig({ viewer: { home: 'dashboards' } }))).close();
      await (await open(w, 'append', testConfig())).close();
      expect(manifestOf(w, OUT).config.viewer.home).toBe('dashboards');
      await (await open(w, 'append', testConfig({ viewer: { home: 'logs' } }))).close();
      expect(manifestOf(w, OUT).config.viewer.home).toBe('logs');
    });
    test('append that replaces only dashboards keeps the views', async () => {
      const w = createTestWriter();
      await (await open(w, 'replace', testConfig(ops))).close();
      await (await open(w, 'append', testConfig(other))).close();
      const m = manifestOf(w, OUT).config;
      expect(m.dashboards.map((d) => d.dashboard.id)).toEqual(['other']);
      expect(m.views.map((v) => v.id)).toEqual(['v']);
    });
    test('append with another config replaces them', async () => {
      const w = createTestWriter();
      await (await open(w, 'replace', testConfig({ ...ops, viewer: { defaultDashboard: 'ops' } }))).close();
      await (await open(w, 'append', testConfig(other))).close();
      const m = manifestOf(w, OUT).config;
      expect(m.dashboards.map((d) => d.dashboard.id)).toEqual(['other']);
      expect(m.viewer.defaultDashboard).toBe('fusion');
    });
  });

  test('keeps the original epoch and creation time', async () => {
    const w = createTestWriter();
    await closedReportWithTwoChunks(w);
    const before = manifestOf(w, OUT);
    const b = await open(w, 'append');
    await b.add(otlp(spansRequest(1, 5_000_000, 9)), 'later.json');
    await b.close();
    const after = manifestOf(w, OUT);
    expect(after.epochUnixNano).toBe(before.epochUnixNano);
    expect(after.createdAt).toBe(before.createdAt);
  });

  test('a version mismatch tells the user to replace or merge, with both versions', async () => {
    const w = createTestWriter();
    await closedReportWithTwoChunks(w);
    const e = await failure(
      openSession({ ...w.deps, version: '9.9.9' }, { out: OUT, config: SMALL_CHUNKS, mode: 'append' }),
    );
    expect(e.code).toBe('version-mismatch');
    expect(e.message).toContain(
      `cannot append: the report at ${OUT} was written by otel-html 0.1.0 (this is 9.9.9)`,
    );
    expect(e.hint).toBe(
      `pass --replace (replace: true in the library) to start it over, or combine across versions with \`otel-html merge ${OUT} <new> -o <dir>\``,
    );
    expect(e.path).toBe('manifest.otelHtmlVersion');
  });

  test('a version mismatch on the default path deletes nothing', async () => {
    const w = createTestWriter();
    await closedReportWithTwoChunks(w);
    const before = w.fs.snapshot();
    const e = await failure(
      openSession({ ...w.deps, version: '9.9.9' }, { out: OUT, config: SMALL_CHUNKS, mode: 'open' }),
    );
    expect(e.code).toBe('version-mismatch');
    expect(e.message).toContain(
      `cannot append: the report at ${OUT} was written by otel-html 0.1.0 (this is 9.9.9)`,
    );
    expect(e.hint).toBe(
      `pass --replace (replace: true in the library) to start it over, or combine across versions with \`otel-html merge ${OUT} <new> -o <dir>\``,
    );
    expect(e.path).toBe('manifest.otelHtmlVersion');
    const after = w.fs.snapshot();
    for (const [path, text] of before) {
      if (!path.endsWith('.lock')) expect(after.get(path), path).toBe(text);
    }
  });

  test('a state file written by another version is a version mismatch too', async () => {
    const w = createTestWriter();
    await closedReportWithTwoChunks(w);
    for (const slot of [0, 1]) {
      const p = `${OUT}/data/state/session.${slot}.json`;
      if (!(await w.fs.exists(p))) continue;
      const state: Record<string, unknown> = JSON.parse(await w.fs.readText(p));
      await w.fs.writeTextAtomic(p, JSON.stringify({ ...state, otelHtmlVersion: '0.0.1' }));
    }
    const e = await failure(open(w, 'append'));
    expect(e.code).toBe('version-mismatch');
    expect(e.message).toContain(
      `cannot append: the report at ${OUT} was written by otel-html 0.0.1 (this is 0.1.0)`,
    );
    expect(e.hint).toContain('pass --replace');
    expect(e.path).toMatch(/^data\/state\/session\.[01]\.json otelHtmlVersion$/);
  });

  test('missing state files are an invalid report that points to merge', async () => {
    const w = createTestWriter();
    await closedReportWithTwoChunks(w);
    await w.fs.remove(`${OUT}/data/state/session.0.json`);
    await w.fs.remove(`${OUT}/data/state/session.1.json`);
    const e = await failure(open(w, 'append'));
    expect(e.code).toBe('invalid-report');
    expect(e.hint).toContain('otel-html merge');
  });

  test('corrupt state files are an invalid report naming the file', async () => {
    const w = createTestWriter();
    await closedReportWithTwoChunks(w);
    await w.fs.writeTextAtomic(`${OUT}/data/state/session.0.json`, '{not json');
    await w.fs.writeTextAtomic(`${OUT}/data/state/session.1.json`, '{"formatVersion":1}');
    const e = await failure(open(w, 'append'));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain('session.0.json');
    expect(e.message).toContain('session.1.json');
  });

  test('a corrupt manifest is an invalid report', async () => {
    const w = createTestWriter();
    await closedReportWithTwoChunks(w);
    await w.fs.writeTextAtomic(`${OUT}/data/manifest.js`, '__OH__.push("manifest",{});\n');
    const e = await failure(open(w, 'append'));
    expect(e.code).toBe('invalid-report');
  });

  test('a lock is held while appending and released by close', async () => {
    const w = createTestWriter();
    await closedReportWithTwoChunks(w);
    const b = await open(w, 'append');
    expect((await failure(open(w, 'append'))).code).toBe('report-locked');
    await b.close();
    await (await open(w, 'append')).close();
  });
});

describe('append with metrics', () => {
  const first = counterRequest('requests', [
    [0, 1],
    [10, 3],
  ]);
  const second = counterRequest('requests', [
    [20, 6],
    [3000, 10],
  ]);

  test('the new level files equal converting all inputs at once', async () => {
    const w = createTestWriter();
    const a = await open(w, 'replace');
    await a.add(otlp(first), 'a.json');
    await a.close();
    const b = await open(w, 'append');
    await b.add(otlp(second), 'b.json');
    await b.close();

    const once = await openSession(w.deps, { out: 'once', config: SMALL_CHUNKS, mode: 'replace' });
    await once.add(otlp(first), 'a.json');
    await once.add(otlp(second), 'b.json');
    await once.close();

    const levels = levelsOf(w, OUT, 0);
    expect(levels.map((l) => l.level)).toEqual([0, 1]);
    expect(levels).toEqual(levelsOf(w, 'once', 0));
    expect(levels[0]?.series[0]?.a.map((x) => (x.k === 'counter' ? x.delta : null))).toEqual([1, 2, 3, 4]);
    expect(metricFilesOnDisk(w, OUT)).toEqual(manifestOf(w, OUT).metricFiles);
  });
});
