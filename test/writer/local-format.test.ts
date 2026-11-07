import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ConfigInput } from '../../src/config/schema.js';
import { WRAPPER_SLICE_BYTES } from '../../src/format/data-file.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { engineAssetNames } from '../../src/writer/engine-assets.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { openSession } from '../../src/writer/session.js';
import { writeWrapper } from '../../src/writer/wrapper-file.js';
import { logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { perfFactor } from '../../test-support/perf-inject.js';
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

describe('the wrapper file', () => {
  test('is a script that pushes the key and base64 only, with no < anywhere', async () => {
    const w = createTestWriter();
    const bytes = new Uint8Array(3_000_000).map((_, i) => (i * 31) % 256);
    await writeWrapper(w.fs, 'x.js', 'partitions/000000/spans', bytes);
    const text = w.fs.snapshot().get('x.js') ?? '';
    const m = /^__OH__\.push\("partitions\/000000\/spans","([^"]*)"\);\n$/.exec(text);
    expect(m).not.toBeNull();
    const payload = m?.[1] ?? '';
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(text).not.toContain('<');
    expect(Buffer.from(payload, 'base64').equals(bytes)).toBe(true);
  });
});

describe('streamed wrappers', () => {
  const S = WRAPPER_SLICE_BYTES;
  const reference = (bytes: Uint8Array) =>
    `__OH__.push("partitions/000000/spans","${Buffer.from(bytes).toString('base64')}");\n`;
  const sample = (n: number) => new Uint8Array(n).map((_, i) => (i * 7 + 13) % 256);

  test.each([0, 1, 2, 3, S - 1, S, S + 1, 2 * S + 2])(
    'the file of %i bytes equals the one-string wrapper, across slice boundaries',
    async (size) => {
      const w = createTestWriter();
      const bytes = sample(size);
      await writeWrapper(w.fs, 'x.js', 'partitions/000000/spans', bytes);
      const text = w.fs.snapshot().get('x.js');
      expect(text === reference(bytes)).toBe(true);
    },
  );

  test('writes through writePiecesAtomic in pieces of at most one slice of base64, never as one string', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    try {
      const real = createNodeFileSystem();
      const longest: number[] = [];
      const fs = {
        ...real,
        writeTextAtomic: async (p: string, text: string) => {
          if (p.endsWith('.js')) throw new Error(`a wrapper was written as one string: ${p}`);
          await real.writeTextAtomic(p, text);
        },
        writePiecesAtomic: async (p: string, pieces: Iterable<string>) => {
          const seen = [...pieces];
          longest.push(Math.max(...seen.map((x) => x.length)));
          await real.writePiecesAtomic?.(p, seen);
        },
      };
      await writeWrapper(fs, join(dir, 'x.parquet.js'), 'partitions/000000/spans', sample(2 * S + 2));
      expect(longest).toHaveLength(1);
      expect(longest[0]).toBeLessThanOrEqual((4 * S) / 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses the native toBase64 where the runtime has it', async () => {
    const proto = Uint8Array.prototype as Uint8Array & { toBase64?: () => string };
    let calls = 0;
    proto.toBase64 = function (this: Uint8Array) {
      calls++;
      return Buffer.from(this).toString('base64');
    };
    try {
      const w = createTestWriter();
      const bytes = sample(S + 5);
      await writeWrapper(w.fs, 'x.js', 'partitions/000000/spans', bytes);
      expect(calls).toBe(2);
      expect(w.fs.snapshot().get('x.js') === reference(bytes)).toBe(true);
    } finally {
      delete proto.toBase64;
    }
  });

  test('a 64 MB partition wraps within the time budget on Node @perf', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    try {
      const bytes = sample(64 * 1024 * 1024);
      const started = performance.now();
      await writeWrapper(createNodeFileSystem(), join(dir, 'big.js'), 'partitions/000000/spans', bytes);
      const ms = performance.now() - started;
      // The protobuf encoder took 3.9 s at 60 MB; the slice encoder about 70 ms.
      expect(ms).toBeLessThan(1500 * perfFactor());
      expect(statSync(join(dir, 'big.js')).size).toBe(
        Math.ceil(bytes.length / 3) * 4 + reference(new Uint8Array(0)).length,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
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

describe('local format ordering and bounds', () => {
  const listedBytes = (w: TestWriter): number => {
    const text = w.fs.snapshot().get(`${OUT}/data/manifest.js`) ?? '';
    const json = JSON.parse(text.slice(text.indexOf(',') + 1, text.lastIndexOf(')'))) as {
      partitions: { files: Record<string, { bytes: number }> }[];
    };
    return json.partitions.flatMap((p) => Object.values(p.files)).reduce((sum, f) => sum + f.bytes, 0);
  };

  test('the Parquet file is written before its wrapper', async () => {
    const w = createTestWriter();
    const s = await open(w, { format: 'local' });
    await s.add(spans(2), 'a.json');
    w.fs.failNextWrite('000000/spans.parquet.js');
    await s.flush().catch(() => undefined);
    expect(w.fs.snapshot().has(`${OUT}/data/partitions/000000/spans.parquet`)).toBe(true);
    expect(w.fs.snapshot().has(`${OUT}/data/partitions/000000/spans.parquet.js`)).toBe(false);
  });

  test('a compaction that fails after a wrapper was written removes its folder and keeps the flush partitions', async () => {
    const w = createTestWriter();
    const s = await open(w, { format: 'local' });
    for (let i = 0; i < 2; i++) {
      await s.add(spans(2, 0, i * 2), `${i}.json`);
      await s.add(otlp(logsRequest([logRecord()])), `l${i}.json`);
      await s.flush();
    }
    w.fs.failNextWrite('000002/logs.parquet.js');
    await s.close();
    const dirs = new Set(keys(w, 'data/partitions/').map((k) => /partitions\/(\d{6})\//.exec(k)?.[1] ?? ''));
    expect([...dirs].sort()).toEqual(['000000', '000001']);
    expect(listedFiles(w).every((f) => w.fs.snapshot().has(`${f}.js`))).toBe(true);
  });

  test('the warning counts the compacted bytes, not the flush partitions plus the compacted one', async () => {
    const run = async (localWarnBytes: number) => {
      const w = createTestWriter();
      const s = await open(w, { format: 'local', localWarnBytes });
      let flushBytes = 0;
      for (let i = 0; i < 3; i++) {
        await s.add(spans(3, 0, i * 3), `${i}.json`);
        await s.flush();
        flushBytes = Math.max(flushBytes, listedBytes(w));
      }
      await s.close();
      return { w, flushBytes, compacted: listedBytes(w) };
    };
    const probe = await run(1_000_000_000);
    const threshold = Math.max(probe.flushBytes, probe.compacted);
    expect(probe.flushBytes + probe.compacted).toBeGreaterThan(threshold);
    const quiet = await run(threshold);
    expect(quiet.w.logs.some((l) => l.level === 'warn')).toBe(false);
    const loud = await run(threshold - 1);
    expect(loud.w.logs.filter((l) => l.level === 'warn' && String(l.msg).includes('third'))).toHaveLength(1);
  });
});

describe('engine files in the report assets', () => {
  test('an append removes engine files the format or version no longer wants', async () => {
    const w = createTestWriter();
    const s = await open(w, { format: 'local' });
    await s.add(spans(1), 'a.json');
    await s.close();
    await w.fs.writeBytes(`${OUT}/assets/viewer.old.js`, new Uint8Array(1));
    await w.fs.writeBytes(`${OUT}/assets/duckdb.0.9.0.wasm`, new Uint8Array(1));
    await w.fs.writeBytes(`${OUT}/assets/${engineAssetNames('site')[0]}`, new Uint8Array(1));
    const b = await open(w, { format: 'local' }, 'append');
    await b.add(spans(1, 0, 5), 'b.json');
    await b.close();
    expect(w.fs.snapshot().has(`${OUT}/assets/viewer.old.js`)).toBe(true);
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

describe('appending with another assets base', () => {
  const shared = { format: 'site', assetsBase: '../../assets/1/' } as const;
  test('a report with its own assets/ cannot move to a shared base on append', async () => {
    const w = createTestWriter();
    const s = await open(w, { format: 'site' });
    await s.add(spans(1), 'a.json');
    await s.close();
    const e = await open(w, shared, 'append').then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(OtelHtmlError);
    expect((e as OtelHtmlError).code).toBe('usage');
    expect((e as OtelHtmlError).hint).toContain('--assets-base assets/');
  });

  test('a shared base can go back to assets/, which writes the assets as usual', async () => {
    const w = createTestWriter();
    const s = await open(w, shared);
    await s.add(spans(1), 'a.json');
    await s.close();
    expect(keys(w, 'assets/')).toEqual([]);
    const b = await open(w, { format: 'site' }, 'append');
    await b.add(spans(1, 0, 5), 'b.json');
    await b.close();
    expect(keys(w, 'assets/').length).toBeGreaterThan(0);
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
