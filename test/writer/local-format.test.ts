import { describe, expect, test } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import { wrapBinaryDataFile } from '../../src/format/data-file.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { engineAssetNames } from '../../src/writer/engine-assets.js';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { spansRequest } from './helpers.js';

const OUT = 'r';

function cfg(writer: NonNullable<ConfigInput['writer']>) {
  return testConfig({ writer });
}
const open = (
  w: TestWriter,
  writer: NonNullable<ConfigInput['writer']>,
  mode: 'replace' | 'append' = 'replace',
) => openSession(w.deps, { out: OUT, config: cfg(writer), mode });
const spans = (n: number, offset = 0, first = 0) => otlp(spansRequest(n, offset, first));
const keys = (w: TestWriter, prefix: string) =>
  [...w.fs.snapshot().keys()].filter((k) => k.startsWith(`${OUT}/${prefix}`)).sort();
const listedFiles = (w: TestWriter): string[] => {
  const text = w.fs.snapshot().get(`${OUT}/data/manifest.js`) ?? '';
  return [...text.matchAll(/data\/partitions\/\d+\/\w+\.parquet/g)].map((m) => `${OUT}/${m[0]}`);
};

describe('wrapBinaryDataFile', () => {
  test('is a script that pushes the key and base64 only, with no < anywhere', () => {
    const bytes = new Uint8Array(3_000_000).map((_, i) => (i * 31) % 256);
    const text = wrapBinaryDataFile('partitions/000000/spans', bytes);
    const m = /^__OH__\.push\("partitions\/000000\/spans","([^"]*)"\);\n$/.exec(text);
    expect(m).not.toBeNull();
    const payload = m?.[1] ?? '';
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(text).not.toContain('<');
    expect(Buffer.from(payload, 'base64').equals(bytes)).toBe(true);
  });
});

describe('local format', () => {
  test('every written Parquet file has a wrapper decoding to its bytes; site writes none', async () => {
    for (const format of ['local', 'site'] as const) {
      const w = createTestWriter();
      const s = await open(w, { format });
      await s.add(spans(3), 'a.json');
      await s.flush();
      const wrappers = keys(w, 'data/partitions/').filter((k) => k.endsWith('.parquet.js'));
      if (format === 'site') {
        expect(wrappers).toEqual([]);
      } else {
        expect(wrappers.length).toBeGreaterThan(0);
        for (const wrapper of wrappers) {
          const parquet = wrapper.slice(0, -'.js'.length);
          const m = /^__OH__\.push\("partitions\/000000\/(\w+)","([A-Za-z0-9+/=]+)"\);\n$/.exec(
            w.fs.snapshot().get(wrapper) ?? '',
          );
          expect(m).not.toBeNull();
          expect(parquet.endsWith(`/${m?.[1]}.parquet`)).toBe(true);
          expect(Buffer.from(m?.[2] ?? '', 'base64')).toEqual(Buffer.from(await w.fs.readBytes(parquet)));
        }
      }
      await s.close();
    }
  });

  test('compaction writes wrappers for its final files only, and the listed files all have one', async () => {
    const w = createTestWriter();
    const s = await open(w, { format: 'local' });
    for (let i = 0; i < 3; i++) {
      await s.add(spans(2, 0, i * 2), `${i}.json`);
      await s.flush();
    }
    await s.close();
    const files = listedFiles(w);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.includes('/000003/'))).toBe(true);
    expect(keys(w, 'data/partitions/').filter((k) => k.endsWith('.js'))).toEqual(
      files.map((f) => `${f}.js`).sort(),
    );
    expect(keys(w, 'data/partitions/').some((k) => k.includes('.merge-'))).toBe(false);
  });

  test('compact at close, reopen with append, close again: every listed file keeps its wrapper', async () => {
    const w = createTestWriter();
    const a = await open(w, { format: 'local' });
    for (let i = 0; i < 2; i++) {
      await a.add(spans(2, 0, i * 2), `${i}.json`);
      await a.flush();
    }
    await a.close();
    const b = await open(w, { format: 'local' }, 'append');
    for (let i = 0; i < 2; i++) {
      await b.add(spans(2, 0, 10 + i * 2), `b${i}.json`);
      await b.flush();
    }
    await b.close();
    const files = listedFiles(w);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(w.fs.snapshot().has(`${f}.js`), f).toBe(true);
    expect(keys(w, 'data/partitions/').filter((k) => k.endsWith('.js'))).toEqual(
      files.map((f) => `${f}.js`).sort(),
    );
  });

  test('warns once past localWarnBytes, naming --format site; never for site', async () => {
    for (const format of ['local', 'site'] as const) {
      const w = createTestWriter();
      const s = await open(w, { format, localWarnBytes: 1 });
      await s.add(spans(3), 'a.json');
      await s.flush();
      await s.add(spans(3, 0, 10), 'b.json');
      await s.flush();
      await s.close();
      const warned = w.logs.filter((l) => l.level === 'warn' && String(l.msg).includes('--format site'));
      expect(warned).toHaveLength(format === 'local' ? 1 : 0);
    }
  });

  test('stays quiet below the threshold', async () => {
    const w = createTestWriter();
    const s = await open(w, { format: 'local', localWarnBytes: 100_000_000 });
    await s.add(spans(3), 'a.json');
    await s.close();
    expect(w.logs.some((l) => l.level === 'warn')).toBe(false);
  });
});

describe('engine files in the report assets', () => {
  test('an append removes engine files the format or version no longer wants', async () => {
    const w = createTestWriter();
    const s = await open(w, { format: 'local' });
    await s.add(spans(1), 'a.json');
    await s.close();
    await w.fs.writeBytes(`${OUT}/assets/duckdb.0.9.0.wasm`, new Uint8Array(1));
    await w.fs.writeBytes(`${OUT}/assets/${engineAssetNames('site')[0]}`, new Uint8Array(1));
    const b = await open(w, { format: 'local' }, 'append');
    await b.add(spans(1, 0, 5), 'b.json');
    await b.close();
    expect(keys(w, 'assets/').filter((k) => k.includes('duckdb'))).toEqual(
      engineAssetNames('local')
        .map((n) => `${OUT}/assets/${n}`)
        .sort(),
    );
  });

  test('a shared assets base is never touched', async () => {
    const w = createTestWriter();
    const writer = { format: 'site', assetsBase: '../../assets/1/' } as const;
    const s = await open(w, writer);
    await s.add(spans(1), 'a.json');
    await s.close();
    await w.fs.writeBytes(`${OUT}/assets/duckdb.0.9.0.wasm`, new Uint8Array(1));
    const b = await open(w, writer, 'append');
    await b.add(spans(1, 0, 5), 'b.json');
    await b.close();
    expect(w.fs.snapshot().has(`${OUT}/assets/duckdb.0.9.0.wasm`)).toBe(true);
  });
});

describe('appending in another format', () => {
  test.each([
    ['local', 'site'],
    ['site', 'local'],
  ] as const)('a %s report cannot be appended as %s', async (first, second) => {
    const w = createTestWriter();
    const s = await open(w, { format: first });
    await s.add(spans(1), 'a.json');
    await s.close();
    const e = await open(w, { format: second }, 'append').then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(OtelHtmlError);
    expect((e as OtelHtmlError).code).toBe('usage');
    expect((e as OtelHtmlError).hint).toContain(`--format ${first}`);
  });
});
