import { describe, expect, test } from 'vitest';
import { mergeWith } from '../../src/api/convert.js';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import { TABLES, type Table } from '../../src/format/parquet/schema.js';
import { MANIFEST_KEY, partitionWrapperPath } from '../../src/format/paths.js';
import { mergeReports } from '../../src/writer/merge.js';
import { openSession } from '../../src/writer/session.js';
import { logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { spansRequest } from './helpers.js';

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
    expect(ms).toBeLessThan(1000);
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
});
