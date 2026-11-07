import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { mergeWith } from '../../src/api/convert.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { TABLES, type Table } from '../../src/format/parquet/schema.js';
import { MANIFEST_KEY, partitionWrapperPath } from '../../src/format/paths.js';
import type { OtelHtmlError } from '../../src/model/errors.js';
import { mergeReports } from '../../src/writer/merge.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { openSession } from '../../src/writer/session.js';
import { logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { perfFactor } from '../../test-support/perf-inject.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf, spansRequest } from './helpers.js';

type Format = 'local' | 'site';
const cfg = (format: Format, extra: object = {}) => ({ writer: { format, ...extra } });

function v4Manifest(w: TestWriter, out: string): ManifestV4 {
  const text = w.fs.snapshot().get(`${out}/data/manifest.js`);
  if (text === undefined) throw new Error('no manifest');
  const m = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(m)) throw new Error('not a v4 manifest');
  return m;
}

/** A format-4 report whose sessions each add one request: every `requests` entry becomes its own partition. */
async function v4Report(
  w: TestWriter,
  out: string,
  requests: readonly Parameters<typeof otlp>[0][],
  format: Format = 'site',
  extra: object = {},
): Promise<void> {
  for (const [i, r] of requests.entries()) {
    const s = await openSession(w.deps, {
      out,
      config: testConfig(cfg(format, extra)),
      mode: i === 0 ? 'replace' : 'append',
    });
    await s.add(otlp(r), `in-${i}.json`);
    await s.close();
  }
}

const cell = (row: object, key: string): unknown => Reflect.get(row, key);
const bytesOf = async (w: TestWriter, p: string) => w.deps.fs.readBytes(p);

async function rows(w: TestWriter, out: string, table: Table): Promise<number> {
  let n = 0;
  for (const p of v4Manifest(w, out).partitions) {
    const f = p.files[table];
    if (f !== undefined) n += decodeTable(table, await bytesOf(w, `${out}/${f.path}`)).length;
  }
  return n;
}

describe('merge copies format-4 partitions', () => {
  test('partition bytes, statistics, totals and epoch carry over; sources name the input', async () => {
    const w = createTestWriter();
    await v4Report(w, 'a', [spansRequest(3), spansRequest(2, 10_000, 10)]);
    await v4Report(w, 'b', [spansRequest(4, 20_000, 20)]);
    const a = v4Manifest(w, 'a');
    const b = v4Manifest(w, 'b');
    expect(a.partitions).toHaveLength(2);

    await mergeWith({ inputs: ['a', 'b'], out: 'm', config: cfg('site') }, w.deps);
    const m = v4Manifest(w, 'm');
    expect(m.partitions.map((p) => p.source)).toEqual(['merge:0#0', 'merge:0#1', 'merge:1#0']);
    expect(m.partitions.map((p) => p.n)).toEqual([0, 1, 2]);
    expect(m.totals.spans).toBe(a.totals.spans + b.totals.spans);
    expect(m.epochUnixNano).toBe(a.epochUnixNano);
    const copies = [
      ['a', a.partitions[0]],
      ['a', a.partitions[1]],
      ['b', b.partitions[0]],
    ] as const;
    for (const [i, [dir, src]] of copies.entries()) {
      const dst = m.partitions[i];
      if (src === undefined || dst === undefined) throw new Error('missing partition');
      for (const t of TABLES) {
        const s = src.files[t];
        const d = dst.files[t];
        expect(d === undefined).toBe(s === undefined);
        if (s === undefined || d === undefined) continue;
        expect(await bytesOf(w, `m/${d.path}`)).toEqual(await bytesOf(w, `${dir}/${s.path}`));
        expect({ ...d, path: '' }).toEqual({ ...s, path: '' });
      }
    }
  });

  test('a 20-partition input copies in under a second (@perf)', async () => {
    const w = createTestWriter();
    await v4Report(
      w,
      'a',
      Array.from({ length: 20 }, (_, i) => spansRequest(2, i * 10_000, i * 2)),
    );
    expect(v4Manifest(w, 'a').partitions).toHaveLength(20);
    const t0 = performance.now();
    await mergeWith({ inputs: ['a'], out: 'm', config: cfg('site') }, w.deps);
    const ms = performance.now() - t0;
    expect(v4Manifest(w, 'm').partitions).toHaveLength(20);
    expect(ms).toBeLessThan(1000 * perfFactor());
  });

  test('without --compact the copied partitions stay as they are', async () => {
    const w = createTestWriter();
    await v4Report(w, 'a', [spansRequest(1), spansRequest(1, 5000, 5), spansRequest(1, 9000, 9)]);
    await mergeWith({ inputs: ['a'], out: 'm', config: cfg('site') }, w.deps);
    expect(v4Manifest(w, 'm').partitions).toHaveLength(3);
  });

  test('--compact leaves one compacted partition per input, never summing across inputs', async () => {
    const w = createTestWriter();
    const logs = (body: string) => logsRequest([logRecord({ body: { stringValue: body } })]);
    await v4Report(w, 'a', [spansRequest(2), spansRequest(2, 10_000, 10), logs('user 1 logged in')]);
    await v4Report(w, 'b', [spansRequest(2, 20_000, 20), logs('user 2 logged in'), logs('user 3 logged in')]);
    await v4Report(w, 'c', [spansRequest(1, 30_000, 30)]);
    await mergeWith(
      { inputs: ['a', 'b', 'c'], out: 'm', config: cfg('site', { compactOnMerge: true }) },
      w.deps,
    );
    const m = v4Manifest(w, 'm');
    // The single-partition input is not rewritten; the compacted ones take the next numbers, a before b.
    expect(m.partitions.map((p) => p.source)).toEqual(['merge:2#0', 'compact:0..2', 'compact:3..5']);
    expect(await rows(w, 'm', 'spans')).toBe(7);
    expect(await rows(w, 'm', 'logs')).toBe(3);
    // The replaced folders are gone.
    const dirs = [...w.fs.snapshot().keys()].filter((k) => k.startsWith('m/data/partitions/'));
    const live = new Set(m.partitions.flatMap((p) => Object.values(p.files).map((f) => `m/${f.path}`)));
    expect(dirs.filter((d) => d.endsWith('.parquet')).every((d) => live.has(d))).toBe(true);
  });

  test('a local output gets a wrapper for every copied file, from a site or a local input', async () => {
    const w = createTestWriter();
    await v4Report(w, 'site-in', [spansRequest(2)], 'site');
    await v4Report(w, 'local-in', [spansRequest(2, 10_000, 10)], 'local');
    await mergeWith({ inputs: ['site-in', 'local-in'], out: 'm', config: cfg('local') }, w.deps);
    const m = v4Manifest(w, 'm');
    expect(m.engine.format).toBe('local');
    const snap = w.fs.snapshot();
    expect(m.partitions).toHaveLength(2);
    for (const p of m.partitions) {
      for (const t of TABLES) {
        if (p.files[t] === undefined) continue;
        const wrapper = snap.get(`m/${partitionWrapperPath(p.n, t)}`);
        expect(wrapper).toContain(`partitions/${String(p.n).padStart(6, '0')}/${t}`);
      }
    }
  });

  test('a site output drops the wrappers of a local input', async () => {
    const w = createTestWriter();
    await v4Report(w, 'local-in', [spansRequest(2)], 'local');
    expect([...w.fs.snapshot().keys()].some((k) => k.endsWith('.parquet.js'))).toBe(true);
    await mergeWith({ inputs: ['local-in'], out: 'm', config: cfg('site') }, w.deps);
    expect(
      [...w.fs.snapshot().keys()].filter((k) => k.startsWith('m/') && k.endsWith('.parquet.js')),
    ).toEqual([]);
    expect(await rows(w, 'm', 'spans')).toBe(2);
  });

  test('statistics keys are the output config: kept keys carry over, new keys are null, dropped keys go', async () => {
    const w = createTestWriter();
    await v4Report(w, 'a', [spansRequest(2)], 'site', { statisticsKeys: ['attr:old'] });
    const before = v4Manifest(w, 'a').partitions[0]?.files.spans;
    expect(before && Object.keys(before.values)).toContain('attr:old');
    await mergeWith(
      { inputs: ['a'], out: 'm', config: cfg('site', { statisticsKeys: ['attr:new'] }) },
      w.deps,
    );
    const after = v4Manifest(w, 'm').partitions[0]?.files.spans;
    expect(after?.values['attr:new']).toBeNull();
    expect(after?.values['attr:old']).toBeUndefined();
    expect(after && Object.keys(after.values)).toEqual(v4Manifest(w, 'm').statisticsKeys.spans);
  });

  test('mixed inputs: format-4 partitions are copied and a chunks report is converted in the same run', async () => {
    const w = createTestWriter();
    // A chunks-format report is the format-3 input.
    const s = await openSession(w.deps, { out: 'v3', config: testConfig(), mode: 'replace' });
    await s.add(otlp(spansRequest(3, 50_000, 40)), 'v3.json');
    await s.close();
    await v4Report(w, 'v4', [spansRequest(2), spansRequest(2, 10_000, 10)]);
    await mergeWith({ inputs: ['v4', 'v3'], out: 'm', config: cfg('site') }, w.deps);
    const m = v4Manifest(w, 'm');
    expect(m.totals.spans).toBe(7);
    expect(await rows(w, 'm', 'spans')).toBe(7);
    expect(m.partitions.map((p) => p.source).filter((s) => s.startsWith('merge:'))).toEqual([
      'merge:0#0',
      'merge:0#1',
    ]);
  });

  test('a format-4 input into a chunks output is a usage error that names --format, and writes nothing', async () => {
    const w = createTestWriter();
    await v4Report(w, 'a', [spansRequest(1)]);
    const e = await mergeReports(w.deps, ['a'], { out: 'm', config: testConfig(), mode: 'replace' }).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: 'usage', hint: expect.stringContaining('--format local') });
    expect(w.fs.snapshot().has('m/data/manifest.js')).toBe(false);
  });

  test('a listed partition file that is missing is an invalid-report naming the input file', async () => {
    const w = createTestWriter();
    await v4Report(w, 'a', [spansRequest(1)]);
    const f = v4Manifest(w, 'a').partitions[0]?.files.spans;
    if (f === undefined) throw new Error('no spans file');
    await w.deps.fs.remove(`a/${f.path}`);
    const e = await mergeWith({ inputs: ['a'], out: 'm', config: cfg('site') }, w.deps).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: 'invalid-report' });
    expect(String((e as Error).message)).toContain(`a/${f.path}`);
  });

  test('a partition file whose size differs from the manifest is an invalid-report, before anything is wiped', async () => {
    const w = createTestWriter();
    await v4Report(w, 'old', [spansRequest(2)]);
    await mergeWith({ inputs: ['old'], out: 'm', config: cfg('site') }, w.deps);
    const logs = (body: string) => logsRequest([logRecord({ body: { stringValue: body } })]);
    await v4Report(w, 'a', [logs('one'), logs('two')]);
    const f = v4Manifest(w, 'a').partitions[0]?.files.logs;
    if (f === undefined) throw new Error('no logs file');
    const full = await bytesOf(w, `a/${f.path}`);
    await w.deps.fs.writeBytes(`a/${f.path}`, full.slice(0, full.length - 10));
    const before = [...w.fs.snapshot()].filter(([k]) => k.startsWith('m/'));
    const e = await mergeWith({ inputs: ['a'], out: 'm', config: cfg('site'), replace: true }, w.deps).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: 'invalid-report' });
    expect(String((e as Error).message)).toContain(
      `${full.length - 10} bytes, the manifest lists ${f.bytes}`,
    );
    expect([...w.fs.snapshot()].filter(([k]) => k.startsWith('m/'))).toEqual(before);
  });

  test('the files are copied as bytes: a listed file of arbitrary content arrives unchanged (no decode)', async () => {
    const w = createTestWriter();
    await v4Report(w, 'a', [spansRequest(2)]);
    const f = v4Manifest(w, 'a').partitions[0]?.files.spans;
    if (f === undefined) throw new Error('no spans file');
    const junk = Uint8Array.from({ length: f.bytes }, (_, i) => (i * 7) % 256); // the listed size, not Parquet
    await w.deps.fs.writeBytes(`a/${f.path}`, junk);
    await mergeWith({ inputs: ['a'], out: 'm', config: cfg('site') }, w.deps);
    const out = v4Manifest(w, 'm').partitions[0]?.files.spans;
    expect(out && (await bytesOf(w, `m/${out.path}`))).toEqual(junk);
  });

  test('--replace with a v4 input that lists a missing file fails and leaves the existing report intact', async () => {
    const w = createTestWriter();
    await v4Report(w, 'old', [spansRequest(2)]);
    await mergeWith({ inputs: ['old'], out: 'm', config: cfg('site') }, w.deps);
    const before = v4Manifest(w, 'm');
    await v4Report(w, 'a', [spansRequest(1, 0, 9)]);
    const f = v4Manifest(w, 'a').partitions[0]?.files.spans;
    if (f === undefined) throw new Error('no spans file');
    await w.deps.fs.remove(`a/${f.path}`);
    const e = await mergeWith({ inputs: ['a'], out: 'm', config: cfg('site'), replace: true }, w.deps).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: 'invalid-report' });
    expect(v4Manifest(w, 'm')).toEqual(before);
    expect(await rows(w, 'm', 'spans')).toBe(2);
  });

  describe('--replace never wipes unless every input file can be copied', () => {
    const snapshotOf = (w: TestWriter) =>
      [...w.fs.snapshot()].filter(([k]) => k.startsWith('m/')).sort(([a], [b]) => a.localeCompare(b));

    async function oldReport(w: TestWriter): Promise<void> {
      await v4Report(w, 'old', [spansRequest(2)]);
      await mergeWith({ inputs: ['old'], out: 'm', config: cfg('site') }, w.deps);
    }

    async function dirInput(w: TestWriter): Promise<void> {
      await v4Report(w, 'a', [spansRequest(1, 0, 9)]);
      const f = v4Manifest(w, 'a').partitions[0]?.files.spans;
      if (f === undefined) throw new Error('no spans file');
      await w.deps.fs.remove(`a/${f.path}`);
      await w.deps.fs.writeBytes(`a/${f.path}/inner`, new Uint8Array([1]));
    }

    test('a listed path that is a directory', async () => {
      const w = createTestWriter();
      await oldReport(w);
      await dirInput(w);
      const before = snapshotOf(w);
      const e = await mergeWith(
        { inputs: ['a'], out: 'm', config: cfg('site'), replace: true },
        w.deps,
      ).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'invalid-report' });
      expect(snapshotOf(w)).toEqual(before);
    });

    test('the same with a chunks input in the mix', async () => {
      const w = createTestWriter();
      await oldReport(w);
      const s = await openSession(w.deps, { out: 'v3', config: testConfig(), mode: 'replace' });
      await s.add(otlp(spansRequest(1, 0, 20)), 'v3.json');
      await s.close();
      await dirInput(w);
      const before = snapshotOf(w);
      const e = await mergeWith(
        { inputs: ['v3', 'a'], out: 'm', config: cfg('site'), replace: true },
        w.deps,
      ).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'invalid-report' });
      expect(snapshotOf(w)).toEqual(before);
    });

    test('a chunks input that sorts after a v4 input and lists a directory as a chunk', async () => {
      const w = createTestWriter();
      await oldReport(w);
      await v4Report(w, 'a', [spansRequest(1, 0, 9)]);
      const s = await openSession(w.deps, { out: 'v3', config: testConfig(), mode: 'replace' });
      await s.add(otlp(spansRequest(1, 0, 20)), 'v3.json');
      await s.close();
      const chunk = manifestOf(w, 'v3').chunks[0];
      if (chunk === undefined) throw new Error('no chunk');
      await w.deps.fs.remove(`v3/${chunk.path}`);
      await w.deps.fs.writeBytes(`v3/${chunk.path}/inner`, new Uint8Array([1]));
      expect(v4Manifest(w, 'a').epochUnixNano).toBe(manifestOf(w, 'v3').epochUnixNano);
      const before = snapshotOf(w);
      const e = await mergeWith(
        { inputs: ['a', 'v3'], out: 'm', config: cfg('site'), replace: true },
        w.deps,
      ).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: 'invalid-report' });
      expect(snapshotOf(w)).toEqual(before);
    });

    test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'a listed file with mode 000 (real file system)',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'merge-copy-'));
        try {
          const w = createTestWriter();
          const real = { ...w, deps: { ...w.deps, fs: createNodeFileSystem() } };
          await v4Report(real, join(dir, 'old'), [spansRequest(2)]);
          await mergeWith(
            { inputs: [join(dir, 'old')], out: join(dir, 'm'), config: cfg('site') },
            real.deps,
          );
          await v4Report(real, join(dir, 'a'), [spansRequest(1, 0, 9)]);
          const text = readFileSync(join(dir, 'a/data/manifest.js'), 'utf8');
          const m = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
          if (!isV4(m)) throw new Error('not v4');
          const f = m.partitions[0]?.files.spans;
          if (f === undefined) throw new Error('no spans file');
          chmodSync(join(dir, 'a', f.path), 0o000);
          const tree = (): string[] => readdirSync(join(dir, 'm'), { recursive: true }).map(String).sort();
          const before = tree();
          const e = await mergeWith(
            { inputs: [join(dir, 'a')], out: join(dir, 'm'), config: cfg('site'), replace: true },
            real.deps,
          ).catch((x: unknown) => x);
          expect(e).toMatchObject({ code: 'invalid-report' });
          expect(tree()).toEqual(before);
          chmodSync(join(dir, 'a', f.path), 0o600);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  });

  test("a v4 input into an existing v4 output without --format names that report's format", async () => {
    const w = createTestWriter();
    await v4Report(w, 'a', [spansRequest(1)]);
    await v4Report(w, 'm', [spansRequest(1, 0, 9)], 'local');
    const e = await mergeReports(w.deps, ['a'], { out: 'm', config: testConfig(), mode: 'open' }).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: 'usage', hint: 'merge with --format local' });
    expect((e as OtelHtmlError).message).toContain('into the local report at m without --format');
  });
});

describe('--compact and patterns (R56)', () => {
  const logs = (...bodies: string[]) =>
    logsRequest(bodies.map((b) => logRecord({ body: { stringValue: b } })));
  const patterns = async (w: TestWriter, out: string) =>
    (await patternRowsOf(w, out)).map((r) => [cell(r, 'cluster_id'), cell(r, 'template'), cell(r, 'count')]);

  async function patternRowsOf(w: TestWriter, out: string): Promise<object[]> {
    const all: object[] = [];
    for (const p of v4Manifest(w, out).partitions) {
      const f = p.files.patterns;
      if (f !== undefined) all.push(...decodeTable('patterns', await bytesOf(w, `${out}/${f.path}`)));
    }
    return all;
  }

  test('lineages that share a cluster id keep both templates through a compacting merge', async () => {
    const w = createTestWriter();
    await v4Report(w, 'x', [logs('disk full on sda', 'disk full on sdb', 'disk full on sdc')]);
    await v4Report(w, 'y', [logs('user 1 logged in', 'user 2 logged in', 'user 3 logged in')]);
    await mergeWith({ inputs: ['x', 'y'], out: 'm1', config: cfg('site') }, w.deps);
    await mergeWith({ inputs: ['m1'], out: 'm2', config: cfg('site', { compactOnMerge: true }) }, w.deps);
    expect(v4Manifest(w, 'm2').partitions).toHaveLength(1);
    const rowsOut = (await patterns(w, 'm2')).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    expect(rowsOut).toEqual([
      [0n, 'disk full on <*>', 3n],
      [0n, 'user <*> logged in', 3n],
    ]);
  });

  test('closing a session sums flush partitions by cluster id, with the generalised template', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'f', config: testConfig(cfg('site')), mode: 'replace' });
    await s.add(otlp(logs('connection from alpha closed by peer')), 'a.json');
    await s.flush();
    await s.add(otlp(logs('connection from beta closed by peer')), 'b.json');
    await s.close();
    expect(v4Manifest(w, 'f').partitions).toHaveLength(1);
    expect(await patterns(w, 'f')).toEqual([[0n, 'connection from <*> closed by peer', 2n]]);
  });

  test('a merge that flushes converted rows and copies lineages compacts each kind by its own key', async () => {
    const w = createTestWriter();
    await v4Report(w, 'x', [logs('disk full on sda', 'disk full on sdb', 'disk full on sdc')]);
    await v4Report(w, 'y', [logs('user 1 logged in', 'user 2 logged in', 'user 3 logged in')]);
    await mergeWith({ inputs: ['x', 'y'], out: 'm1', config: cfg('site') }, w.deps);
    const chunks = await openSession(w.deps, {
      out: 'v3',
      config: testConfig({ writer: { chunkTargetBytes: 1 } }),
      mode: 'replace',
    });
    await chunks.add(otlp(logs('connection from alpha closed by peer')), 'a.json');
    await chunks.add(otlp(logs('connection from beta closed by peer')), 'b.json');
    await chunks.close();
    await mergeWith(
      {
        inputs: ['v3', 'm1'],
        out: 'm2',
        config: cfg('site', { compactOnMerge: true, chunkTargetBytes: 1 }),
      },
      w.deps,
    );
    const sorted = (await patterns(w, 'm2')).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    expect(sorted).toEqual([
      [0n, 'connection from <*> closed by peer', 2n],
      [0n, 'disk full on <*>', 3n],
      [0n, 'user <*> logged in', 3n],
    ]);
  });
});

describe('an empty format-4 input', () => {
  async function emptyReport(w: TestWriter, out: string): Promise<void> {
    const s = await openSession(w.deps, { out, config: testConfig(cfg('site')), mode: 'replace' });
    await s.close();
    expect(v4Manifest(w, out).epochUnixNano).toBe('0');
  }

  test("does not fix the epoch: a chunks input after it merges, and the epoch is that input's", async () => {
    const w = createTestWriter();
    await emptyReport(w, 'e');
    const s = await openSession(w.deps, { out: 'v3', config: testConfig(), mode: 'replace' });
    await s.add(otlp(spansRequest(2)), 'v3.json');
    await s.close();
    await mergeWith({ inputs: ['e', 'v3'], out: 'm', config: cfg('site') }, w.deps);
    const m = v4Manifest(w, 'm');
    expect(m.epochUnixNano).toBe(manifestOf(w, 'v3').epochUnixNano);
    expect(m.totals.spans).toBe(2);
  });

  test("merge E A then an append keeps A's epoch", async () => {
    const w = createTestWriter();
    await emptyReport(w, 'e');
    await v4Report(w, 'a', [spansRequest(2)]);
    await mergeWith({ inputs: ['e', 'a'], out: 'ea', config: cfg('site') }, w.deps);
    expect(v4Manifest(w, 'ea').epochUnixNano).toBe(v4Manifest(w, 'a').epochUnixNano);
    const s = await openSession(w.deps, { out: 'ea', config: testConfig(cfg('site')), mode: 'append' });
    await s.add(otlp(spansRequest(1, 5000, 50)), 'more.json');
    await s.close();
    const m = v4Manifest(w, 'ea');
    expect(m.epochUnixNano).toBe(v4Manifest(w, 'a').epochUnixNano);
    expect(m.totals.spans).toBe(3);
  });
});

describe('refusals point to the lossless path', () => {
  test('appending as another format names upgrade --format', async () => {
    const w = createTestWriter();
    await v4Report(w, 'a', [spansRequest(1)], 'site');
    const e = await openSession(w.deps, { out: 'a', config: testConfig(cfg('local')), mode: 'append' }).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: 'usage' });
    expect((e as OtelHtmlError).hint).toContain('otel-html upgrade a --format local');
    expect((e as OtelHtmlError).hint).not.toContain('--replace');
  });

  test('appending with a shared base to a report with its own assets names upgrade --assets-base', async () => {
    const w = createTestWriter();
    await v4Report(w, 'a', [spansRequest(1)], 'site');
    const e = await openSession(w.deps, {
      out: 'a',
      config: testConfig(cfg('site', { assetsBase: '../../assets/1/' })),
      mode: 'append',
    }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'usage' });
    expect((e as OtelHtmlError).hint).toContain('otel-html upgrade a --assets-base ../../assets/1/');
  });
});
